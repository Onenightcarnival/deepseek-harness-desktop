/**
 * Stage the @deepseek-ai/dsh runtime for the current (or overridden)
 * platform into staging/<platform>-<arch>/dsh, then prune what the desktop
 * app never needs. Cross-platform: runs on the Windows / macOS / Linux CI
 * runner with plain Node >= 18.
 *
 * Usage:
 *   node stage-dsh.mjs                  # stage for the host platform/arch
 *   node stage-dsh.mjs win32 x64        # cross-stage (adds npm --os/--cpu)
 *
 * Env:
 *   DSH_VERSION  npm version/tag of @deepseek-ai/dsh (default: latest)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const platform = process.argv[2] ?? process.platform
const arch = process.argv[3] ?? process.arch
const key = `${platform}-${arch}`
const version = process.env.DSH_VERSION ?? 'latest'
const dir = path.join(here, 'staging', key, 'dsh')

console.log(`staging @deepseek-ai/dsh@${version} for ${key} -> ${dir}`)
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true }, null, 2))

// --ignore-scripts: skip node-gyp fallbacks entirely; every native dep this
// runtime needs (node-pty, sharp via @img/*, koffi via @koromix/*) ships
// prebuilt binaries selected by npm's os/cpu fields.
const cross = platform !== process.platform || arch !== process.arch
const flags = [
  'install', `@deepseek-ai/dsh@${version}`,
  '--ignore-scripts', '--no-audit', '--no-fund',
  ...(cross ? [`--os=${platform}`, `--cpu=${arch}`, '--force'] : []),
]
execSync(`npm ${flags.join(' ')}`, { cwd: dir, stdio: 'inherit' })

// ---- prune ----
const nm = path.join(dir, 'node_modules')
const rm = (p) => fs.rmSync(p, { recursive: true, force: true })

// node-pty: keep only this platform's prebuilds; drop sources and debug symbols
const pty = path.join(nm, 'node-pty')
if (fs.existsSync(pty)) {
  const prebuilds = path.join(pty, 'prebuilds')
  for (const entry of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    if (entry !== key) rm(path.join(prebuilds, entry))
  }
  for (const junk of ['deps', 'build', 'src', 'third_party']) rm(path.join(pty, junk))
}

// sharp: the wasm fallback is dead weight next to the native @img package
rm(path.join(nm, '@img', 'sharp-wasm32'))

// sourcemaps and .pdb debug symbols
const walk = (p) => {
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.map') || entry.name.endsWith('.pdb')) fs.rmSync(full)
  }
}
walk(nm)

// sanity checks: the pieces the desktop app depends on must exist.
// node-pty ships prebuilds for win32/darwin only — the packaged targets;
// a linux staging run (local smoke tests) skips that assertion.
const mustExist = [
  path.join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ...(platform === 'win32' || platform === 'darwin'
    ? [path.join(nm, 'node-pty', 'prebuilds', key)]
    : []),
]
for (const p of mustExist) {
  if (!fs.existsSync(p)) throw new Error(`staging incomplete: missing ${p}`)
}

const du = (p) => {
  let total = 0
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name)
    total += entry.isDirectory() ? du(full) : fs.statSync(full).size
  }
  return total
}
console.log(`staged ${key}: ${(du(dir) / 1024 / 1024).toFixed(0)} MB`)
