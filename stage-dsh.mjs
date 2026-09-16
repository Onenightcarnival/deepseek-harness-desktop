/**
 * Stage the @deepseek-ai/dsh runtime for the host (or given) platform into
 * staging/<platform>-<arch>/dsh and prune what the desktop app does not use.
 * Runs on Windows / macOS / Linux with plain Node >= 18.
 *
 * Usage:
 *   node stage-dsh.mjs                  # stage for the host platform/arch
 *   node stage-dsh.mjs win32 x64        # cross-stage (adds npm --os/--cpu)
 *
 * Env:
 *   DSH_VERSION  npm version/tag of @deepseek-ai/dsh. Default: install from
 *                the committed lockfile (locks/<flavor>.package-lock.json).
 *                A version that differs from the locked one, or
 *                DSH_STAGE_LIVE=1, switches to live npm resolution (slow,
 *                may OOM; see AGENTS.md).
 *   DSH_FLAVOR   preset-plugin manifest: "minimal" (default) reads
 *                plugins.json, any other value reads plugins-<flavor>.json
 *                (full -> plugins-full.json). A missing manifest is an error.
 *
 * `node stage-dsh.mjs --update-locks` runs a live resolution and writes the
 * result to locks/<flavor>.package-lock.json.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySshKeepalivePatch } from './patches/ssh-terminal-keepalive.mjs'

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

// --ignore-scripts: no node-gyp builds. Every native dep (node-pty, sharp via
// @img/*, koffi via @koromix/*) ships prebuilt binaries selected by npm's
// os/cpu fields.
// Preset plugin packages install next to dsh so the loader resolves them from
// the same node_modules tree; main.js activates them by seeding the user
// profile from preset-plugins.json (written below).
let extraPackages = []
const flavor = (process.env.DSH_FLAVOR || 'minimal').trim()
const pluginsFile = path.join(here, flavor === 'minimal' ? 'plugins.json' : `plugins-${flavor}.json`)
if (!fs.existsSync(pluginsFile)) {
  throw new Error(`flavor "${flavor}" 对应的插件清单不存在：${pluginsFile}`)
}
const pluginsManifest = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'))
// "packages" are seeded into the user profile (activated). "carry" are only
// installed and registered so they resolve from the app closure; activation
// stays with the user. Mutually exclusive families (skins) must be carry:
// seeding all of them activates every skin and collides entry ids with skins
// the user installed.
const seedPackages = pluginsManifest.packages ?? []
const carryPackages = pluginsManifest.carry ?? []
extraPackages = [...seedPackages, ...carryPackages]
if (extraPackages.length > 0) console.log(`flavor "${flavor}" seed: [${seedPackages.join(', ')}] carry: [${carryPackages.join(', ')}]`)

const cross = platform !== process.platform || arch !== process.arch
const crossFlags = cross ? [`--os=${platform}`, `--cpu=${arch}`, '--force'] : []
const baseFlags = ['--ignore-scripts', '--no-audit', '--no-fund']

// ---- install: locked by default, live only when asked ----
// Live npm resolution of the dsh graph backtracks on peer ranges and can run
// for >10min or OOM at a 2GB heap. Default is `npm ci` from the committed
// lockfile: no resolution, integrity checked, one lock covers every platform
// via os/cpu-conditional entries. Live mode is the dsh-upgrade path: larger
// heap, and --update-locks writes the new lock back.
const lockPath = path.join(here, 'locks', `${flavor}.package-lock.json`)
const wantLive = updateLocks || process.env.DSH_STAGE_LIVE === '1'
let useLock = false
if (!wantLive && fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  const lockedDsh = lock.packages['node_modules/@deepseek-ai/dsh']?.version
  if (version !== 'latest' && version !== lockedDsh) {
    console.log(`DSH_VERSION=${version} differs from locked ${lockedDsh}; using live resolution (slow). Run --update-locks to re-pin.`)
  } else {
    useLock = true
    const rootDeps = lock.packages[''].dependencies ?? {}
    const lockPlugins = Object.keys(rootDeps).filter((n) => n !== '@deepseek-ai/dsh').sort()
    if (lockPlugins.join() !== [...extraPackages].sort().join()) {
      throw new Error(`锁文件与插件清单不一致：lock=[${lockPlugins}] manifest=[${extraPackages}]。运行 node stage-dsh.mjs --update-locks 重新生成 ${path.basename(lockPath)}`)
    }
    console.log(`installing from lock ${path.basename(lockPath)} (dsh ${lockedDsh})`)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: rootDeps }, null, 2))
    fs.copyFileSync(lockPath, path.join(dir, 'package-lock.json'))
    // --force: npm ci re-validates peer ranges and rejects a preset plugin
    // whose peer lags dsh by one release. The lock is the decision record;
    // the staging smoke run is the compatibility check.
    execSync(`npm ${['ci', '--force', ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit' })
  }
} else if (!wantLive) {
  console.log(`no lockfile at ${lockPath}; using live resolution (slow). Run --update-locks to create it.`)
}

if (!useLock) {
  // Larger heap for arborist's backtracking. Locks remain the default path.
  const liveEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=6144`.trim() }
  // Step 1: dsh itself.
  execSync(`npm ${['install', `@deepseek-ai/dsh@${version}`, ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit', env: liveEnv })
  // Step 2: preset plugin packages. Plugin versions must target the bundled
  // dsh release: stale peer ranges make npm backtrack for a long time and
  // fail at runtime.
  if (extraPackages.length > 0) {
    execSync(`npm ${['install', ...extraPackages, ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit', env: liveEnv })
  }
  if (updateLocks) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.copyFileSync(path.join(dir, 'package-lock.json'), lockPath)
    console.log(`lock written: ${lockPath}`)
  }
}

// ---- desktop-owned plugins ----
// Plain packages kept in the repo under plugins/<name>: copied into the
// runtime tree and registered in the dsh app manifest, so the profile resolves
// them through the same closure as presets. They are composed by main.js
// patch overlays, never seeded into the profile; main.js repeats the copy for
// upgraded runtimes (ensureDesktopPlugins).
const desktopPluginNames = fs.readdirSync(path.join(here, 'plugins')).filter((n) => fs.existsSync(path.join(here, 'plugins', n, 'package.json')))
for (const name of desktopPluginNames) {
  const dest = path.join(dir, 'node_modules', name)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(path.join(here, 'plugins', name), dest, { recursive: true })
}
{
  const appManifestPath = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const appManifest = JSON.parse(fs.readFileSync(appManifestPath, 'utf8'))
  appManifest.dependencies ??= {}
  for (const name of desktopPluginNames) appManifest.dependencies[name] ??= '*'
  fs.writeFileSync(appManifestPath, JSON.stringify(appManifest, null, 2))
  console.log(`desktop plugins in runtime: ${desktopPluginNames.join(', ')}`)
}

if (extraPackages.length > 0) {

  // Register the preset plugins as dependencies of the bundled dsh app. At
  // boot dsh symlinks the app's dependency closure into
  // $DSH_HOME/profiles/node_modules (healProfilesModuleFallback); a package
  // resolves as a plugin from the web profile only through that closure.
  const rootManifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const pluginNames = Object.keys(rootManifest.dependencies ?? {}).filter((n) => n !== '@deepseek-ai/dsh')
  const appManifestPath = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const appManifest = JSON.parse(fs.readFileSync(appManifestPath, 'utf8'))
  appManifest.dependencies ??= {}
  for (const name of pluginNames) appManifest.dependencies[name] ??= '*'
  fs.writeFileSync(appManifestPath, JSON.stringify(appManifest, null, 2))
  console.log(`registered preset plugins in dsh app manifest: ${pluginNames.join(', ')}`)

  // Registration makes the packages resolvable from the profile. Activation
  // happens at runtime: main.js seeds each preset into the profile manifest's
  // dependencies + dsh.profile.bundles from this manifest of exact versions.
  const ver = (name) => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
  const presets = { seed: {}, carry: {} }
  for (const name of seedPackages) presets.seed[name] = ver(name)
  for (const name of carryPackages) presets.carry[name] = ver(name)
  fs.writeFileSync(path.join(dir, 'preset-plugins.json'), JSON.stringify(presets, null, 2))

  // Desktop-local patches on the installed plugins. Anchors throw on upstream
  // drift; a version bump fails the stage instead of shipping a broken patch.
  if (applySshKeepalivePatch(dir)) console.log('applied patch: ssh terminal keepalive')
}

// ---- bundled CLI tooling ----
// pnpm ships inside the runtime (dsh/tools/node_modules/pnpm). The desktop
// app writes `dsh`/`pnpm`/`npx` launchers that run it on Electron's embedded
// Node; `dsh plugin add` needs nothing installed on the machine.
// pnpm is pinned to the 11 line: from 12 the npm package is a placeholder
// whose postinstall downloads a native binary, which --ignore-scripts and
// offline users never run. 11.x ships bin/pnpm.cjs + bin/pnpm.mjs.
const toolsDir = path.join(dir, 'tools')
fs.mkdirSync(toolsDir, { recursive: true })
fs.writeFileSync(path.join(toolsDir, 'package.json'), JSON.stringify({ name: 'dsh-desktop-tools', private: true }, null, 2))
execSync(`npm ${['install', 'pnpm@11', ...baseFlags, '--omit=optional', ...crossFlags].join(' ')}`, { cwd: toolsDir, stdio: 'inherit' })
{
  const pnpmBin = path.join(toolsDir, 'node_modules', 'pnpm', 'bin')
  if (!fs.existsSync(path.join(pnpmBin, 'pnpm.cjs')) && !fs.existsSync(path.join(pnpmBin, 'pnpm.mjs'))) {
    throw new Error('bundled pnpm has no JavaScript entry (bin/pnpm.cjs|mjs); the launchers require one')
  }
}

// uv (Python-side counterpart of pnpm dlx): `uvx <pkg>` MCP servers run
// without a system Python; uv downloads an interpreter on first use into the
// app's userData (uvx launcher in main.js). Pinned GitHub release, sha256
// verified against the published digest. The archive holds two static
// binaries, uv and uvx; both go to dsh/tools/uv/.
const UV_VERSION = '0.12.10'
const UV_TRIPLE = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
}[key]
if (UV_TRIPLE === undefined) throw new Error(`no uv build mapped for ${key}`)
{
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'
  const asset = `uv-${UV_TRIPLE}.${ext}`
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/`
  const fetchBuf = async (url) => {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const [archive, digestText] = await Promise.all([fetchBuf(base + asset), fetchBuf(base + asset + '.sha256')])
  const expected = digestText.toString('utf8').trim().split(/\s+/)[0].toLowerCase()
  const actual = (await import('node:crypto')).createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) throw new Error(`uv ${asset}: sha256 mismatch (got ${actual}, published ${expected})`)
  const uvDir = path.join(toolsDir, 'uv')
  fs.rmSync(uvDir, { recursive: true, force: true })
  fs.mkdirSync(uvDir, { recursive: true })
  const tmpArchive = path.join(toolsDir, asset)
  fs.writeFileSync(tmpArchive, archive)
  const extractDir = path.join(toolsDir, 'uv-extract')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  if (ext === 'zip') {
    // bsdtar (Windows 10+, macOS) extracts zips; GNU tar on Linux does not.
    if (process.platform === 'linux') execSync(`unzip -q -o "${tmpArchive}" -d "${extractDir}"`, { stdio: 'inherit' })
    else execSync(`tar -xf "${tmpArchive}" -C "${extractDir}"`, { stdio: 'inherit' })
  } else {
    execSync(`tar -xzf "${tmpArchive}" -C "${extractDir}"`, { stdio: 'inherit' })
  }
  const wanted = platform === 'win32' ? ['uv.exe', 'uvx.exe'] : ['uv', 'uvx']
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const found = walk(extractDir)
  for (const name of wanted) {
    const src = found.find((f) => path.basename(f) === name)
    if (!src) throw new Error(`uv archive ${asset} lacks ${name}`)
    fs.copyFileSync(src, path.join(uvDir, name))
    if (platform !== 'win32') fs.chmodSync(path.join(uvDir, name), 0o755)
  }
  fs.writeFileSync(path.join(uvDir, 'VERSION'), UV_VERSION + '\n')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.rmSync(tmpArchive, { force: true })
  console.log(`bundled uv ${UV_VERSION} (${UV_TRIPLE})`)
}

// ---- prune ----
const nm = path.join(dir, 'node_modules')
const rm = (p) => fs.rmSync(p, { recursive: true, force: true })

// node-pty: keep this platform's prebuilds only; drop sources and debug symbols.
const pty = path.join(nm, 'node-pty')
if (fs.existsSync(pty)) {
  const prebuilds = path.join(pty, 'prebuilds')
  for (const entry of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    if (entry !== key) rm(path.join(prebuilds, entry))
  }
  for (const junk of ['deps', 'build', 'src', 'third_party']) rm(path.join(pty, junk))
}

// sharp: the native @img package is used; the wasm fallback is dropped.
rm(path.join(nm, '@img', 'sharp-wasm32'))

// Sourcemaps and .pdb debug symbols.
const walk = (p) => {
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.map') || entry.name.endsWith('.pdb')) fs.rmSync(full)
  }
}
walk(nm)

// Required pieces. node-pty ships prebuilds for win32/darwin (the packaged
// targets) only; a linux staging run skips that assertion.
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
