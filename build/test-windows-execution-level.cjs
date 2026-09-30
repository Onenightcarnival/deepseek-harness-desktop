'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { NtExecutable, NtExecutableResource } = require('resedit')
const { editWindowsResources } = require('app-builder-lib/out/util/resEdit')
const config = require('../package.json')

/** Verify the builder's resource edit against the local Electron executable. */
async function main() {
  assert.equal(config.build.win.requestedExecutionLevel, 'requireAdministrator')
  const source = process.env.DSHDESKTOP_TEST_ELECTRON || require('electron')
  const output = path.resolve(__dirname, '../staging/windows-execution-test')
  await fs.mkdir(output, { recursive: true })
  const file = path.join(output, 'manifest-test.exe')
  await fs.copyFile(source, file)
  await editWindowsResources({ file, versionStrings: {}, fileVersion: config.version, productVersion: config.version, requestedExecutionLevel: config.build.win.requestedExecutionLevel })
  const resources = NtExecutableResource.from(NtExecutable.from(await fs.readFile(file)))
  const manifest = resources.entries.find(entry => entry.type === 24 && entry.id === 1)
  assert.ok(manifest, 'RT_MANIFEST resource')
  const xml = Buffer.from(manifest.bin).toString('utf8')
  assert.match(xml, /requestedExecutionLevel[^>]*level="requireAdministrator"/)
  await fs.writeFile(path.join(output, 'manifest.xml'), xml)
  console.log('PASS: Windows executable requests administrator privileges')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
