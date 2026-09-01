/**
 * The receipt itself: path policy, hashing, and an append-only JSONL of
 * filesystem touches.
 *
 * A line names a file and the shape of what happened to it — path, op, sha256
 * before and after, byte length after. It never carries the bytes. That is the
 * whole design constraint: a receipt you can hand to someone who is not allowed
 * to read the files it describes, and that is worth nothing to anyone who
 * steals it. A hash proves a claim about content without disclosing content,
 * and this module will not write a content field even when a caller offers one.
 *
 * Paths are stored relative to a stated workspace root, POSIX-style. An
 * absolute path under the root is relativized; an absolute path outside it, or
 * any path that climbs out through `..` or a symlink, is refused rather than
 * recorded. So a receipt cannot leak the layout of the machine that produced
 * it, and cannot claim a touch the plugin was never scoped to see.
 *
 * @module dsh-mutation-receipt/receipt
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The plugin's own identity, echoed by every report so a caller can cite the source. */
export const PLUGIN_NAME = 'dsh-mutation-receipt'

/** Receipt file used when neither config nor environment names one. */
export const DEFAULT_RECEIPT_FILENAME = 'mutation-receipt.jsonl'

/** How many trailing lines a report returns when the caller does not say. */
export const DEFAULT_LIMIT = 20

/** The three touches a line can describe. Nothing else is a mutation. */
export const OPS = Object.freeze(['create', 'update', 'delete'])

/**
 * Keys a caller might hand over that would put file content — or a rendering of
 * it — into the receipt. They are never copied onto a line.
 *
 * The list is documentation more than machinery: {@link recordMutation} reads
 * only the fields it names, so an unknown key is dropped by construction. It is
 * exported so a test can assert the absence of exactly these names.
 */
export const CONTENT_KEYS = Object.freeze(['contents', 'body', 'data', 'text', 'diff'])

/** A lowercase 64-character hex digest, and nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/

/** Base class, so a host can catch everything this module refuses in one clause. */
export class MutationReceiptError extends Error {
  /**
   * @param message - What was refused, in plain words.
   * @param code - A stable machine-readable code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'MutationReceiptError'
    this.code = code
  }
}

/** A path that is not under the workspace root, or cannot be stored relative to it. */
export class MutationPathError extends MutationReceiptError {
  /** @param message - Why the path was refused. */
  constructor(message) {
    super(message, 'MUTATION_RECEIPT_PATH')
    this.name = 'MutationPathError'
  }
}

/** An `op` that is not one of {@link OPS}. */
export class InvalidMutationOpError extends MutationReceiptError {
  /** @param op - The op as given. */
  constructor(op) {
    super(
      `op must be one of ${OPS.join(', ')}; received ${JSON.stringify(op)}`,
      'MUTATION_RECEIPT_OP',
    )
    this.name = 'InvalidMutationOpError'
  }
}

/** A hash the line requires that the caller did not supply and the disk cannot answer. */
export class MissingHashError extends MutationReceiptError {
  /** @param message - Which hash is missing, and why it could not be derived. */
  constructor(message) {
    super(message, 'MUTATION_RECEIPT_HASH')
    this.name = 'MissingHashError'
  }
}

/**
 * Resolve a workspace root to a real, existing directory.
 * @param workspaceRoot - The configured root.
 * @returns Its absolute, symlink-resolved path.
 * @throws {MutationPathError} If it is not a string naming an existing directory.
 */
export function resolveWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    throw new MutationPathError('workspaceRoot must be a non-empty string')
  }
  const absolute = resolve(workspaceRoot)
  let real
  try {
    real = realpathSync(absolute)
  } catch {
    throw new MutationPathError(`workspaceRoot does not exist: ${absolute}`)
  }
  if (!statSync(real).isDirectory()) {
    throw new MutationPathError(`workspaceRoot is not a directory: ${absolute}`)
  }
  return real
}

/**
 * Resolve a path through whatever part of it exists.
 *
 * `realpathSync` fails on a path whose leaf is gone — which is the normal case
 * for a delete — so the longest existing ancestor is resolved and the missing
 * tail re-joined onto it. That is what makes a symlinked parent directory
 * unable to smuggle a write out of the workspace.
 * @param absolute - An already-absolute path.
 * @returns The same path with every existing segment symlink-resolved.
 */
function realResolve(absolute) {
  const tail = []
  let current = absolute

  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Turn a caller's path into the relative, POSIX-style string a line may store.
 *
 * A relative path is taken as relative to the root. An absolute path under the
 * root is relativized. Anything that lands outside the root — an absolute path
 * elsewhere on the machine, a `..` climb, a symlink pointing away — is refused,
 * because a receipt that named it would be describing a touch this plugin was
 * never scoped to witness.
 * @param workspaceRoot - The workspace root; must exist.
 * @param path - A relative path, or an absolute one under the root.
 * @returns The path relative to the root, `/`-separated, with no leading slash.
 * @throws {MutationPathError} If the path is unusable or escapes the root.
 */
export function relativizePath(workspaceRoot, path) {
  const root = resolveWorkspaceRoot(workspaceRoot)

  if (typeof path !== 'string' || path === '') {
    throw new MutationPathError('path must be a non-empty string')
  }

  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const resolved = realResolve(absolute)

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new MutationPathError(`path escapes the workspace root: ${path}`)
  }
  if (resolved === root) {
    throw new MutationPathError('path is the workspace root itself, not a file within it')
  }

  const stored = relative(root, resolved).split(sep).join('/')

  // Belt and braces. If any of the above ever let an absolute or climbing form
  // through, the receipt would carry a machine path — refuse instead.
  if (stored === '' || stored.startsWith('/') || stored.startsWith('../') || isAbsolute(stored)) {
    throw new MutationPathError(`path does not relativize to the workspace root: ${path}`)
  }

  return stored
}

/**
 * Hash a file's bytes.
 *
 * The bytes are streamed through the digest and discarded; nothing read here is
 * retained, returned, or written.
 * @param path - A relative path, or an absolute one under the root.
 * @param workspaceRoot - The workspace root the path is measured against.
 * @returns `{ sha256, byte_len }` — a lowercase hex digest and the file's size.
 * @throws {MutationPathError} If the path escapes the root.
 */
export function hashFile(path, workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  const stored = relativizePath(root, path)
  const bytes = readFileSync(join(root, stored))

  return { sha256: createHash('sha256').update(bytes).digest('hex'), byte_len: bytes.length }
}

/**
 * Hash a file if it is there, without complaining if it is not.
 * @param root - A resolved workspace root.
 * @param stored - A relative path within it.
 * @returns `{ sha256, byte_len }`, or null if there is no readable file.
 */
function observe(root, stored) {
  try {
    const bytes = readFileSync(join(root, stored))
    return { sha256: createHash('sha256').update(bytes).digest('hex'), byte_len: bytes.length }
  } catch {
    return null
  }
}

/**
 * Accept a caller-supplied digest, or nothing.
 * @param value - A digest, null, or undefined.
 * @param label - The field name, for the error message.
 * @returns The digest lowercased, or null.
 * @throws {MutationReceiptError} If the value is present but is not a sha256 hex digest.
 */
function normalizeHash(value, label) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !SHA256_HEX.test(value.toLowerCase())) {
    throw new MutationReceiptError(
      `${label} must be a 64-character sha256 hex digest`,
      'MUTATION_RECEIPT_HASH_FORMAT',
    )
  }
  return value.toLowerCase()
}

/**
 * Accept a caller-supplied byte length, or nothing.
 * @param value - A length, null, or undefined.
 * @returns The length, or null.
 * @throws {MutationReceiptError} If it is present but not a non-negative integer.
 */
function normalizeByteLen(value) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) {
    throw new MutationReceiptError(
      'byte_len_after must be a non-negative integer',
      'MUTATION_RECEIPT_BYTE_LEN',
    )
  }
  return value
}

/**
 * Accept a caller-supplied instant, or take now.
 * @param value - An ISO-8601 string, null, or undefined.
 * @returns An ISO-8601 UTC timestamp.
 * @throws {MutationReceiptError} If the value is present but unparseable.
 */
function normalizeTimestamp(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const instant = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (Number.isNaN(instant)) {
    throw new MutationReceiptError(
      `ts must be an ISO-8601 timestamp; received ${JSON.stringify(value)}`,
      'MUTATION_RECEIPT_TS',
    )
  }
  return new Date(instant).toISOString()
}

/**
 * Record one filesystem touch.
 *
 * The line is assembled from named fields only, so a caller who hands over a
 * `contents`, `body`, `data`, `text`, or `diff` key gets a correct receipt line
 * with that key silently absent rather than a receipt that has quietly become a
 * copy of their files. See {@link CONTENT_KEYS}.
 *
 * What each op needs, and why:
 *
 * - **create** — `sha256_before` is null; there was no before. The after hash
 *   and byte length are read from the file as it stands now unless the caller
 *   already computed them.
 * - **update** — `sha256_before` must come from the caller. Once the write has
 *   landed the previous bytes are gone, and this module will guess at nothing.
 * - **delete** — `sha256_after` and `byte_len_after` are null; there is no
 *   after. `sha256_before` must come from the caller, unless the file is
 *   somehow still readable, in which case it is hashed here.
 *
 * @param input - `{ workspaceRoot, receiptPath, sessionId, op, path, sha256_before,
 *   sha256_after, byte_len_after, ts }`. Any other key is ignored.
 * @returns The line as written.
 * @throws {InvalidMutationOpError} If `op` is not one of {@link OPS}.
 * @throws {MutationPathError} If `path` escapes the workspace root.
 * @throws {MissingHashError} If a hash the op requires is neither given nor derivable.
 */
export function recordMutation(input) {
  if (input === null || typeof input !== 'object') {
    throw new MutationReceiptError('recordMutation needs an input object', 'MUTATION_RECEIPT_INPUT')
  }

  const op = input.op
  if (!OPS.includes(op)) throw new InvalidMutationOpError(op)

  if (typeof input.receiptPath !== 'string' || input.receiptPath === '') {
    throw new MutationReceiptError(
      'receiptPath must be a non-empty string',
      'MUTATION_RECEIPT_TARGET',
    )
  }

  const root = resolveWorkspaceRoot(input.workspaceRoot)
  const stored = relativizePath(root, input.path)
  const ts = normalizeTimestamp(input.ts)
  const sessionId = input.sessionId === undefined ? null : input.sessionId
  if (sessionId !== null && typeof sessionId !== 'string') {
    throw new MutationReceiptError(
      'sessionId must be a string or null',
      'MUTATION_RECEIPT_SESSION',
    )
  }

  const givenBefore = normalizeHash(input.sha256_before, 'sha256_before')
  const givenAfter = normalizeHash(input.sha256_after, 'sha256_after')
  const givenLen = normalizeByteLen(input.byte_len_after)

  // One read at most, shared by the hash and the length.
  const needsFile =
    (op !== 'delete' && (givenAfter === null || givenLen === null)) ||
    (op === 'delete' && givenBefore === null)
  const observed = needsFile ? observe(root, stored) : null

  let sha256Before = null
  let sha256After = null
  let byteLenAfter = null

  if (op === 'delete') {
    sha256Before = givenBefore ?? observed?.sha256 ?? null
    if (sha256Before === null) {
      throw new MissingHashError(
        `delete of ${stored} needs sha256_before: the file is gone and cannot be hashed now`,
      )
    }
  } else {
    if (op === 'update') {
      if (givenBefore === null) {
        throw new MissingHashError(
          `update of ${stored} needs sha256_before: the previous bytes are already overwritten`,
        )
      }
      sha256Before = givenBefore
    }

    sha256After = givenAfter ?? observed?.sha256 ?? null
    if (sha256After === null) {
      throw new MissingHashError(
        `${op} of ${stored} needs sha256_after: no digest was given and the file cannot be read`,
      )
    }
    byteLenAfter = givenLen ?? observed?.byte_len ?? null
  }

  const line = {
    ts,
    session_id: sessionId,
    op,
    path: stored,
    sha256_before: sha256Before,
    sha256_after: sha256After,
    byte_len_after: byteLenAfter,
  }

  appendReceiptLine(input.receiptPath, line)
  return line
}

/**
 * Append one line to the receipt, creating its directory if it is not there.
 *
 * Append-only, one JSON object per `\n`-terminated line: nothing already
 * written is read back, rewritten, or reordered, which is the only reason an
 * earlier line is worth citing.
 * @param receiptPath - The receipt file.
 * @param line - The line to write.
 * @returns The absolute path written to.
 */
export function appendReceiptLine(receiptPath, line) {
  const target = resolve(receiptPath)
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, `${JSON.stringify(line)}\n`, 'utf8')
  return target
}

/**
 * Read every line of a receipt.
 *
 * A missing receipt reads as empty — a session that touched nothing has an
 * honest receipt, not an error. A line that does not parse is skipped rather
 * than thrown on, so one bad write cannot make the rest uncitable.
 * @param receiptPath - The receipt file.
 * @returns The parsed lines, in file order.
 */
export function readReceipt(receiptPath) {
  let text
  try {
    text = readFileSync(resolve(receiptPath), 'utf8')
  } catch {
    return []
  }

  const lines = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') lines.push(parsed)
    } catch {
      // A torn or hand-edited line. The rest of the receipt still stands.
    }
  }
  return lines
}

/**
 * Report over a receipt: the last N lines, and the counts behind them.
 *
 * The window and the counts answer different questions on purpose. The counts
 * cover every line given — "what did this session touch?" — while the window is
 * the tail, so a long receipt still fits in an answer. Window lines are
 * **oldest-first among the last N**: a tail, then read down.
 * @param lines - Receipt lines, in file order, already filtered if the caller wants.
 * @param options - `limit`, the number of trailing lines to return (default {@link DEFAULT_LIMIT}).
 * @returns `{ plugin, lines, counts, total }`.
 */
export function summarizeReceipt(lines, options = {}) {
  const all = Array.isArray(lines) ? lines : []
  const limit = normalizeLimit(options.limit)
  const window = limit >= all.length ? [...all] : all.slice(all.length - limit)

  const counts = { create: 0, update: 0, delete: 0 }
  for (const line of all) {
    if (Object.hasOwn(counts, line?.op)) counts[line.op] += 1
  }

  return { plugin: PLUGIN_NAME, total: all.length, counts, lines: window }
}

/**
 * @param limit - A caller's limit, of any type.
 * @returns A positive integer limit, falling back to {@link DEFAULT_LIMIT}.
 */
export function normalizeLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT
  return limit
}
