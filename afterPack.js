'use strict'
const path = require('path')
const fs = require('fs')

/**
 * electron-builder afterPack hook: copy the platform's staged dsh runtime
 * into the packed app's resources directory. Run `node stage-dsh.mjs`
 * before building so `staging/<platform>-<arch>/dsh` exists.
 */
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName // 'win32' | 'darwin' | 'linux'
  const arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch] || String(context.arch)
  const key = `${platform}-${arch}`

  const candidates = [
    path.join(__dirname, 'staging', key, 'dsh'),
    path.join(__dirname, '..', 'staging', key, 'dsh'),
  ]
  const src = candidates.find((p) => fs.existsSync(p))
  if (!src) throw new Error(`staged dsh runtime missing; run "node stage-dsh.mjs" first (looked in: ${candidates.join(', ')})`)

  let resDir
  if (platform === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`
    resDir = path.join(context.appOutDir, appName, 'Contents', 'Resources')
  } else {
    resDir = path.join(context.appOutDir, 'resources')
  }
  const dest = path.join(resDir, 'dsh')
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, { recursive: true, dereference: false, verbatimSymlinks: true })
  console.log(`afterPack: copied dsh runtime ${key} -> ${dest}`)
}
