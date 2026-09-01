/**
 * The receipt, driven against real files.
 *
 * Every test here creates, rewrites, or unlinks an actual file in a temporary
 * workspace, because the claims worth proving are claims about disk: that the
 * digest on a line is the digest of the bytes that were there, that a path
 * outside the workspace never becomes a line, and that content a caller offers
 * never reaches the file.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'

import {
  InvalidMutationOpError,
  MissingHashError,
  MutationPathError,
  hashFile,
  readReceipt,
  recordMutation,
  relativizePath,
  summarizeReceipt,
} from '../src/receipt.js'
import { tempWorkspace } from './helpers.js'

/**
 * @param text - Bytes as a UTF-8 string.
 * @returns Their sha256, lowercase hex — computed here rather than by the module under test.
 */
function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

test('a create, an update, and a delete of one real file', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  const { root, receiptPath } = workspace

  // Create.
  workspace.write('notes/hello.txt', 'hello world\n')
  const created = recordMutation({
    workspaceRoot: root,
    receiptPath,
    sessionId: 'sess-1',
    op: 'create',
    path: 'notes/hello.txt',
  })

  assert.equal(created.op, 'create')
  assert.equal(created.path, 'notes/hello.txt')
  assert.equal(created.sha256_before, null, 'a create has no before')
  assert.equal(created.sha256_after, sha256('hello world\n'))
  assert.equal(created.byte_len_after, 12)
  assert.equal(created.session_id, 'sess-1')
  assert.match(created.ts, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)

  // Update. The host has to carry the before-hash across the write, because
  // by the time the receipt hears about it the old bytes are gone.
  workspace.write('notes/hello.txt', 'hello, receipt\n')
  const updated = recordMutation({
    workspaceRoot: root,
    receiptPath,
    sessionId: 'sess-1',
    op: 'update',
    path: 'notes/hello.txt',
    sha256_before: created.sha256_after,
  })

  assert.equal(updated.sha256_before, sha256('hello world\n'))
  assert.equal(updated.sha256_after, sha256('hello, receipt\n'))
  assert.equal(updated.byte_len_after, 15)
  assert.notEqual(updated.sha256_before, updated.sha256_after)

  // Delete.
  unlinkSync(join(root, 'notes/hello.txt'))
  const deleted = recordMutation({
    workspaceRoot: root,
    receiptPath,
    sessionId: 'sess-1',
    op: 'delete',
    path: 'notes/hello.txt',
    sha256_before: updated.sha256_after,
  })

  assert.equal(deleted.sha256_before, sha256('hello, receipt\n'))
  assert.equal(deleted.sha256_after, null, 'a delete has no after')
  assert.equal(deleted.byte_len_after, null, 'a delete has no size')

  // Three lines, in order, each with exactly the pinned shape.
  const lines = readReceipt(receiptPath)
  assert.equal(lines.length, 3)
  assert.deepEqual(
    lines.map((line) => line.op),
    ['create', 'update', 'delete'],
  )
  for (const line of lines) {
    assert.deepEqual(Object.keys(line), [
      'ts',
      'session_id',
      'op',
      'path',
      'sha256_before',
      'sha256_after',
      'byte_len_after',
    ])
  }

  const raw = readFileSync(receiptPath, 'utf8')
  assert.equal(raw.endsWith('\n'), true, 'every line is newline-terminated')
  assert.equal(raw.split('\n').filter((line) => line !== '').length, 3)
})

test('an absolute path under the root is stored relative and POSIX-style', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  const absolute = workspace.write('src/deep/nested/file.js', 'export default 1\n')
  assert.equal(isAbsolute(absolute), true, 'the fixture handed over an absolute path')

  const line = recordMutation({
    workspaceRoot: workspace.root,
    receiptPath: workspace.receiptPath,
    op: 'create',
    path: absolute,
  })

  assert.equal(line.path, 'src/deep/nested/file.js')
  assert.equal(isAbsolute(line.path), false)
  assert.equal(line.path.startsWith('/'), false)
  assert.equal(line.path.includes('\\'), false, 'separators are POSIX')
  assert.equal(line.path.includes(workspace.root), false, 'the root is not in the line')

  // The receipt is a document someone else may read. It must not disclose
  // where on the machine this ran.
  const raw = readFileSync(workspace.receiptPath, 'utf8')
  assert.equal(/"path":"\//.test(raw), false, 'no stored path is absolute')
  assert.equal(raw.includes('/home'), false)
  assert.equal(raw.includes('/mnt/'), false)
})

test('a path that escapes the root is refused, and nothing is written', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  const { root, receiptPath } = workspace

  workspace.write('inside.txt', 'kept\n')
  recordMutation({ workspaceRoot: root, receiptPath, op: 'create', path: 'inside.txt' })
  const before = readFileSync(receiptPath, 'utf8')

  const escapes = [
    '../outside.txt',
    'notes/../../outside.txt',
    '/etc/hostname',
    join(root, '..', 'sibling.txt'),
  ]

  for (const path of escapes) {
    assert.throws(
      () =>
        recordMutation({
          workspaceRoot: root,
          receiptPath,
          op: 'create',
          path,
          sha256_after: sha256('whatever'),
          byte_len_after: 8,
        }),
      MutationPathError,
      `${path} should not be recordable`,
    )
    assert.throws(() => relativizePath(root, path), MutationPathError)
  }

  assert.equal(readFileSync(receiptPath, 'utf8'), before, 'a refused path appends no line')
  assert.equal(readReceipt(receiptPath).length, 1)
})

test('a symlinked parent cannot smuggle a write out of the workspace', (t) => {
  const workspace = tempWorkspace()
  const outside = tempWorkspace()
  t.after(() => {
    workspace.cleanup()
    outside.cleanup()
  })

  outside.write('secretish.txt', 'not ours\n')
  symlinkSync(outside.root, join(workspace.root, 'link'))

  assert.throws(
    () => relativizePath(workspace.root, 'link/secretish.txt'),
    MutationPathError,
    'a path resolving outside the root is outside the root',
  )
  assert.throws(
    () =>
      recordMutation({
        workspaceRoot: workspace.root,
        receiptPath: workspace.receiptPath,
        op: 'create',
        path: 'link/secretish.txt',
      }),
    MutationPathError,
  )
})

test('content a caller offers is never copied onto a line', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  workspace.write('config.env', 'TOKEN=SECRET-VALUE\n')
  const line = recordMutation({
    workspaceRoot: workspace.root,
    receiptPath: workspace.receiptPath,
    op: 'create',
    path: 'config.env',
    contents: 'TOKEN=SECRET-VALUE',
    body: 'SECRET',
    data: { password: 'SECRET' },
    text: 'SECRET',
    diff: '+TOKEN=SECRET-VALUE',
  })

  for (const key of ['contents', 'body', 'data', 'text', 'diff']) {
    assert.equal(Object.hasOwn(line, key), false, `the line carries ${key}`)
  }

  // The digest still describes the file, so the line is worth as much as ever.
  assert.equal(line.sha256_after, sha256('TOKEN=SECRET-VALUE\n'))
  assert.equal(line.byte_len_after, 19)

  const raw = readFileSync(workspace.receiptPath, 'utf8')
  assert.equal(raw.includes('SECRET'), false, 'the receipt file contains the offered content')
  assert.equal(raw.includes('TOKEN='), false)
})

test('an op the receipt does not model is refused by name', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  workspace.write('a.txt', 'a\n')

  for (const op of ['rename', 'touch', 'CREATE', '', null, undefined]) {
    assert.throws(
      () =>
        recordMutation({
          workspaceRoot: workspace.root,
          receiptPath: workspace.receiptPath,
          op,
          path: 'a.txt',
        }),
      (error) => error instanceof InvalidMutationOpError && error.code === 'MUTATION_RECEIPT_OP',
    )
  }

  assert.equal(readReceipt(workspace.receiptPath).length, 0)
})

test('a hash the op requires and cannot derive is refused, not invented', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  const { root, receiptPath } = workspace

  workspace.write('present.txt', 'here\n')

  const isMissingHash = (error) =>
    error instanceof MissingHashError && error.code === 'MUTATION_RECEIPT_HASH'

  // update, with the previous bytes already overwritten and no before-hash.
  assert.throws(
    () => recordMutation({ workspaceRoot: root, receiptPath, op: 'update', path: 'present.txt' }),
    isMissingHash,
  )

  // delete, with the file gone and no before-hash.
  assert.throws(
    () => recordMutation({ workspaceRoot: root, receiptPath, op: 'delete', path: 'gone.txt' }),
    isMissingHash,
  )

  // create, with nothing on disk and no after-hash.
  assert.throws(
    () => recordMutation({ workspaceRoot: root, receiptPath, op: 'create', path: 'ghost.txt' }),
    MissingHashError,
  )

  assert.equal(readReceipt(receiptPath).length, 0, 'no line survives a refusal')
})

test('a host that already hashed the bytes is believed, and a delete before a delete is read', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  const { root, receiptPath } = workspace

  // A create the host hashed itself, for a file that is already gone again.
  const line = recordMutation({
    workspaceRoot: root,
    receiptPath,
    op: 'create',
    path: 'ephemeral.txt',
    sha256_after: sha256('gone by now\n'),
    byte_len_after: 12,
  })
  assert.equal(line.sha256_after, sha256('gone by now\n'))
  assert.equal(line.byte_len_after, 12)

  // A delete recorded while the file is still readable hashes it rather than
  // demanding the caller do it.
  workspace.write('doomed.txt', 'about to go\n')
  const deleted = recordMutation({
    workspaceRoot: root,
    receiptPath,
    op: 'delete',
    path: 'doomed.txt',
  })
  assert.equal(deleted.sha256_before, sha256('about to go\n'))
  assert.equal(deleted.sha256_after, null)
  assert.equal(deleted.byte_len_after, null)
})

test('hashFile measures the bytes, and applies the same path policy', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  const absolute = workspace.write('bin/blob.dat', 'x'.repeat(4096))
  assert.deepEqual(hashFile('bin/blob.dat', workspace.root), {
    sha256: sha256('x'.repeat(4096)),
    byte_len: 4096,
  })
  assert.deepEqual(hashFile(absolute, workspace.root), hashFile('bin/blob.dat', workspace.root))
  assert.throws(() => hashFile('../elsewhere.txt', workspace.root), MutationPathError)
})

test('a supplied timestamp is normalised to UTC, and a bad one is refused', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  workspace.write('t.txt', 't\n')

  const line = recordMutation({
    workspaceRoot: workspace.root,
    receiptPath: workspace.receiptPath,
    op: 'create',
    path: 't.txt',
    ts: '2026-09-01T05:34:13.000Z',
  })
  assert.equal(line.ts, '2026-09-01T05:34:13.000Z')

  assert.throws(
    () =>
      recordMutation({
        workspaceRoot: workspace.root,
        receiptPath: workspace.receiptPath,
        op: 'create',
        path: 't.txt',
        ts: 'last Tuesday',
      }),
    /ISO-8601/,
  )
})

test('the receipt is append-only: earlier lines are never rewritten', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  const { root, receiptPath } = workspace

  workspace.write('a.txt', 'a\n')
  const first = recordMutation({ workspaceRoot: root, receiptPath, op: 'create', path: 'a.txt' })
  const afterFirst = readFileSync(receiptPath, 'utf8')

  workspace.write('b.txt', 'b\n')
  recordMutation({ workspaceRoot: root, receiptPath, op: 'create', path: 'b.txt' })
  const afterSecond = readFileSync(receiptPath, 'utf8')

  assert.equal(afterSecond.startsWith(afterFirst), true, 'the first line was disturbed')
  assert.deepEqual(readReceipt(receiptPath)[0], first)
})

test('a missing receipt reads as empty, and a torn line does not sink the rest', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  assert.deepEqual(readReceipt(join(workspace.root, 'never-written.jsonl')), [])

  const path = join(workspace.root, 'partly-bad.jsonl')
  writeFileSync(path, '{"op":"create","path":"a.txt"}\n{not json\n{"op":"delete","path":"b.txt"}\n')
  assert.deepEqual(
    readReceipt(path).map((line) => line.op),
    ['create', 'delete'],
  )
})

test('summarizeReceipt counts everything and returns the tail, oldest first', () => {
  const lines = [
    { op: 'create', path: 'a' },
    { op: 'update', path: 'b' },
    { op: 'update', path: 'c' },
    { op: 'delete', path: 'd' },
    { op: 'create', path: 'e' },
  ]

  const summary = summarizeReceipt(lines, { limit: 2 })

  assert.equal(summary.plugin, 'dsh-mutation-receipt')
  assert.equal(summary.total, 5, 'the total covers the whole receipt, not the window')
  assert.deepEqual(summary.counts, { create: 2, update: 2, delete: 1 })
  assert.deepEqual(
    summary.lines.map((line) => line.path),
    ['d', 'e'],
    'the last two, in the order they happened',
  )

  // A limit past the end returns everything; an unusable limit falls back.
  assert.equal(summarizeReceipt(lines, { limit: 99 }).lines.length, 5)
  assert.equal(summarizeReceipt(lines, { limit: 0 }).lines.length, 5)
  assert.deepEqual(summarizeReceipt([]).counts, { create: 0, update: 0, delete: 0 })
})

test('a workspace root that is not an existing directory is refused', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  for (const root of [join(workspace.root, 'nope'), '', null, 42]) {
    assert.throws(() => relativizePath(root, 'a.txt'), MutationPathError)
  }
  workspace.write('file.txt', 'f\n')
  assert.throws(() => relativizePath(join(workspace.root, 'file.txt'), 'a.txt'), MutationPathError)
})
