/** Windows regression test for the production NSIS extraction macro.
 * Usage: node build/test-installer-copy.mjs <makensis.exe> <plugin-dir> <7za.exe>
 * Optional final arguments: <full .7z payload> <unpacked application directory>.
 * Installs only into a fresh staging directory; no registry or shortcuts.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', 'Run this test on Windows')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [compiler, plugins, sevenzip, fullArchive, fullSource] = process.argv.slice(2).map(p => path.resolve(p))
assert.ok(compiler && plugins && sevenzip, 'Pass makensis.exe, plugin directory, and 7za.exe')
fs.mkdirSync(path.join(root, 'staging'), { recursive: true })
const work = fs.mkdtempSync(path.join(root, 'staging', 'installer-copy-test-'))
const source = path.join(work, 'source')
const destination = path.join(work, 'installed application')
const nested = Array(8).fill('nested dependency directory').join(path.sep)
fs.mkdirSync(path.join(source, nested), { recursive: true })
fs.writeFileSync(path.join(source, nested, '中文-test.txt'), 'long path contents\n')
fs.writeFileSync(path.join(source, 'short.txt'), 'original contents\n')
const archive = path.join(work, 'payload.7z')
execFileSync(sevenzip, ['a', '-bd', archive, '.'], { cwd: source, windowsHide: true, stdio: 'ignore' })
const templates = path.join(root, 'node_modules/app-builder-lib/templates/nsis/include')

function compile(name, payload, target) {
  const exe = path.join(work, `${name}.exe`)
  const script = path.join(work, `${name}.nsi`)
  fs.writeFileSync(script, `Unicode true
SilentInstall silent
RequestExecutionLevel user
SetCompress off
OutFile "${exe}"
!include "LogicLib.nsh"
!addplugindir /x86-unicode "${plugins}"
!define PRODUCT_NAME "Installer copy test"
!include "${templates}\\extractAppPackage.nsh"
!macro customDetail ZH EN
  DetailPrint "\${EN}"
!macroend
!include "${root}\\build\\extract-long-paths.nsh"
Section
  InitPluginsDir
  File /oname=$PLUGINSDIR\\payload.7z "${payload}"
  SetOutPath "${target}"
  !insertmacro extractUsing7za "$PLUGINSDIR\\payload.7z"
SectionEnd
`)
  execFileSync(compiler, ['/V2', script], { windowsHide: true, stdio: 'pipe' })
  return exe
}

function run(exe, expected = 0, timeout = 180_000) {
  const result = spawnSync(exe, ['/S'], { windowsHide: true, timeout })
  assert.ifError(result.error)
  assert.equal(result.status, expected, `${exe} exit status`)
}

async function verifyTree(from, to) {
  let count = 0
  let longPaths = 0
  const entries = fs.readdirSync(from, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  let cursor = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]
      const original = path.join(entry.parentPath, entry.name)
      const installed = path.join(to, path.relative(from, original))
      const contents = await Promise.all([readFile(original), readFile(installed)])
      const digest = data => createHash('sha256').update(data).digest('hex')
      assert.equal(digest(contents[1]), digest(contents[0]), installed)
      count++
      if (installed.length >= 260) longPaths++
      if (count % 5000 === 0) console.log(`Verified ${count}/${entries.length} files`)
    }
  }))
  assert.ok(longPaths > 0, 'Fixture must exercise long paths')
  console.log(`PASS: ${count} file hashes, including ${longPaths} long paths`)
}

const fixed = compile('fixed', archive, destination)
run(fixed)
await verifyTree(source, destination)
console.log('PASS: fresh installation')
fs.writeFileSync(path.join(destination, 'short.txt'), 'old installation contents')
fs.writeFileSync(path.join(destination, 'keep.txt'), 'unrelated file')
run(fixed)
await verifyTree(source, destination)
assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'unrelated file')
console.log('PASS: overwrite installation preserves unrelated files')

const locked = path.join(destination, 'short.txt')
fs.writeFileSync(locked, 'locked file must survive')
const literal = value => `'${value.replaceAll("'", "''")}'`
const lockScript = `$ErrorActionPreference='Stop'; $stream=[IO.File]::Open(${literal(locked)},'Open','ReadWrite','Read'); try { $process=Start-Process -FilePath ${literal(fixed)} -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden; exit $process.ExitCode } finally { $stream.Dispose() }`
const blocked = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(lockScript, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60_000 })
assert.ifError(blocked.error)
assert.equal(blocked.status, 2, `Locked-file copy must fail: ${blocked.stderr}`)
assert.equal(fs.readFileSync(locked, 'utf8'), 'locked file must survive')
console.log('PASS: locked destination returns a nonzero exit code')
run(fixed)
await verifyTree(source, destination)
console.log('PASS: retry after releasing the lock')

if (fullArchive && fullSource) {
  const fullDestination = path.join(work, 'full application')
  const full = compile('full', fullArchive, fullDestination)
  run(full, 0, 600_000)
  await verifyTree(fullSource, fullDestination)
  fs.writeFileSync(path.join(fullDestination, 'resources', 'app.asar'), 'old application')
  run(full, 0, 600_000)
  await verifyTree(fullSource, fullDestination)
  console.log('PASS: full payload fresh and overwrite installations')
}
console.log(`Test files: ${work}`)
