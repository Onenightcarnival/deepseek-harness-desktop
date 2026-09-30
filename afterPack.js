'use strict'
const path = require('path')
const fs = require('fs')

/**
 * electron-builder afterPack hook: copies the platform's staged dsh runtime
 * into the packed app's resources directory. Requires
 * `staging/<platform>-<arch>/dsh` from `node stage-dsh.mjs`.
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
  if (!src) throw new Error(`staged dsh runtime not found in ${candidates.join(', ')}. Run "node stage-dsh.mjs" first.`)

  let resDir
  if (platform === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`
    resDir = path.join(context.appOutDir, appName, 'Contents', 'Resources')
  } else {
    resDir = path.join(context.appOutDir, 'resources')
  }
  const dest = path.join(resDir, 'dsh')
  if (path.dirname(path.resolve(dest)) !== path.resolve(resDir)) throw new Error('invalid runtime destination')
  fs.rmSync(dest, { recursive: true, force: true })
  // Exclude the retired tools even when building from an older staging directory.
  const retiredUv = path.join(src, 'tools', 'uv')
  fs.cpSync(src, dest, { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: source => source !== retiredUv && !source.startsWith(retiredUv + path.sep),
  })
  console.log(`afterPack: copied dsh runtime ${key} -> ${dest}`)
}
