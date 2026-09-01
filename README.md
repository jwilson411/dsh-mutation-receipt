# dsh-mutation-receipt

A DeepSeek Harness function plugin that turns filesystem touches into a
**citable, append-only JSONL receipt**: one line per file, naming the path, what
happened to it, and the sha256 before and after.

It carries **no file contents**. That is the whole design constraint. A hiring
manager, an auditor, or a reviewer can ask what the agent touched and get a
receipt they are allowed to read even when they are not allowed to read the
files it describes — and one that is worth nothing to anyone who steals it.

```json
{"ts":"2026-09-01T05:34:13.000Z","session_id":"sess-1","op":"create","path":"notes/hello.txt","sha256_before":null,"sha256_after":"a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447","byte_len_after":12}
```

---

## What it is not

Read this list before you rely on it for anything.

- **Not a backup.** A digest can prove what a file *was*. It cannot bring it
  back. There is no restore, and there never will be — the receipt does not
  contain the bytes.
- **Not DLP-as-a-service.** It records touches a host reports to it. It does not
  scan, classify, intercept, or block anything, and it cannot tell you whether
  what moved was sensitive.
- **Not a cloud uploader.** No file contents, no receipt, and no path ever
  leaves the machine. The library opens no socket and makes no network call of
  any kind; the receipt is a local file you own and can delete.
- **It does not store file contents.** Not a snippet, not a diff, not a
  "preview". If a caller hands over a `contents`, `body`, `data`, `text`, or
  `diff` field, those keys are dropped rather than recorded.
- **It does not walk your filesystem.** No crawl, no watcher, no traversal of
  your home directory or of any host mount point. It writes a line when a host
  tells it a file changed, and otherwise does nothing at all.
- **Not a complete record.** It knows exactly what the host reports. A write
  that never calls `recordMutation` is a write the receipt has never heard of,
  and the receipt does not pretend otherwise.

---

## Install

```sh
dsh plugin --profile default add github:jwilson411/dsh-mutation-receipt
```

Built against the harness RC pinned at `0.1.1-rc.2`
(`@deepseek-ai/dsh-tools@0.1.1-rc.2`, `@deepseek-ai/cordis@^4.0.1`). Node
`>=22.14.0`.

The installer reads `dsh.bundle.patch` from `package.json` and composes
[`cordis.patch.yml`](./cordis.patch.yml) as one layer of the profile. That file
inserts a single row, `id: mutation-receipt`, with an empty `config`.

---

## Hosts call `recordMutation(...)`

**This RC has no filesystem-mutation event to subscribe to.**
`@deepseek-ai/dsh-tools@0.1.1-rc.2` publishes two session events —
`tool/code-dispatch-start` and `tool/code-dispatch` — and neither one is a file
write. Subscribing to an invented `file/mutation` would produce a plugin that
loads cleanly and silently records nothing, which is worse than no receipt at
all. So the host is the thing that knows a file changed, and the host says so:

```js
import { recordMutation } from 'dsh-mutation-receipt'

// Before the write, if you want an update recorded: the previous bytes are
// gone once you overwrite them, and this package will not guess at them.
const { sha256: before } = hashFile('notes/hello.txt', workspaceRoot)

writeFileSync(join(workspaceRoot, 'notes/hello.txt'), next)

recordMutation({
  workspaceRoot,                      // required; every path is relative to this
  receiptPath,                        // required; append-only JSONL
  sessionId: 'sess-1',                // optional, may be null
  op: 'update',                       // 'create' | 'update' | 'delete'
  path: 'notes/hello.txt',            // relative, or absolute under the root
  sha256_before: before,              // required for update; required for a delete
})
```

`apply` returns the same helpers with this deployment's root, receipt path, and
session id already bound, so a host that has the plugin instance does not have
to restate them:

```js
const receipt = plugin.apply(ctx, { workspaceRoot, receiptPath })
receipt.recordMutation({ op: 'create', path: 'notes/hello.txt' })
```

### What each op needs

| op       | `sha256_before`                        | `sha256_after`                    | `byte_len_after` |
| -------- | -------------------------------------- | --------------------------------- | ---------------- |
| `create` | always `null` — there was no before     | from disk, or supplied            | from disk, or supplied |
| `update` | **required from the caller**            | from disk, or supplied            | from disk, or supplied |
| `delete` | **required**, unless the file is still readable | always `null`             | always `null`    |

A hash the op requires and cannot derive is an error (`MissingHashError`,
code `MUTATION_RECEIPT_HASH`), never a `null` quietly folded into the line. An
`op` outside the three throws `InvalidMutationOpError`.

### Other exports

- `hashFile(path, workspaceRoot)` → `{ sha256, byte_len }`
- `readReceipt(receiptPath)` → every parsed line, in file order
- `summarizeReceipt(lines, { limit })` → `{ plugin, total, counts, lines }`
- `relativizePath(workspaceRoot, path)` → the stored form, or a throw
- `MutationReceiptError`, `MutationPathError`, `InvalidMutationOpError`,
  `MissingHashError`

---

## Path policy

The workspace root is the **scope** of the receipt, not a hint.

- Stored paths are **always relative to the configured `workspaceRoot`**,
  POSIX-style: `/` separators, no leading slash, no drive letter.
- An **absolute path under the root is relativized** and stored in that form.
- An **absolute path outside the root is refused**. So is any path that climbs
  out through `..`, and any path whose existing segments resolve — through a
  symlink — to somewhere outside. The check is a real `realpath` of the longest
  existing ancestor, so a symlinked parent directory cannot smuggle a write out.
- A refused path throws `MutationPathError` (code `MUTATION_RECEIPT_PATH`) and
  **appends no line**.

The consequence worth stating plainly: a receipt never discloses where on the
machine it was produced. No home directory, no mount point, no absolute path of
any kind reaches the file.

---

## Tool: `mutation_receipt`

Registered inside `apply` against the `tools` service. One tool, nothing else.

**Parameters** — both optional:

| name         | type    | meaning                                                     |
| ------------ | ------- | ----------------------------------------------------------- |
| `limit`      | integer | How many trailing lines to return, oldest first. Default 20. |
| `session_id` | string  | Report only lines recorded under this session id.            |

**Returns:**

```json
{
  "plugin": "dsh-mutation-receipt",
  "total": 3,
  "counts": { "create": 1, "update": 1, "delete": 1 },
  "lines": [ /* the last N matching lines */ ]
}
```

`counts` and `total` cover **the whole receipt** after the optional session
filter — not just the returned window. `lines` is the tail: the last N matching
lines, **oldest first** among them, so you read down in the order things
happened.

The tool returns no file contents, and it is not a restore path.

---

## CLI: `mutation-receipt show`

```
mutation-receipt show [--receipt <path>] [--root <workspaceRoot>] [-n <count>] [--json]
```

The same file the tool reads.

| option            | meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `--receipt <path>` | Receipt file. Default `$DSH_MUTATION_RECEIPT_PATH`, else `./mutation-receipt.jsonl`. |
| `--root <path>`   | Workspace root, reported for context.                                       |
| `-n, --limit <n>` | Trailing lines to print, oldest first. Default 20.                          |
| `--json`          | Emit the summary object instead of the table.                               |
| `-h, --help`      | Usage.                                                                      |

Text mode is a short table — `ts`, `op`, `path`, `sha256_after` (`-` on a
delete). No file contents, because there are none to print.

---

## Configuration

Set on the `mutation-receipt` row in a later patch layer. Note that an
id-targeted patch **replaces** the row's whole `config` rather than merging into
it, so an override must restate every key it means to keep.

| key             | default              | meaning                                                       |
| --------------- | -------------------- | ------------------------------------------------------------- |
| `workspaceRoot` | `process.cwd()`      | Every stored path is relative to this; outside it is refused.  |
| `receiptPath`   | `mutation-receipt.jsonl` | The append-only JSONL. Parent directories are created.     |
| `sessionId`     | `null`               | Stamped onto lines this deployment records.                    |
| `limit`         | `20`                 | Default window for `mutation_receipt`.                         |

`DSH_MUTATION_RECEIPT_ROOT`, `DSH_MUTATION_RECEIPT_PATH`, and
`DSH_MUTATION_RECEIPT_SESSION_ID` apply only where the config is silent — the
patch is the deployment's stated intent, so it wins over an ambient variable.

---

## License

MIT. Copyright (c) 2026 jwilson411.
