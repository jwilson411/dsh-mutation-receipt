/**
 * The plugin: what it registers, what it resolves, and what the tool reports.
 *
 * The context stub exposes only `tools.register` — the minimum `apply` is
 * allowed to assume — so the suite proves the mandatory path works against a
 * registry that offers nothing else. Nothing here reaches the network, and
 * every file it touches is inside a temporary workspace it made itself.
 */
import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import * as plugin from '../src/index.js'
import { exec, stubContext, tempWorkspace } from './helpers.js'

/**
 * Apply the plugin against a fresh workspace and record a small, known history.
 * @param t - The running test, for cleanup.
 * @param config - Extra config merged over the workspace paths.
 * @returns `{ workspace, instance, tool }`.
 */
function applied(t, config = {}) {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  const { ctx, registered } = stubContext()
  const instance = plugin.apply(ctx, {
    workspaceRoot: workspace.root,
    receiptPath: workspace.receiptPath,
    ...config,
  })

  assert.equal(registered.length, 1, 'apply registers exactly one tool')
  return { workspace, instance, tool: registered[0] }
}

test('the plugin declares the metadata the loader reads', () => {
  assert.equal(plugin.name, 'mutation-receipt')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(plugin.PLUGIN_NAME, 'dsh-mutation-receipt')
  assert.equal(plugin.MUTATION_RECEIPT_TOOL_NAME, 'mutation_receipt')
  assert.equal(typeof plugin.apply, 'function')

  // The library is re-exported, because the host records through it.
  for (const name of ['recordMutation', 'hashFile', 'readReceipt', 'summarizeReceipt', 'relativizePath']) {
    assert.equal(typeof plugin[name], 'function', `${name} is not re-exported`)
  }
})

test('registration happens inside apply, so the fiber owns it', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  const { ctx, registered } = stubContext()
  assert.equal(registered.length, 0, 'importing the module registers nothing')

  plugin.apply(ctx, { workspaceRoot: workspace.root, receiptPath: workspace.receiptPath })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'mutation_receipt')
})

test('config beats environment, and environment beats the default', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  const fromConfig = plugin.resolveConfig(
    { workspaceRoot: workspace.root, receiptPath: workspace.receiptPath, sessionId: 'cfg', limit: 5 },
    {
      DSH_MUTATION_RECEIPT_ROOT: '/nowhere',
      DSH_MUTATION_RECEIPT_PATH: '/nowhere/env.jsonl',
      DSH_MUTATION_RECEIPT_SESSION_ID: 'env',
    },
  )
  assert.equal(fromConfig.receiptPath, workspace.receiptPath)
  assert.equal(fromConfig.sessionId, 'cfg')
  assert.equal(fromConfig.limit, 5)

  const fromEnv = plugin.resolveConfig(
    {},
    {
      DSH_MUTATION_RECEIPT_ROOT: workspace.root,
      DSH_MUTATION_RECEIPT_PATH: workspace.receiptPath,
      DSH_MUTATION_RECEIPT_SESSION_ID: 'env',
    },
  )
  assert.equal(fromEnv.workspaceRoot, workspace.root)
  assert.equal(fromEnv.receiptPath, workspace.receiptPath)
  assert.equal(fromEnv.sessionId, 'env')

  const fallback = plugin.resolveConfig({ workspaceRoot: workspace.root }, {})
  assert.equal(fallback.receiptPath, join(process.cwd(), 'mutation-receipt.jsonl'))
  assert.equal(fallback.sessionId, null)
  assert.equal(fallback.limit, 20)
})

test('the tool reports the last N lines and the counts behind them', async (t) => {
  const { workspace, instance, tool } = applied(t, { sessionId: 'sess-1' })

  // Two creates, an update, a delete: a history with a known shape.
  workspace.write('a.txt', 'a\n')
  instance.recordMutation({ op: 'create', path: 'a.txt' })

  workspace.write('b.txt', 'b\n')
  const b = instance.recordMutation({ op: 'create', path: 'b.txt' })

  workspace.write('b.txt', 'bb\n')
  instance.recordMutation({ op: 'update', path: 'b.txt', sha256_before: b.sha256_after })

  const gone = instance.hashFile('a.txt')
  unlinkSync(join(workspace.root, 'a.txt'))
  instance.recordMutation({ op: 'delete', path: 'a.txt', sha256_before: gone.sha256 })

  const all = await tool.execute({}, exec)
  assert.equal(all.plugin, 'dsh-mutation-receipt')
  assert.equal(all.total, 4)
  assert.deepEqual(all.counts, { create: 2, update: 1, delete: 1 })
  assert.equal(all.lines.length, 4)

  // Counts cover the whole receipt; only the window is trimmed.
  const windowed = await tool.execute({ limit: 2 }, exec)
  assert.equal(windowed.total, 4, 'the total is not the window')
  assert.deepEqual(windowed.counts, { create: 2, update: 1, delete: 1 })
  assert.deepEqual(
    windowed.lines.map((line) => [line.op, line.path]),
    [
      ['update', 'b.txt'],
      ['delete', 'a.txt'],
    ],
    'the last two, oldest first',
  )

  // And no line the tool hands back carries content.
  for (const line of all.lines) {
    for (const key of plugin.CONTENT_KEYS) assert.equal(Object.hasOwn(line, key), false)
  }
})

test('the session filter narrows the counts as well as the window', async (t) => {
  const { workspace, instance, tool } = applied(t, { sessionId: 'sess-1' })

  workspace.write('one.txt', '1\n')
  instance.recordMutation({ op: 'create', path: 'one.txt' })
  workspace.write('two.txt', '2\n')
  instance.recordMutation({ op: 'create', path: 'two.txt', sessionId: 'sess-2' })

  const everything = await tool.execute({}, exec)
  assert.equal(everything.total, 2)

  const first = await tool.execute({ session_id: 'sess-1' }, exec)
  assert.equal(first.total, 1)
  assert.deepEqual(first.counts, { create: 1, update: 0, delete: 0 })
  assert.equal(first.lines[0].path, 'one.txt')

  const missing = await tool.execute({ session_id: 'sess-nope' }, exec)
  assert.equal(missing.total, 0)
  assert.deepEqual(missing.lines, [])
})

test('an unwritten receipt reports honestly rather than failing', async (t) => {
  const { tool } = applied(t)

  const report = await tool.execute({}, exec)
  assert.equal(report.total, 0)
  assert.deepEqual(report.counts, { create: 0, update: 0, delete: 0 })
  assert.deepEqual(report.lines, [])
})

test('the tool description states the boundary the name does not', () => {
  const workspace = tempWorkspace()
  const { ctx, registered } = stubContext()
  plugin.apply(ctx, { workspaceRoot: workspace.root, receiptPath: workspace.receiptPath })
  workspace.cleanup()

  const { description } = registered[0]
  assert.match(description, /does NOT return file contents/i)
  assert.match(description, /not a backup/i)
})

test('the bound recorder applies the same path policy as the library', (t) => {
  const { instance } = applied(t)

  assert.throws(
    () => instance.recordMutation({ op: 'create', path: '/etc/hostname' }),
    plugin.MutationPathError,
  )
  assert.throws(
    () => instance.recordMutation({ op: 'create', path: '../escape.txt' }),
    plugin.MutationPathError,
  )
  assert.equal(instance.readReceipt().length, 0)
})

test('the plugin subscribes to no session event, because this RC publishes none', (t) => {
  const workspace = tempWorkspace()
  t.after(() => workspace.cleanup())

  // A context with no `on` at all. If `apply` ever grew a subscription to an
  // invented filesystem event, this would throw rather than quietly recording
  // nothing forever.
  const { ctx } = stubContext()
  assert.equal('on' in ctx, false)
  assert.doesNotThrow(() =>
    plugin.apply(ctx, { workspaceRoot: workspace.root, receiptPath: workspace.receiptPath }),
  )
})
