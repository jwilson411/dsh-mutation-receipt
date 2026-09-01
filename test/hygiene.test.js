/**
 * Repository hygiene, asserted rather than promised.
 *
 * A package whose whole pitch is "this receipt is safe to hand to someone" has
 * to be able to show that the tree itself carries nothing it should not. Five
 * claims are checked here. That no machine name, mount path, or credential
 * variable from wherever this was written survived into the tree. That the
 * shipped library opens no socket and starts no subprocess — it hashes files
 * and appends a line, and `node:fs` and `node:crypto` are the only reasons it
 * touches the outside world at all. That the manifest points the profile
 * installer at a patch file that exists and will actually be published. That CI
 * needs no credentials. And that the README states the boundary of the product
 * in plain words, since "records what the agent touched" is exactly the
 * overstatement a reader would otherwise make on this package's behalf.
 *
 * The forbidden literals are assembled from fragments so that this file does
 * not itself trip the scan it performs.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The package root, walked below. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directories never worth scanning: not ours, or not text. */
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** Extensions with no text worth scanning. */
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2'])

/**
 * Every checked-in text file, repo-relative.
 * @returns Paths relative to the package root, in directory order.
 */
function repoFiles() {
  return readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath ?? entry.path, entry.name)))
    .filter((path) => !path.split(sep).some((segment) => SKIP_DIRS.has(segment)))
    .filter((path) => !BINARY_EXTENSIONS.has(extname(path)))
}

/**
 * Read a repo file as text.
 * @param path - A repo-relative path.
 * @returns Its contents.
 */
function readRepoFile(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

/**
 * The literals that must not appear anywhere in the tree, each built from
 * fragments so this file is not its own counterexample.
 */
const FORBIDDEN = [
  { what: 'a private machine name', pattern: new RegExp(['def', 'iant'].join(''), 'i') },
  { what: 'a host-local mount path', pattern: /\/mnt\/[a-z]/i },
  { what: 'a CI token variable', pattern: new RegExp(['GITHUB', 'TOKEN'].join('_')) },
  { what: 'a provider key variable', pattern: new RegExp(['ANTHROPIC', 'API', 'KEY'].join('_')) },
  { what: 'a provider key variable', pattern: new RegExp(['OPENAI', 'API', 'KEY'].join('_')) },
  { what: 'a bearer token literal', pattern: new RegExp(`\\b${['Bea', 'rer'].join('')} [A-Za-z0-9._-]{20,}`) },
]

test('the tree carries no machine names, mount paths, or credential variables', () => {
  const offences = []

  for (const path of repoFiles()) {
    const text = readRepoFile(path)
    for (const { what, pattern } of FORBIDDEN) {
      const hit = pattern.exec(text)
      if (hit !== null) offences.push(`${path}: ${what} (${hit[0].slice(0, 24)})`)
    }
  }

  assert.deepEqual(offences, [])
})

test('the scan actually covers the files it claims to', () => {
  const files = repoFiles()

  for (const expected of [
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    '.gitignore',
    join('.github', 'workflows', 'ci.yml'),
    join('bin', 'mutation-receipt.js'),
    join('src', 'index.js'),
    join('src', 'receipt.js'),
    join('test', 'helpers.js'),
    join('test', 'cli.test.js'),
    join('test', 'plugin.test.js'),
    join('test', 'receipt.test.js'),
  ]) {
    assert.ok(files.includes(expected), `hygiene scan missed ${expected}`)
  }
  assert.equal(
    files.some((path) => path.startsWith('node_modules')),
    false,
  )
})

test('the shipped library opens no socket and starts no subprocess', () => {
  // This package hashes files and appends a line. `node:fs` and `node:crypto`
  // are expected and are the point; everything below is an egress path or a
  // way to run something else, and a receipt plugin needs neither.
  const banned = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bnode:(dns|net|tls|http|https|dgram|child_process|worker_threads|cluster)\b/,
    /\bspawn(Sync)?\s*\(/,
    /\bexec(Sync|File)?\s*\(/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
  ]

  for (const path of repoFiles().filter((file) => file.startsWith(`src${sep}`))) {
    const text = readRepoFile(path)
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})

test('the CLI opens nothing either, beyond the process it is already in', () => {
  // The CLI may read `process`; it still may not reach the network or spawn.
  const banned = [
    /\bfetch\s*\(/,
    /\bnode:(dns|net|tls|http|https|dgram|child_process|worker_threads|cluster)\b/,
    /\bspawn(Sync)?\s*\(/,
    /\bexec(Sync|File)?\s*\(/,
  ]

  const text = readRepoFile(join('bin', 'mutation-receipt.js'))
  for (const pattern of banned) {
    assert.equal(pattern.test(text), false, `the CLI matches ${pattern}`)
  }
  assert.match(text, /^#!\/usr\/bin\/env node\n/, 'the CLI has no shebang')
})

test('the shipped source imports only node builtins and the pinned tools package', () => {
  const allowed = new Set(['node:crypto', 'node:fs', 'node:path', '@deepseek-ai/dsh-tools'])
  const specifiers = []

  for (const path of repoFiles().filter((file) => file.startsWith(`src${sep}`))) {
    const text = readRepoFile(path)
    for (const match of text.matchAll(/^\s*(?:import|export)[^'"\n]*from\s*'([^']+)'/gm)) {
      specifiers.push(match[1])
    }
  }

  assert.ok(specifiers.length > 0)
  for (const specifier of specifiers) {
    assert.ok(allowed.has(specifier) || specifier.startsWith('./'), `unexpected import ${specifier}`)
  }
})

test('the library writes nowhere but the receipt it was given', () => {
  // One append, one mkdir, in one place. If a second write site ever appears
  // the receipt is no longer the only thing this package produces.
  const receipt = readRepoFile(join('src', 'receipt.js'))

  assert.equal([...receipt.matchAll(/\bappendFileSync\s*\(/g)].length, 1)
  assert.equal([...receipt.matchAll(/\bmkdirSync\s*\(/g)].length, 1)
  assert.equal(/\bwriteFileSync\b|\bcreateWriteStream\b|\brmSync\b|\bunlinkSync\b/.test(receipt), false)
  assert.equal(/\bwriteFileSync\b/.test(readRepoFile(join('src', 'index.js'))), false)
})

test('the manifest points the installer at a patch file that is in the published files', () => {
  const manifest = JSON.parse(readRepoFile('package.json'))
  const patch = manifest.dsh.bundle.patch

  assert.equal(patch, './cordis.patch.yml')
  assert.ok(repoFiles().includes(patch.replace('./', '')), 'dsh.bundle.patch names no real file')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch would not be published')

  // And the patch actually inserts the row the README documents.
  const yaml = readRepoFile('cordis.patch.yml')
  assert.match(yaml, /^- insert:$/m)
  assert.match(yaml, /^ {4}- id: mutation-receipt$/m)
  assert.match(yaml, /^ {6}name: dsh-mutation-receipt$/m)
  assert.match(yaml, /workspaceRoot/)
  assert.match(yaml, /receiptPath/)
  assert.match(yaml, /REPLACES the row's whole `config` rather than merging/)
})

test('the manifest declares what the installer and the registry read', () => {
  const manifest = JSON.parse(readRepoFile('package.json'))

  assert.equal(manifest.name, 'dsh-mutation-receipt')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'src/index.js')
  assert.equal(manifest.engines.node, '>=22.14.0')
  assert.equal(manifest.scripts.test, 'node --test "test/**/*.test.js"')
  assert.equal(manifest.bin['mutation-receipt'], './bin/mutation-receipt.js')
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '^4.0.1')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '^0.1.1-rc.2')
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'], '0.1.1-rc.2')

  for (const keyword of ['dsh-plugin', 'deepseek-harness']) {
    assert.ok(manifest.keywords.includes(keyword), `keywords omit ${keyword}`)
  }
  for (const entry of ['.', './receipt', './cordis.patch.yml', './package.json']) {
    assert.ok(Object.hasOwn(manifest.exports, entry), `exports omit ${entry}`)
  }
  for (const entry of ['bin', 'src', 'cordis.patch.yml', 'LICENSE', 'README.md']) {
    assert.ok(manifest.files.includes(entry), `files omit ${entry}`)
  }

  const home = 'https://github.com/jwilson411/dsh-mutation-receipt'
  assert.equal(manifest.homepage, `${home}#readme`)
  assert.equal(manifest.bugs.url, `${home}/issues`)
  assert.equal(manifest.repository.url, `git+${home}.git`)
})

test('CI needs no credentials', () => {
  const workflow = readRepoFile(join('.github', 'workflows', 'ci.yml'))

  assert.match(workflow, /contents: read/)
  assert.match(workflow, /npm ci/)
  assert.match(workflow, /npm test/)
  assert.match(workflow, /'22\.x', '24\.x'/)
  assert.equal(/secrets\./.test(workflow), false)
})

test('the .gitignore keeps the usual noise out of the tree', () => {
  const ignored = readRepoFile('.gitignore')

  for (const entry of ['node_modules/', '*.tgz', '.env', '.DS_Store']) {
    assert.ok(ignored.includes(entry), `.gitignore omits ${entry}`)
  }
})

test('the LICENSE is MIT, in the right name', () => {
  const license = readRepoFile('LICENSE')

  assert.match(license, /^MIT License/)
  assert.match(license, /Copyright \(c\) 2026 jwilson411/)
})

test('the README states the boundary of the product, not just its behaviour', () => {
  const readme = readRepoFile('README.md')

  // The load-bearing disclaimers. A reader who takes this for a backup will
  // expect to get a file back, and there is nothing here to give them.
  assert.match(readme, /not a backup/i)
  assert.match(readme, /not DLP-as-a-service/i)
  assert.match(readme, /not a cloud uploader/i)
  assert.match(readme, /does not store file contents/i)
  assert.match(readme, /no file contents/i)

  // And the things a reader has to be able to find.
  assert.match(readme, /dsh plugin --profile default add github:jwilson411\/dsh-mutation-receipt/)
  assert.match(readme, /0\.1\.1-rc\.2/)
  assert.match(readme, /recordMutation/)
  assert.match(readme, /no filesystem-mutation event/i)
  assert.match(readme, /mutation_receipt/)
  assert.match(readme, /mutation-receipt show/)
  assert.match(readme, /relative/i)
  assert.match(readme, /refused/i)
  assert.match(readme, /\bMIT\b/)
})
