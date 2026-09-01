/**
 * dsh-mutation-receipt — a DeepSeek Harness function plugin that turns
 * filesystem touches into a citable, append-only receipt.
 *
 * The plugin registers exactly one model-facing tool, `mutation_receipt`,
 * against the `tools` service, and owns nothing else. Registration happens
 * inside `apply` so the Cordis fiber owns the effect: stopping, updating, or
 * reloading the plugin unregisters the tool with no bookkeeping here. Named
 * exports preserve the loader's injection metadata.
 *
 * Lines come from one place: a host calling {@link recordMutation}. There is
 * deliberately no event subscription. `@deepseek-ai/dsh-tools@0.1.1-rc.2`
 * publishes two session events — `tool/code-dispatch-start` and
 * `tool/code-dispatch` — and neither is a filesystem mutation. Subscribing to
 * an invented `file/mutation` would produce a plugin that loads cleanly and
 * silently records nothing, which is worse than no receipt at all. When the
 * harness grows a real mutation event this plugin can listen for it; until
 * then the host is the only thing that knows a file changed.
 *
 * @module dsh-mutation-receipt
 */
import { resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  CONTENT_KEYS,
  DEFAULT_LIMIT,
  DEFAULT_RECEIPT_FILENAME,
  InvalidMutationOpError,
  MissingHashError,
  MutationPathError,
  MutationReceiptError,
  OPS,
  PLUGIN_NAME,
  appendReceiptLine,
  hashFile,
  normalizeLimit,
  readReceipt,
  recordMutation,
  relativizePath,
  resolveWorkspaceRoot,
  summarizeReceipt,
} from './receipt.js'

export {
  recordMutation,
  hashFile,
  readReceipt,
  summarizeReceipt,
  relativizePath,
  resolveWorkspaceRoot,
  appendReceiptLine,
  normalizeLimit,
}
export {
  MutationReceiptError,
  MutationPathError,
  InvalidMutationOpError,
  MissingHashError,
  CONTENT_KEYS,
  DEFAULT_LIMIT,
  DEFAULT_RECEIPT_FILENAME,
  OPS,
  PLUGIN_NAME,
}

/** The one model-facing tool name this plugin owns. */
export const MUTATION_RECEIPT_TOOL_NAME = 'mutation_receipt'

/** Cordis plugin name, used in loader diagnostics and the runtime plugin tree. */
export const name = 'mutation-receipt'

/**
 * `tools` is a hard dependency: with no registry there is nothing to register
 * the receipt reader against, so the plugin waits rather than degrading.
 */
export const inject = ['tools']

/**
 * Resolve the plugin's effective settings.
 *
 * Precedence is patch config, then environment, then default — the patch row is
 * the deployment's stated intent, so it wins over an ambient variable.
 * @param config - The `config` block of the plugin's row in the composed patch.
 * @param env - Environment to read, injectable for tests.
 * @returns `{ workspaceRoot, receiptPath, sessionId, limit }`, both paths absolute.
 */
export function resolveConfig(config = {}, env = process.env) {
  const workspaceRoot = config.workspaceRoot ?? env.DSH_MUTATION_RECEIPT_ROOT ?? process.cwd()
  const receiptPath =
    config.receiptPath ?? env.DSH_MUTATION_RECEIPT_PATH ?? DEFAULT_RECEIPT_FILENAME

  return {
    workspaceRoot: resolveWorkspaceRoot(workspaceRoot),
    receiptPath: resolve(receiptPath),
    sessionId: config.sessionId ?? env.DSH_MUTATION_RECEIPT_SESSION_ID ?? null,
    limit: normalizeLimit(config.limit ?? DEFAULT_LIMIT),
  }
}

/** A nullable value schema branch pair, since the subset expresses null as a union. */
const nullable = (spec, description) => ({ oneOf: [spec, { type: 'null' }], description })

/** Schema for one receipt line as the tool reports it. */
const RECEIPT_LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'One filesystem touch. Never the bytes that were touched.',
  properties: {
    ts: { type: 'string', required: true, description: 'When the touch was recorded, ISO-8601.' },
    session_id: nullable(
      { type: 'string' },
      'The session the touch belongs to, or null if none was configured.',
    ),
    op: {
      type: 'string',
      required: true,
      enum: [...OPS],
      description: 'What happened to the file.',
    },
    path: {
      type: 'string',
      required: true,
      description: 'The file, relative to the workspace root, `/`-separated. Never absolute.',
    },
    sha256_before: nullable(
      { type: 'string' },
      'sha256 of the file before the touch; always null for a create.',
    ),
    sha256_after: nullable(
      { type: 'string' },
      'sha256 of the file after the touch; always null for a delete.',
    ),
    byte_len_after: nullable(
      { type: 'integer' },
      'Size of the file after the touch, in bytes; always null for a delete.',
    ),
  },
}

/**
 * Build the `mutation_receipt` tool definition.
 *
 * Kept as a factory rather than a module-scope constant so nothing is
 * constructed at import time and each `apply` owns its own definition, bound to
 * its own resolved config.
 * @param settings - Resolved settings from {@link resolveConfig}.
 * @returns A registry-ready tool definition.
 */
export function createMutationReceiptTool(settings) {
  return defineTool({
    name: MUTATION_RECEIPT_TOOL_NAME,
    description:
      'Report what files this session has touched, from the append-only JSONL mutation ' +
      'receipt: the last N lines and the counts by op over the whole receipt. Each line names ' +
      'a path relative to the workspace root, whether it was created, updated, or deleted, the ' +
      'sha256 before and after, and the byte length after. Reach for it when asked what an ' +
      'agent changed, or to prove a file was or was not modified. It does NOT return file ' +
      'contents, and it is NOT a backup: a hash can confirm what a file was, but nothing here ' +
      'can restore it.',
    parameters: {
      limit: {
        type: 'integer',
        description: `How many of the most recent lines to return, oldest first. Default ${settings.limit}.`,
      },
      session_id: {
        type: 'string',
        description:
          'Report only lines recorded under this session id. Omit to report every line.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: {
            type: 'string',
            required: true,
            description: 'The plugin that produced this report.',
          },
          total: {
            type: 'integer',
            required: true,
            description: 'Every matching line in the receipt, not just the returned ones.',
          },
          counts: {
            type: 'object',
            required: true,
            additionalProperties: false,
            description: 'Touches by op over all matching lines.',
            properties: {
              create: { type: 'integer', required: true },
              update: { type: 'integer', required: true },
              delete: { type: 'integer', required: true },
            },
          },
          lines: {
            type: 'array',
            required: true,
            items: RECEIPT_LINE_SCHEMA,
            description: 'The last N matching lines, oldest first.',
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.total} touch(es): ${value.counts.create} created, ` +
            `${value.counts.update} updated, ${value.counts.delete} deleted`,
        },
      ],
    },
    execute(args = {}) {
      const all = readReceipt(settings.receiptPath)
      const sessionId = args?.session_id
      const matching =
        sessionId === undefined || sessionId === null
          ? all
          : all.filter((line) => line.session_id === sessionId)

      return summarizeReceipt(matching, { limit: args?.limit ?? settings.limit })
    },
  })
}

/**
 * Register the tool and hand the host its recorder.
 *
 * The returned `recordMutation` is the library function with this deployment's
 * workspace root, receipt path, and session id already bound, so a host that
 * knows a file changed can say only what it knows about the change.
 * @param ctx - The Cordis context, with `tools` injected.
 * @param config - The `config` block of the plugin's row in the composed patch.
 * @returns `{ config, recordMutation, hashFile, readReceipt, summarize }`.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)

  ctx.tools.register(createMutationReceiptTool(settings))

  return {
    config: settings,

    /**
     * Record a touch against this deployment's receipt.
     * @param mutation - `{ op, path, sha256_before, sha256_after, byte_len_after, ts, sessionId }`.
     * @returns The line as written.
     */
    recordMutation(mutation) {
      return recordMutation({
        ...mutation,
        workspaceRoot: settings.workspaceRoot,
        receiptPath: settings.receiptPath,
        sessionId: mutation?.sessionId ?? settings.sessionId,
      })
    },

    /**
     * Hash a file inside this deployment's workspace.
     * @param path - A relative path, or an absolute one under the root.
     * @returns `{ sha256, byte_len }`.
     */
    hashFile(path) {
      return hashFile(path, settings.workspaceRoot)
    },

    /** @returns Every line of this deployment's receipt. */
    readReceipt() {
      return readReceipt(settings.receiptPath)
    },

    /**
     * @param options - `limit`, the number of trailing lines.
     * @returns The same report the tool returns.
     */
    summarize(options = {}) {
      return summarizeReceipt(readReceipt(settings.receiptPath), {
        limit: options.limit ?? settings.limit,
      })
    },
  }
}
