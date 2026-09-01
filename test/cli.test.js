/**
 * The CLI, driven through its exported `main` rather than through a subprocess.
 *
 * `main` takes its argv, environment, and output stream as arguments precisely
 * so the suite can exercise it without spawning anything: the tests stay
 * offline, fast, and free of a second Node startup, and a failure points at a
 * line of this package rather than at an exit code.
 */
import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { main } from '../bin/mutation-receipt.js'
import { recordMutation } from '../src/receipt.js'
import { tempWorkspace } from './helpers.js'

/** A stdout stand-in that keeps what was written. */
function capture() {
  const chunks = []
  return { write: (text) => chunks.push(text), get text() { return chunks.join('') } }
}

/**
 * A workspace with a three-line receipt: one create, one update, one delete.
 * @param t - The running test, for cleanup.
 * @returns The workspace.
 */
function recordedWorkspace(t) {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  const { root, receiptPath } = workspace

  workspace.write('notes/hello.txt', 'hello world\n')
  const created = recordMutation({
    workspaceRoot: root,
    receiptPath,
    sessionId: 'sess-1',
    op: 'create',
    path: 'notes/hello.txt',
  })

  workspace.write('notes/hello.txt', 'hello, receipt\n')
  const updated = recordMutation({
    workspaceRoot: root,
    receiptPath,
    sessionId: 'sess-1',
    op: 'update',
    path: 'notes/hello.txt',
    sha256_before: created.sha256_after,
  })

  unlinkSync(join(root, 'notes/hello.txt'))
  recordMutation({
    workspaceRoot: root,
    receiptPath,
    sessionId: 'sess-1',
    op: 'delete',
    path: 'notes/hello.txt',
    sha256_before: updated.sha256_after,
  })

  return workspace
}

test('show --json emits the summary, counts and all', (t) => {
  const workspace = recordedWorkspace(t)
  const out = capture()

  const code = main(
    ['show', '--receipt', workspace.receiptPath, '--root', workspace.root, '--json'],
    {},
    out,
  )

  assert.equal(code, 0)
  const report = JSON.parse(out.text)
  assert.equal(report.plugin, 'dsh-mutation-receipt')
  assert.equal(report.total, 3)
  assert.deepEqual(report.counts, { create: 1, update: 1, delete: 1 })
  assert.equal(report.receipt_path, workspace.receiptPath)
  assert.equal(report.workspace_root, workspace.root)
  assert.deepEqual(
    report.lines.map((line) => line.op),
    ['create', 'update', 'delete'],
  )
  assert.equal(report.lines[0].path, 'notes/hello.txt')
})

test('-n trims the window without touching the counts', (t) => {
  const workspace = recordedWorkspace(t)
  const out = capture()

  main(['show', '--receipt', workspace.receiptPath, '-n', '1', '--json'], {}, out)
  const report = JSON.parse(out.text)

  assert.equal(report.total, 3)
  assert.deepEqual(report.counts, { create: 1, update: 1, delete: 1 })
  assert.equal(report.lines.length, 1)
  assert.equal(report.lines[0].op, 'delete', 'the window is the tail')
})

test('the text table shows the touch and never the bytes', (t) => {
  const workspace = recordedWorkspace(t)
  const out = capture()

  const code = main(['show', '--receipt', workspace.receiptPath], {}, out)

  assert.equal(code, 0)
  assert.match(out.text, /3 touch\(es\)/)
  assert.match(out.text, /create 1 {2}update 1 {2}delete 1/)
  assert.match(out.text, /ts\s+op\s+path\s+sha256_after/)
  assert.match(out.text, /notes\/hello\.txt/)
  assert.match(out.text, /delete\s+notes\/hello\.txt\s+-$/m, 'a delete has no after-hash to print')
  assert.equal(out.text.includes('hello world'), false, 'the table printed file contents')
})

test('the receipt path comes from the environment when no flag names one', (t) => {
  const workspace = recordedWorkspace(t)
  const out = capture()

  main(['show', '--json'], { DSH_MUTATION_RECEIPT_PATH: workspace.receiptPath }, out)

  assert.equal(JSON.parse(out.text).total, 3)
})

test('an empty or missing receipt shows as empty, not as a failure', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())
  const out = capture()

  const code = main(['show', '--receipt', join(workspace.root, 'nothing.jsonl')], {}, out)

  assert.equal(code, 0)
  assert.match(out.text, /0 touch\(es\)/)
  assert.match(out.text, /\(no lines yet\)/)
})

test('usage is printed for -h and for no arguments, and it states the boundary', () => {
  for (const argv of [[], ['-h'], ['--help']]) {
    const out = capture()
    assert.equal(main(argv, {}, out), 0)
    assert.match(out.text, /mutation-receipt show/)
    assert.match(out.text, /no file contents/i)
    assert.match(out.text, /not a backup/i)
  }
})

test('a bad command or flag exits 2 with a message, not a stack trace', () => {
  for (const argv of [
    ['restore'],
    ['show', '--wat'],
    ['show', '--receipt'],
    ['show', '-n', 'lots'],
    ['show', '-n', '0'],
  ]) {
    const out = capture()
    assert.equal(main(argv, {}, out), 2, `${argv.join(' ')} should exit 2`)
    assert.match(out.text, /^error: /)
  }
})
