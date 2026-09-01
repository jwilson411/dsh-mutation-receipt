/**
 * Shared fixtures. Everything here is offline, synchronous, and confined to a
 * fresh temporary directory.
 *
 * The workspace is never the repository tree and never a real home or mount
 * point: these tests create, rewrite, and unlink actual files, and the only
 * safe place to do that is somewhere the suite made and can throw away.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A throwaway workspace with a receipt path inside it.
 *
 * The caller registers `cleanup` with `t.after`, so a failing assertion still
 * leaves no directory behind.
 * @returns `{ root, receiptPath, write, cleanup }`.
 */
export function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mutation-receipt-'))
  const receiptPath = join(root, 'receipts', 'mutation-receipt.jsonl')

  return {
    root,
    receiptPath,

    /**
     * Write a file inside the workspace, making its directory first.
     * @param relativePath - Where, relative to the root.
     * @param contents - What to write.
     * @returns The absolute path written.
     */
    write(relativePath, contents) {
      const target = join(root, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents, 'utf8')
      return target
    },

    /** Remove the workspace and everything in it. */
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * A context stub exposing only what `apply` is required to work against.
 * @returns The stub context and the definitions it recorded.
 */
export function stubContext() {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

/** The execution context the registry passes to `execute`; this tool ignores it. */
export const exec = { signal: new AbortController().signal }
