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
 *   DSH_VERSION  npm version/tag of @deepseek-ai/dsh. Default: use the
 *                committed lockfile (locks/<flavor>.package-lock.json) —
 *                deterministic and fast. Setting a version that differs from
 *                the locked one (or DSH_STAGE_LIVE=1) switches to live npm
 *                resolution, which can be pathologically slow/OOM-prone when
 *                the registry graph misbehaves — see AGENTS.md.
 *   DSH_FLAVOR   preset-plugin manifest to use: "minimal" (default) reads
 *                plugins.json, anything else reads plugins-<flavor>.json
 *                (e.g. full -> plugins-full.json); missing manifest = error
 *
 * `node stage-dsh.mjs --update-locks` runs a live resolution and writes the
 * result back to locks/<flavor>.package-lock.json — the dsh-upgrade step.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const updateLocks = process.argv.includes('--update-locks')
const platform = argv[0] ?? process.platform
const arch = argv[1] ?? process.arch
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
// Extra preset plugin packages (installed alongside dsh so the loader
// resolves them from the same node_modules tree; activated by main.js
// seeding them into the user profile, see preset-plugins.json below).
let extraPackages = []
const flavor = (process.env.DSH_FLAVOR || 'minimal').trim()
const pluginsFile = path.join(here, flavor === 'minimal' ? 'plugins.json' : `plugins-${flavor}.json`)
if (!fs.existsSync(pluginsFile)) {
  throw new Error(`flavor "${flavor}" 对应的插件清单不存在：${pluginsFile}`)
}
const pluginsManifest = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'))
// "packages" get seeded into the user profile (activated); "carry" are
// only installed + registered so they RESOLVE from the app closure —
// activation stays with the user (e.g. skins: the skin center enforces
// one-active-at-a-time, seeding them all would activate every skin at
// once AND collide entry ids with skins the user installed before).
const seedPackages = pluginsManifest.packages ?? []
const carryPackages = pluginsManifest.carry ?? []
extraPackages = [...seedPackages, ...carryPackages]
if (extraPackages.length > 0) console.log(`flavor "${flavor}" seed: [${seedPackages.join(', ')}] carry: [${carryPackages.join(', ')}]`)

const cross = platform !== process.platform || arch !== process.arch
const crossFlags = cross ? [`--os=${platform}`, `--cpu=${arch}`, '--force'] : []
const baseFlags = ['--ignore-scripts', '--no-audit', '--no-fund']

// ---- install: locked by default, live only when asked ----
// Live npm resolution of the dsh graph can explode: arborist backtracks on
// peer ranges and a registry-side release can turn a 30s install into an
// OOM (observed on the mac CI runners AND on linux — >10min at 2GB heap).
// So CI installs from a committed lockfile (npm ci: no resolution, integrity
// checked, one lock covers every platform via os/cpu-conditional entries).
// Live mode is for upgrading dsh: it gets a bigger heap and writes the new
// lock back with --update-locks.
const lockPath = path.join(here, 'locks', `${flavor}.package-lock.json`)
const wantLive = updateLocks || process.env.DSH_STAGE_LIVE === '1'
let useLock = false
if (!wantLive && fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  const lockedDsh = lock.packages['node_modules/@deepseek-ai/dsh']?.version
  if (version !== 'latest' && version !== lockedDsh) {
    console.log(`DSH_VERSION=${version} != locked ${lockedDsh} — falling back to live resolution (slow); run --update-locks to re-pin`)
  } else {
    useLock = true
    const rootDeps = lock.packages[''].dependencies ?? {}
    const lockPlugins = Object.keys(rootDeps).filter((n) => n !== '@deepseek-ai/dsh').sort()
    if (lockPlugins.join() !== [...extraPackages].sort().join()) {
      throw new Error(`锁文件与插件清单不一致：lock=[${lockPlugins}] manifest=[${extraPackages}]；改过 ${path.basename(pluginsFile)} 后需要跑 node stage-dsh.mjs --update-locks 重新生成 ${path.basename(lockPath)}`)
    }
    console.log(`installing from lock ${path.basename(lockPath)} (dsh ${lockedDsh})`)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: rootDeps }, null, 2))
    fs.copyFileSync(lockPath, path.join(dir, 'package-lock.json'))
    execSync(`npm ${['ci', ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit' })
  }
} else if (!wantLive) {
  console.log(`no lockfile at ${lockPath} — live resolution (slow); run --update-locks to create it`)
}

if (!useLock) {
  // bigger heap for arborist's backtracking; still no guarantee — prefer locks
  const liveEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=6144`.trim() }
  // Step 1: dsh itself.
  execSync(`npm ${['install', `@deepseek-ai/dsh@${version}`, ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit', env: liveEnv })
  // Step 2: preset plugin packages. NOTE: a plugin whose peer ranges target an
  // older dsh release than the bundled one makes this step extremely slow
  // (npm backtracks trying to satisfy stale peers) and would not work at
  // runtime anyway — pick plugin versions built for the bundled dsh release.
  if (extraPackages.length > 0) {
    execSync(`npm ${['install', ...extraPackages, ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit', env: liveEnv })
  }
  if (updateLocks) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.copyFileSync(path.join(dir, 'package-lock.json'), lockPath)
    console.log(`lock written: ${lockPath}`)
  }
}

if (extraPackages.length > 0) {

  // Register the preset plugins as dependencies of the bundled dsh app.
  // At boot dsh symlinks its app's dependency closure into
  // $DSH_HOME/profiles/node_modules (healProfilesModuleFallback), which is
  // what makes a package resolvable as a plugin from the web profile —
  // installing into this staging tree alone is not enough.
  const rootManifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const pluginNames = Object.keys(rootManifest.dependencies ?? {}).filter((n) => n !== '@deepseek-ai/dsh')
  const appManifestPath = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const appManifest = JSON.parse(fs.readFileSync(appManifestPath, 'utf8'))
  appManifest.dependencies ??= {}
  for (const name of pluginNames) appManifest.dependencies[name] ??= '*'
  fs.writeFileSync(appManifestPath, JSON.stringify(appManifest, null, 2))
  console.log(`registered preset plugins in dsh app manifest: ${pluginNames.join(', ')}`)

  // Registration only makes the packages RESOLVABLE from the profile.
  // Activation happens at runtime: main.js seeds each preset (once) into
  // the profile manifest's dependencies + dsh.profile.bundles, reading
  // this manifest of exact staged versions.
  const ver = (name) => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
  const presets = { seed: {}, carry: {} }
  for (const name of seedPackages) presets.seed[name] = ver(name)
  for (const name of carryPackages) presets.carry[name] = ver(name)
  fs.writeFileSync(path.join(dir, 'preset-plugins.json'), JSON.stringify(presets, null, 2))
}

// ---- bundled CLI tooling ----
// Ship pnpm inside the runtime (dsh/tools/node_modules/pnpm). The desktop
// app writes `dsh`/`pnpm` launchers that run it on Electron's embedded
// Node, so `dsh plugin add` works with nothing installed on the machine.
const toolsDir = path.join(dir, 'tools')
fs.mkdirSync(toolsDir, { recursive: true })
fs.writeFileSync(path.join(toolsDir, 'package.json'), JSON.stringify({ name: 'dsh-desktop-tools', private: true }, null, 2))
execSync(`npm ${['install', 'pnpm@latest', ...baseFlags, '--omit=optional', ...crossFlags].join(' ')}`, { cwd: toolsDir, stdio: 'inherit' })

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
