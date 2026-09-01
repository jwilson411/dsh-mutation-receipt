#!/usr/bin/env node
/**
 * `mutation-receipt` — the same receipt the `mutation_receipt` tool reads, from
 * a shell.
 *
 * The CLI is deliberately the thinner half: it parses flags, calls the same
 * library functions the plugin calls, and prints. It imports nothing outside
 * `node:` and this package, so it runs against a checkout with no dependencies
 * installed — useful when the receipt is the thing you need and the harness is
 * the thing that is broken.
 *
 *   mutation-receipt show [--receipt <path>] [--root <workspaceRoot>] [-n <count>] [--json]
 *
 * It prints paths, ops, and digests. It does not print, fetch, or reconstruct
 * file contents, because the receipt does not contain any.
 *
 * @module dsh-mutation-receipt/cli
 */
import { resolve } from 'node:path'
import process from 'node:process'

import {
  DEFAULT_LIMIT,
  DEFAULT_RECEIPT_FILENAME,
  normalizeLimit,
  readReceipt,
  summarizeReceipt,
} from '../src/receipt.js'

const USAGE = `mutation-receipt — a citable, append-only receipt of filesystem touches

Usage:
  mutation-receipt show [--receipt <path>] [--root <workspaceRoot>] [-n <count>] [--json]

Commands:
  show     Print the last N receipt lines and the counts by op.

Options:
  --receipt <path>  Receipt file. Default: $DSH_MUTATION_RECEIPT_PATH, else
                    ./${DEFAULT_RECEIPT_FILENAME}
  --root <path>     Workspace root the stored paths are relative to. Reported
                    for context only; the receipt already stores relative paths.
  -n, --limit <n>   How many trailing lines to print, oldest first. Default ${DEFAULT_LIMIT}.
  --json            Emit the summary object as JSON instead of a table.
  -h, --help        This message.

The receipt holds paths, ops, sha256 digests, and byte lengths.
It carries no file contents, and it is not a backup.
`

/**
 * Entry point.
 * @param argv - Arguments after the node binary and script path.
 * @param env - Environment to read.
 * @param stdout - Where to write output.
 * @returns The process exit code.
 */
export function main(argv, env = process.env, stdout = process.stdout) {
  const write = (text) => stdout.write(`${text}\n`)

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    write(USAGE.trimEnd())
    return 0
  }

  const [command, ...rest] = argv
  let options
  try {
    options = parseOptions(rest)
  } catch (error) {
    write(`error: ${error.message}`)
    return 2
  }

  if (command !== 'show') {
    write(`error: unknown command '${command}'\n\n${USAGE.trimEnd()}`)
    return 2
  }

  const receiptPath = resolve(
    options.receipt ?? env.DSH_MUTATION_RECEIPT_PATH ?? DEFAULT_RECEIPT_FILENAME,
  )
  const workspaceRoot = resolve(options.root ?? env.DSH_MUTATION_RECEIPT_ROOT ?? process.cwd())
  const summary = summarizeReceipt(readReceipt(receiptPath), {
    limit: normalizeLimit(options.limit),
  })
  const report = { receipt_path: receiptPath, workspace_root: workspaceRoot, ...summary }

  write(options.json ? JSON.stringify(report, null, 2) : renderShow(report))
  return 0
}

/**
 * Parse the flags `show` accepts.
 * @param argv - Arguments after the command word.
 * @returns `{ receipt, root, limit, json }`, each undefined if not given.
 * @throws {Error} On an unknown flag or a flag missing its value.
 */
export function parseOptions(argv) {
  const options = { receipt: undefined, root: undefined, limit: undefined, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('-')) throw new Error(`${flag} needs a value`)
      index += 1
      return next
    }

    switch (flag) {
      case '--receipt':
        options.receipt = value()
        break
      case '--root':
        options.root = value()
        break
      case '-n':
      case '--limit': {
        const raw = value()
        const parsed = Number.parseInt(raw, 10)
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`${flag} needs a positive integer, not '${raw}'`)
        }
        options.limit = parsed
        break
      }
      case '--json':
        options.json = true
        break
      default:
        throw new Error(`unknown option '${flag}'`)
    }
  }

  return options
}

/**
 * Render the report as a short table.
 * @param report - The summary, plus the paths it was read from.
 * @returns The text to print.
 */
export function renderShow(report) {
  const header =
    `${report.total} touch(es) in ${report.receipt_path}\n` +
    `  create ${report.counts.create}  update ${report.counts.update}  delete ${report.counts.delete}`

  if (report.lines.length === 0) return `${header}\n\n(no lines yet)`

  const rows = [
    [pad(24, 'ts'), pad(6, 'op'), pad(40, 'path'), 'sha256_after'].join('  '),
    ...report.lines.map((line) =>
      [
        pad(24, line.ts ?? '-'),
        pad(6, line.op ?? '-'),
        pad(40, line.path ?? '-'),
        line.sha256_after ?? '-',
      ].join('  '),
    ),
  ]

  return `${header}\n\n${rows.join('\n')}`
}

/**
 * @param width - The column width.
 * @param text - A column value.
 * @returns The value padded to the column width.
 */
function pad(width, text) {
  return String(text).padEnd(width)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2))
}
