/**
 * Stage the @deepseek-ai/dsh runtime for the host (or given) platform into
 * staging/<platform>-<arch>/dsh and prune what the desktop app does not use.
 * Runs on Windows / macOS / Linux with plain Node >= 18.
 *
 * Usage:
 *   node stage-dsh.mjs                  # stage for the host platform/arch
 *   node stage-dsh.mjs win32 x64        # cross-stage (adds npm --os/--cpu)
 *   node stage-dsh.mjs --update-locks   # live resolution, written to locks/package-lock.json
 *
 * Env:
 *   DSH_VERSION  npm version/tag of @deepseek-ai/dsh. Default: install from
 *                the committed lockfile (locks/package-lock.json). A version
 *                that differs from the locked one, or DSH_STAGE_LIVE=1,
 *                switches to live npm resolution.
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

// --ignore-scripts: every native dep (node-pty, sharp via @img/*, koffi via
// @koromix/*) ships prebuilt binaries selected by npm's os/cpu fields.
const cross = platform !== process.platform || arch !== process.arch
const crossFlags = cross ? [`--os=${platform}`, `--cpu=${arch}`, '--force'] : []
const baseFlags = ['--ignore-scripts', '--no-audit', '--no-fund']

// ---- install: locked by default, live only when asked ----
// Default is `npm ci` from the committed lockfile: no resolution, integrity
// checked, one lock for every platform via os/cpu-conditional entries. Live
// mode is the dsh-upgrade path (larger heap; --update-locks writes the new
// lock back).
const lockPath = path.join(here, 'locks', 'package-lock.json')
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
    console.log(`installing from lock ${path.basename(lockPath)} (dsh ${lockedDsh})`)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: rootDeps }, null, 2))
    fs.copyFileSync(lockPath, path.join(dir, 'package-lock.json'))
    // --force: no peer re-validation by npm ci. The lock is the decision
    // record; the staging smoke run is the compatibility check.
    execSync(`npm ${['ci', '--force', ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit' })
  }
} else if (!wantLive) {
  console.log(`no lockfile at ${lockPath}; using live resolution (slow). Run --update-locks to create it.`)
}

if (!useLock) {
  // Larger heap for arborist's backtracking. Locks remain the default path.
  const liveEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=6144`.trim() }
  execSync(`npm ${['install', `@deepseek-ai/dsh@${version}`, ...baseFlags, ...crossFlags].join(' ')}`, { cwd: dir, stdio: 'inherit', env: liveEnv })
  if (updateLocks) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.copyFileSync(path.join(dir, 'package-lock.json'), lockPath)
    console.log(`lock written: ${lockPath}`)
  }
}

// ---- desktop-owned plugins ----
// Plain packages under plugins/<name>: copied into the runtime tree and
// registered in the dsh app manifest. Composed by main.js patch overlays,
// never installed into the profile; main.js repeats the copy for upgraded
// runtimes (ensureDesktopPlugins).
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

// ---- bundled CLI tooling ----
// pnpm ships inside the runtime (dsh/tools/node_modules/pnpm), pinned to the
// 11 line (bin/pnpm.cjs + bin/pnpm.mjs); main.js writes launchers that run
// it on Electron's embedded Node.
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

// uv (Python-side counterpart of pnpm dlx) for `uvx <pkg>` MCP servers:
// pinned GitHub release, sha256 verified against the published digest. The
// archive holds two static binaries, uv and uvx; both go to dsh/tools/uv/.
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

// Files the runtime never opens (install time on Windows scales with the
// file count):
// - sourcemaps and .pdb debug symbols;
// - TypeScript declarations (*.d.ts / *.d.mts / *.d.cts);
// - package prose (README / CHANGELOG / HISTORY / CONTRIBUTING / SECURITY /
//   CODE_OF_CONDUCT) of third-party packages. Every other .md stays (dsh
//   loads some at runtime); @deepseek-ai and plugin packages keep their
//   README; LICENSE files stay;
// - top-level test / docs / examples / .github directories of third-party
//   packages. @deepseek-ai packages are left whole.
const PROSE_MD = /^(readme|changelog|changes|history|contributing|security|code_of_conduct|governance|maintainers|authors)(\.|$)/i
// Only next to a package.json: nested dirs of these names can be runtime
// modules (yaml ships dist/doc/).
const JUNK_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github'])
let pruned = 0
const isDeepseek = (p) => p.split(path.sep).includes('@deepseek-ai')
// Plugin packages keep their prose too: a plugin's README is user-facing.
const pluginRoots = new Set(desktopPluginNames.map((n) => path.join(nm, ...n.split('/'))))
const inPluginPkg = (p) => { for (const root of pluginRoots) if (p === root || p.startsWith(root + path.sep)) return true; return false }
const countFiles = (p) => {
  let n = 0
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) n += entry.isDirectory() ? countFiles(path.join(p, entry.name)) : 1
  return n
}
const walk = (p) => {
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name)
    if (entry.isDirectory()) {
      if (JUNK_DIRS.has(entry.name) && !isDeepseek(full) && fs.existsSync(path.join(p, 'package.json'))) {
        pruned += countFiles(full)
        rm(full)
        continue
      }
      walk(full)
    } else if (
      entry.name.endsWith('.map') || entry.name.endsWith('.pdb') ||
      /\.d\.(ts|mts|cts)$/.test(entry.name) ||
      (entry.name.endsWith('.md') && PROSE_MD.test(entry.name) && !isDeepseek(full) && !inPluginPkg(full))
    ) {
      fs.rmSync(full)
      pruned++
    }
  }
}
walk(nm)
console.log(`pruned ${pruned} files the runtime never opens`)

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
console.log(`staged ${key}: ${(du(dir) / 1024 / 1024).toFixed(0)} MB, ${countFiles(dir)} files`)
