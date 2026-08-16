/**
 * DeepSeek Harness Desktop — Electron shell.
 *
 * Boots the bundled `dsh` server (via Electron's embedded Node using
 * ELECTRON_RUN_AS_NODE) on a free loopback port, waits for the ready line
 * ("dsh web: http://127.0.0.1:<port>"), then shows the Web UI in a window.
 */
'use strict'

const { app, BrowserWindow, dialog, shell, Menu, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { ENTRY_REL, compareVersions, runtimeVersion, pickRuntime, satisfiesNode, upsertManagedBlock, buildMcpBlock } = require('./runtime.js')

const READY_RE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/
const STARTUP_TIMEOUT_MS = 90_000
/** GitHub repo the update check queries ("owner/name"), from package.json. */
const UPDATE_REPO = (() => {
  try { return require('./package.json').updateRepo || null } catch { return null }
})()

/**
 * Check the GitHub releases of UPDATE_REPO for a newer app version.
 * @param interactive - also report "already up to date" / errors via dialog.
 */
async function checkAppUpdates(interactive) {
  if (!UPDATE_REPO) return
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop' },
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const rel = await res.json()
    const latest = String(rel.tag_name || '').replace(/^v/, '')
    if (latest && compareVersions(latest, app.getVersion()) > 0) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'DeepSeek Harness',
        message: `发现新版本 v${latest}（当前 v${app.getVersion()}）`,
        detail: rel.name || '',
        buttons: ['前往下载', '取消'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) shell.openExternal(rel.html_url || `https://github.com/${UPDATE_REPO}/releases`)
    } else if (interactive) {
      await dialog.showMessageBox({
        type: 'info', title: 'DeepSeek Harness',
        message: `当前已是最新版本（v${app.getVersion()}）`, buttons: ['好'],
      })
    }
  } catch (err) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'warning', title: 'DeepSeek Harness',
        message: '检查更新失败', detail: String(err && err.message || err), buttons: ['好'],
      })
    }
  }
}

let serverProc = null
let mainWindow = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

/** The runtime shipped inside the installer (or the dev staging dir). */
function bundledDshDir() {
  const packaged = path.join(process.resourcesPath || '', 'dsh')
  if (fs.existsSync(path.join(packaged, ENTRY_REL))) return packaged
  // Dev fallback (`npm start` after `node stage-dsh.mjs`)
  return path.join(__dirname, 'staging', `${process.platform}-${process.arch}`, 'dsh')
}

/** Directory holding in-place core upgrades (userData/runtimes/<version>). */
function runtimesDir() {
  return path.join(app.getPath('userData'), 'runtimes')
}

/** The active runtime: newest upgraded one, else the bundled one. */
let activeRuntime = null
function resolveActiveRuntime() {
  activeRuntime = pickRuntime(runtimesDir(), bundledDshDir())
  return activeRuntime
}

function dshEntry() {
  if (!activeRuntime) resolveActiveRuntime()
  return path.join(activeRuntime.dir, ENTRY_REL)
}

/**
 * Check npm for a newer @deepseek-ai/dsh core than the active runtime, and
 * offer an in-place upgrade (installed with the bundled pnpm into
 * userData/runtimes/<version>; a relaunch activates it).
 */
let coreUpgradeBusy = false
async function checkCoreUpdates(interactive) {
  if (coreUpgradeBusy) return
  try {
    const res = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest', {
      headers: { accept: 'application/json', 'user-agent': 'dsh-desktop' },
    })
    if (!res.ok) throw new Error(`npm registry ${res.status}`)
    const meta = await res.json()
    const latest = meta.version
    const current = (activeRuntime && activeRuntime.version) || '0.0.0'
    if (!latest || compareVersions(latest, current) <= 0) {
      if (interactive) {
        await dialog.showMessageBox({
          type: 'info', title: 'DeepSeek Harness',
          message: `dsh 内核已是最新（v${current}）`, buttons: ['好'],
        })
      }
      return
    }
    if (!satisfiesNode(process.versions.node, meta.engines && meta.engines.node)) {
      if (interactive) {
        await dialog.showMessageBox({
          type: 'warning', title: 'DeepSeek Harness',
          message: `npm 上有 dsh v${latest}，但它要求的 Node 版本超出本应用内置的 v${process.versions.node}`,
          detail: '需要等待桌面版发布新安装包升级。',
          buttons: ['好'],
        })
      }
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'info', title: 'DeepSeek Harness',
      message: `发现 dsh 内核新版本 v${latest}（当前 v${current}）`,
      detail: '将下载到本机并在重启应用后生效；若新内核启动失败会自动回退。',
      buttons: ['下载并升级', '取消'], defaultId: 0, cancelId: 1,
    })
    if (response !== 0) return
    coreUpgradeBusy = true
    try {
      await installCoreRuntime(latest)
      const { response: r2 } = await dialog.showMessageBox({
        type: 'info', title: 'DeepSeek Harness',
        message: `dsh v${latest} 已就绪`, detail: '重启应用后生效。',
        buttons: ['立即重启', '稍后'], defaultId: 0, cancelId: 1,
      })
      if (r2 === 0) { app.relaunch(); app.quit() }
    } finally {
      coreUpgradeBusy = false
    }
  } catch (err) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'warning', title: 'DeepSeek Harness',
        message: '检查内核更新失败', detail: String(err && err.message || err), buttons: ['好'],
      })
    }
  }
}

/** Install @deepseek-ai/dsh@version into userData/runtimes/<version> with the bundled pnpm. */
function installCoreRuntime(version) {
  return new Promise((resolve, reject) => {
    const dir = path.join(runtimesDir(), version)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true }, null, 2))
    const pnpmCjs = path.join(bundledDshDir(), 'tools', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (!fs.existsSync(pnpmCjs)) { reject(new Error('bundled pnpm missing')); return }
    // Full-flavor builds: the upgraded runtime must also carry the preset
    // plugins, or the seeded profile bundles stop resolving (the profile
    // resolves plugins from the ACTIVE runtime's app closure). Exact staged
    // versions — deterministic, immune to minimumReleaseAge downgrades.
    const presetSpecs = []
    try {
      const presets = JSON.parse(fs.readFileSync(path.join(bundledDshDir(), 'preset-plugins.json'), 'utf8'))
      for (const [name, v] of Object.entries(presets)) presetSpecs.push(`${name}@${v}`)
    } catch { /* minimal flavor */ }
    const child = spawn(process.execPath, [pnpmCjs, 'add', `@deepseek-ai/dsh@${version}`, ...presetSpecs, '--ignore-scripts'], {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let tail = ''
    const onChunk = (c) => { tail = (tail + c.toString()).slice(-4000) }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('exit', (code) => {
      if (code === 0 && runtimeVersion(dir) === version) {
        // Mirror stage-dsh.mjs: presets must be dependencies of the dsh APP
        // manifest — the profile resolves plugins from the app's dependency
        // closure, the runtime root manifest is not part of it.
        if (presetSpecs.length > 0) {
          try {
            const appManifestPath = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
            const appManifest = JSON.parse(fs.readFileSync(appManifestPath, 'utf8'))
            appManifest.dependencies ??= {}
            for (const spec of presetSpecs) {
              const name = spec.slice(0, spec.lastIndexOf('@'))
              appManifest.dependencies[name] ??= '*'
            }
            fs.writeFileSync(appManifestPath, JSON.stringify(appManifest, null, 2))
          } catch (err) {
            console.error('preset registration in upgraded runtime failed:', err)
          }
        }
        // keep only the freshly installed runtime
        for (const name of fs.readdirSync(runtimesDir())) {
          if (name !== version) fs.rmSync(path.join(runtimesDir(), name), { recursive: true, force: true })
        }
        resolve()
      } else {
        fs.rmSync(dir, { recursive: true, force: true })
        reject(new Error(`内核下载失败 (pnpm exit ${code})\n${tail.slice(-1500)}`))
      }
    })
    child.on('error', reject)
  })
}

function logFile() {
  try {
    return path.join(app.getPath('userData'), 'dsh-server.log')
  } catch {
    return null
  }
}

/**
 * Optional plugin-composition overlay shipped with the app
 * (desktop-patch.yml, applied via `dsh web --patch`). Lets a build preset,
 * disable, or reconfigure plugins without touching the upstream defaults.
 */
function desktopPatchArgs() {
  const candidates = [
    path.join(process.resourcesPath || '', 'desktop-patch.yml'),
    path.join(__dirname, 'desktop-patch.yml'), // dev (`npm start`)
  ]
  const p = candidates.find((c) => c && fs.existsSync(c))
  return p ? ['--patch', p] : []
}

// ---- GUI-managed MCP server configuration ----
//
// Servers are written as a marker-fenced managed block inside the user's
// profile patch layer (~/.dsh/profiles/web/cordis.patch.yml). dsh hot-reloads
// that file and dsh-mcp-client hot-swaps on config change, so saving in the
// GUI takes effect within seconds — no app restart. Only the fenced block is
// ever touched; the user's own entries are preserved.

function mcpStorePath() { return path.join(app.getPath('userData'), 'mcp-servers.json') }
function profilePatchPath() { return path.join(app.getPath('home'), '.dsh', 'profiles', 'web', 'cordis.patch.yml') }

function readMcpServers() {
  try { return JSON.parse(fs.readFileSync(mcpStorePath(), 'utf8')) } catch { return [] }
}

/** Apply the GUI-managed MCP servers into the profile patch layer. */
function applyMcpToProfile(servers) {
  const file = profilePatchPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { text = '[]\n' }
  fs.writeFileSync(file, upsertManagedBlock(text, 'mcp', buildMcpBlock(servers)))
  // retire the pre-0.1.3 launcher-overlay mechanism (required app restarts)
  try { fs.rmSync(path.join(app.getPath('userData'), 'mcp-patch.yml'), { force: true }) } catch { /* gone */ }
}

/** Validate one MCP server object from the GUI; returns an error string or null. */
function validateMcpServer(s, seen) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(s.serverName || '')) return `服务器名 "${s.serverName}" 无效（限 [A-Za-z0-9_-]{1,32}）`
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') return `"${s.serverName}" 的 enabled 无效`
  if (seen.has(s.serverName)) return `服务器名 "${s.serverName}" 重复`
  seen.add(s.serverName)
  const noCtl = (v) => typeof v === 'string' && v.length < 2000 && !/[\r\n\0]/.test(v)
  if (s.transport === 'stdio') {
    if (!noCtl(s.command) || s.command.trim() === '') return `"${s.serverName}" 缺少 command`
    if (s.args && (!Array.isArray(s.args) || !s.args.every(noCtl))) return `"${s.serverName}" 的 args 无效`
  } else if (s.transport === 'streamable-http') {
    if (!noCtl(s.url) || !/^https?:\/\//.test(s.url)) return `"${s.serverName}" 的 url 无效`
  } else {
    return `"${s.serverName}" 的 transport 无效`
  }
  for (const dict of [s.env, s.headers]) {
    if (dict === undefined) continue
    if (typeof dict !== 'object' || Array.isArray(dict)) return `"${s.serverName}" 的 env/headers 无效`
    for (const [k, v] of Object.entries(dict)) if (!noCtl(k) || !noCtl(v)) return `"${s.serverName}" 的 env/headers 含非法字符`
  }
  return null
}

// ---- GUI-managed skills ----

function skillsDir() { return path.join(app.getPath('home'), '.dsh', 'skills') }

function listSkills() {
  const dir = skillsDir()
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  const describe = (mdPath) => {
    try {
      const text = fs.readFileSync(mdPath, 'utf8').slice(0, 4000)
      const fm = text.match(/^description:\s*(.+)$/m)
      if (fm) return fm[1].trim().replace(/^['"]|['"]$/g, '')
      const para = text.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
      return (para || '').trim().slice(0, 120)
    } catch { return '' }
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) {
      out.push({ name: e.name, kind: 'bundle', description: describe(path.join(dir, e.name, 'SKILL.md')) })
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push({ name: e.name.slice(0, -3), kind: 'flat', description: describe(path.join(dir, e.name)) })
    }
  }
  return out
}

/**
 * On Windows the bundled dsh's native folder dialog (a koffi child process
 * re-spawning process.execPath) does not survive the Electron-as-node
 * packaging, so pin the in-app "browse" directory picker via a patch overlay.
 */
function pickerPatchArgs() {
  if (process.platform !== 'win32') return []
  const p = path.join(app.getPath('userData'), 'win-picker-patch.yml')
  // The "browse" interaction is a pair: host backend + client UI surface
  // (mirrors what dsh-host-directory-picker-auto mounts when it resolves
  // to browse). Both must be composed or the UI has no dialog to open.
  fs.writeFileSync(p, [
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse',
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: directory-picker-browse-ui',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '',
  ].join('\n'))
  return ['--patch', p]
}

/**
 * Write `dsh` and `pnpm` command-line launchers into userData/bin. Both run
 * on Electron's embedded Node (ELECTRON_RUN_AS_NODE), so `dsh plugin add`
 * works with no Node.js/pnpm installed on the machine. Returns the bin dir,
 * which is also prepended to the server's PATH so dsh finds pnpm.
 */
function writeCliLaunchers() {
  const binDir = path.join(app.getPath('userData'), 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const entry = dshEntry()
  // pnpm always ships with the BUNDLED runtime (an upgraded core runtime
  // under userData/runtimes has no tools/ directory).
  const pnpmCjs = path.join(bundledDshDir(), 'tools', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const exe = process.execPath
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\n"${exe}" --expose-internals "${entry}" %*\r\n`)
    // `node` shim: dependency install scripts (`node xxx.js`) need a node on
    // PATH; machines without Node.js get Electron's embedded one.
    fs.writeFileSync(path.join(binDir, 'node.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" %*\r\n`)
    if (fs.existsSync(pnpmCjs)) {
      fs.writeFileSync(path.join(binDir, 'pnpm.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\n"${exe}" "${pnpmCjs}" %*\r\n`)
    }
  } else {
    fs.writeFileSync(path.join(binDir, 'dsh'),
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport PATH="${binDir}:$PATH"\nexec "${exe}" --expose-internals "${entry}" "$@"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(binDir, 'node'),
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${exe}" "$@"\n`, { mode: 0o755 })
    if (fs.existsSync(pnpmCjs)) {
      fs.writeFileSync(path.join(binDir, 'pnpm'),
        `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport PATH="${binDir}:$PATH"\nexec "${exe}" "${pnpmCjs}" "$@"\n`, { mode: 0o755 })
    }
  }
  return binDir
}

/**
 * Open an OS terminal window with the bundled dsh/pnpm CLI on PATH, so
 * users can run `dsh …` immediately without any manual setup.
 */
function openCliTerminal() {
  const binDir = writeCliLaunchers()
  if (process.platform === 'win32') {
    // Mirror of the macOS .command approach: write a batch file and let
    // ShellExecute run it — that reliably allocates a visible console.
    // A direct spawn('cmd.exe', …, { detached }) does NOT: libuv maps
    // detached to DETACHED_PROCESS, so cmd runs without a console window
    // ("nothing happens"). Batch is parsed in the console codepage, hence
    // chcp 65001 before any non-ASCII line (file is saved as UTF-8).
    const cmdFile = path.join(binDir, 'DeepSeek Harness CLI.cmd')
    fs.writeFileSync(cmdFile, [
      '@echo off',
      'chcp 65001 >nul',
      'title DeepSeek Harness CLI',
      `set "PATH=${binDir};%PATH%"`,
      'echo dsh 命令行已就绪：可直接使用 dsh / pnpm 命令',
      'echo 例如：dsh plugin --profile web add ^<插件包^>',
      'cmd /K',
      '',
    ].join('\r\n'))
    shell.openPath(cmdFile).then((err) => {
      if (err) dialog.showErrorBox('无法打开命令行窗口', `${err}\n\n可手动打开该文件：\n${cmdFile}`)
    })
    return
  }
  if (process.platform === 'darwin') {
    // A .command file opens in Terminal; it drops into an interactive shell
    // with the launchers on PATH.
    const cmdFile = path.join(binDir, 'DeepSeek Harness CLI.command')
    fs.writeFileSync(cmdFile, [
      '#!/bin/sh',
      `export PATH="${binDir}:$PATH"`,
      'clear',
      'echo "dsh 命令行已就绪：可直接使用 dsh / pnpm 命令"',
      'echo "例如：dsh plugin --profile web add <插件包>"',
      'exec "${SHELL:-/bin/zsh}" -i',
      '',
    ].join('\n'), { mode: 0o755 })
    shell.openPath(cmdFile)
    return
  }
  // Other platforms: at least reveal the launcher directory.
  shell.openPath(binDir)
}

/**
 * Full-flavor builds ship preset plugin bundles inside the runtime
 * (plugins-full.json → stage-dsh.mjs → preset-plugins.json). Being a
 * dependency of the bundled dsh app only makes a package RESOLVABLE from
 * the profile (dsh symlinks the app closure into profiles/node_modules);
 * ACTIVATION requires the profile manifest to list it in dependencies +
 * dsh.profile.bundles — verified against dsh 0.1.x. Seed those entries
 * here, once per package: a marker in userData keeps us from re-adding a
 * bundle the user deliberately removed via GUI/CLI. Cold start (no
 * profile yet) writes the same skeleton dsh itself generates.
 */
function seedPresetPlugins() {
  try {
    // Runs in EVERY flavor: the minimal build must be able to withdraw
    // seeds a previously installed full build left in the profile, or an
    // overwrite install full→minimal crashes boot with "cannot resolve
    // profile bundle".
    let presets = {}
    try { presets = JSON.parse(fs.readFileSync(path.join(bundledDshDir(), 'preset-plugins.json'), 'utf8')) } catch { /* minimal flavor */ }
    const markerPath = path.join(app.getPath('userData'), 'seeded-presets.json')
    let seeded = []
    try { seeded = JSON.parse(fs.readFileSync(markerPath, 'utf8')) } catch { /* first run */ }
    if (Object.keys(presets).length === 0 && seeded.length === 0) return
    const profileDir = path.join(app.getPath('home'), '.dsh', 'profiles', 'web')

    /** Does <dir> hold a loadable copy of the package (entry file exists)? */
    const usableAt = (base, name) => {
      const pkgDir = path.join(base, ...name.split('/'))
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
        const entry = pj.main || (typeof pj.exports === 'string' ? pj.exports : null) || 'index.js'
        return fs.existsSync(path.join(pkgDir, entry))
      } catch { return false }
    }
    const localNm = path.join(profileDir, 'node_modules')
    const runtimeNm = path.join((activeRuntime && activeRuntime.dir) || bundledDshDir(), 'node_modules')
    // Resolvable by the ACTIVE runtime = user's own profile install, or the
    // runtime's app closure (what heals into profiles/node_modules).
    const resolvable = (name) => usableAt(localNm, name) || usableAt(runtimeNm, name)

    // A stale leftover of the package in the profile's OWN node_modules
    // (remnants of `dsh plugin remove` can keep package.json/LICENSE while
    // losing the code) shadows the healed fallback and crashes boot —
    // clear it. A real install (entry file present) wins over the preset.
    for (const name of new Set([...Object.keys(presets), ...seeded])) {
      const localDir = path.join(localNm, ...name.split('/'))
      try {
        if (fs.existsSync(localDir) && !usableAt(localNm, name)) {
          fs.rmSync(localDir, { recursive: true, force: true })
          console.log(`cleared broken leftover of ${name} from profile node_modules`)
        }
      } catch { /* best-effort */ }
    }

    const pkgPath = path.join(profileDir, 'package.json')
    let pkg = fs.existsSync(pkgPath)
      ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      : { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
    pkg.dependencies ??= {}
    pkg.dsh ??= {}
    pkg.dsh.profile ??= {}
    pkg.dsh.profile.bundles ??= []
    let changed = false

    // Withdraw seeds that no longer resolve (flavor switched away, or a
    // pre-preset core upgrade). Only names WE seeded are touched — a
    // user's own broken config is not ours to edit. Dropping the marker
    // lets a later full install re-seed cleanly.
    for (const name of [...seeded]) {
      if (resolvable(name)) continue
      const b = pkg.dsh.profile.bundles
      if (b.includes(name) || pkg.dependencies[name]) {
        pkg.dsh.profile.bundles = b.filter((x) => x !== name)
        delete pkg.dependencies[name]
        console.log(`withdrew preset ${name}: not resolvable by the active runtime`)
        changed = true
      }
      seeded = seeded.filter((x) => x !== name)
    }

    // Seed presets this runtime can actually serve, once per package: the
    // marker keeps us from re-adding a bundle the user deliberately
    // removed via GUI/CLI.
    for (const name of Object.keys(presets)) {
      if (seeded.includes(name)) continue
      if (!resolvable(name)) { console.log(`preset ${name} not resolvable by active runtime; skip seeding`); continue }
      pkg.dependencies[name] ??= presets[name]
      if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
      seeded.push(name)
      console.log(`seeded preset plugin into web profile: ${name}`)
      changed = true
    }

    if (changed) {
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    }
    fs.writeFileSync(markerPath, JSON.stringify(seeded, null, 2))
  } catch (err) {
    console.error('preset plugin seeding failed (non-fatal):', err)
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const entry = dshEntry()
    if (!fs.existsSync(entry)) {
      reject(new Error(`bundled dsh not found at ${entry}`))
      return
    }
    seedPresetPlugins()

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    // Electron-specific vars must not leak into the node child.
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    // Expose the bundled dsh/pnpm CLI launchers to the server and its
    // children (dsh's plugin command locates pnpm via PATH).
    try {
      const binDir = writeCliLaunchers()
      env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`
    } catch { /* CLI launchers are best-effort */ }

    serverProc = spawn(process.execPath, ['--expose-internals', entry, 'web', ...desktopPatchArgs(), ...pickerPatchArgs(), '--port', '0'], {
      env,
      cwd: app.getPath('home'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const lf = logFile()
    const logStream = lf ? fs.createWriteStream(lf, { flags: 'w' }) : null

    let settled = false
    let tail = ''
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error(`dsh server did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s.\nLast output:\n${tail.slice(-2000)}`))
      }
    }, STARTUP_TIMEOUT_MS)

    const onChunk = (chunk) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-8000)
      if (logStream) logStream.write(text)
      if (!settled) {
        const m = READY_RE.exec(tail)
        if (m) {
          settled = true
          clearTimeout(timer)
          resolve(m[1])
        }
      }
    }
    serverProc.stdout.on('data', onChunk)
    serverProc.stderr.on('data', onChunk)

    serverProc.on('exit', (code) => {
      serverProc = null
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`dsh server exited early (code ${code}).\nOutput:\n${tail.slice(-2000)}`))
      } else if (!quitting) {
        // Server died while the app is open.
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'DeepSeek Harness',
            message: 'The dsh server stopped unexpectedly.',
            detail: lf ? `See log: ${lf}` : String(code),
          }).then(() => app.quit())
        }
      }
    })
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#101014',
    show: true,
    icon: process.platform === 'linux' ? path.join(__dirname, 'build', 'icon.png') : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'splash.html'))

  // Open external links in the system browser, keep the app on the local UI.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('file://')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: '插件',
      submenu: [
        { label: '配置中心…（插件 / MCP / 技能）', click: () => { openPluginManager() } },
        { label: '打开命令行窗口', click: () => { openCliTerminal() } },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: `内核版本：v${(activeRuntime && activeRuntime.version) || '?'}${activeRuntime && !activeRuntime.bundled ? '（已升级）' : ''}`, enabled: false },
        { label: '检查内核更新…', click: () => { checkCoreUpdates(true) } },
        { label: '检查应用更新…', click: () => { checkAppUpdates(true) } },
        { type: 'separator' },
        { label: 'GitHub 仓库', click: () => { if (UPDATE_REPO) shell.openExternal(`https://github.com/${UPDATE_REPO}`) } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Run the bundled dsh CLI (plugin management) and capture its output. */
function runDshCli(args) {
  return new Promise((resolve) => {
    const binDir = writeCliLaunchers()
    const child = spawn(process.execPath, ['--expose-internals', dshEntry(), ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    const onChunk = (c) => { out = (out + c.toString()).slice(-20000) }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('exit', (code) => resolve({ code, output: out }))
    child.on('error', (err) => resolve({ code: -1, output: String(err) }))
  })
}

let pluginWindow = null
function openPluginManager() {
  if (pluginWindow && !pluginWindow.isDestroyed()) { pluginWindow.focus(); return }
  pluginWindow = new BrowserWindow({
    width: 880,
    height: 620,
    title: '配置中心',
    parent: mainWindow || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-plugins.js'),
    },
  })
  pluginWindow.setMenuBarVisibility(false)
  pluginWindow.loadFile(path.join(__dirname, 'plugins.html'))
  pluginWindow.on('closed', () => { pluginWindow = null })
}

ipcMain.handle('plugins:list', async () => {
  try {
    const manifest = path.join(app.getPath('home'), '.dsh', 'profiles', 'web', 'package.json')
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    return { deps: parsed.dependencies ?? {}, bundles: parsed.dsh?.profile?.bundles ?? [] }
  } catch {
    return { deps: {}, bundles: [] }
  }
})
/**
 * Extract the build-script approvals a failed install asks for:
 * - ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED prints an exact
 *   "allowBuilds:\n  <pkg@git+url#sha>: true" suggestion;
 * - ERR_PNPM_IGNORED_BUILDS lists bare package names.
 */
function parseAllowBuildsRequests(output) {
  const keys = []
  const gitHint = /allowBuilds:\s*\n\s+(\S+): true/g
  for (let m; (m = gitHint.exec(output)); ) keys.push(m[1])
  const ignored = /Ignored build scripts: ([^\n]+)/g
  for (let m; (m = ignored.exec(output)); ) {
    for (const entry of m[1].split(',')) {
      const name = entry.trim().replace(/@[\d][^@]*$/, '') // drop trailing @version
      if (name) keys.push(name)
    }
  }
  return [...new Set(keys)]
}

ipcMain.handle('plugins:run', async (_event, action, spec) => {
  const cleaned = String(spec || '').trim()
  // Accept every npm install spec shape: plain names, @scope/name@range,
  // github:owner/repo#ref, git+https://…, https://….tgz, file:/link: paths.
  // Args go through spawn(argv[]) — no shell — so this is hygiene, not a
  // security boundary; just reject whitespace/control characters.
  if (cleaned.length === 0 || cleaned.length > 300 || /[\s'"`\\]/.test(cleaned)) {
    return { code: -1, output: '无效的包名' }
  }
  if (action !== 'add' && action !== 'remove') return { code: -1, output: '无效操作' }
  const result = await runDshCli(['plugin', '--profile', 'web', action, cleaned])
  if (action === 'add' && result.code !== 0) {
    result.needsAllowBuilds = parseAllowBuildsRequests(result.output)
  }
  return result
})
/**
 * Turn an absolute local path into a portable pnpm spec. Forward slashes
 * everywhere: npm-package-arg parses file:/link: specs as URLs and chokes
 * on raw Windows backslashes.
 */
function localSpec(protocol, absPath) {
  let p = path.resolve(absPath)
  if (process.platform === 'win32') p = p.replace(/\\/g, '/')
  return `${protocol}:${p}`
}
/**
 * Install a plugin from local disk, IDE-style. Directory → link: (symlink,
 * dev loop: edits picked up on app restart, the plugin manages its own
 * node_modules); .tgz (npm pack output) → file: (copied, deps installed).
 * The picker path bypasses the text-spec hygiene check on purpose — paths
 * with spaces/backslashes are fine because args go through spawn(argv[]).
 */
ipcMain.handle('plugins:installLocal', async (_event, kind) => {
  if (kind !== 'dir' && kind !== 'tgz') return { code: -1, output: '无效操作' }
  const opts = kind === 'dir'
    ? { title: '选择插件目录（需含 package.json）', properties: ['openDirectory'] }
    : { title: '选择插件包（npm pack 打出的 .tgz）', properties: ['openFile'], filters: [{ name: 'npm 包', extensions: ['tgz'] }] }
  const { canceled, filePaths } = await dialog.showOpenDialog(pluginWindow || mainWindow, opts)
  if (canceled || filePaths.length === 0) return { canceled: true, code: 0, output: '' }
  const target = filePaths[0]
  if (kind === 'dir' && !fs.existsSync(path.join(target, 'package.json'))) {
    return { code: -1, output: `所选目录没有 package.json，不是一个 npm 包：\n${target}` }
  }
  const spec = localSpec(kind === 'dir' ? 'link' : 'file', target)
  const result = await runDshCli(['plugin', '--profile', 'web', 'add', spec])
  if (result.code !== 0) result.needsAllowBuilds = parseAllowBuildsRequests(result.output)
  result.spec = spec
  return result
})
ipcMain.handle('plugins:restart', async () => {
  app.relaunch()
  app.quit()
})

/**
 * Probe an MCP server config before saving: HTTP servers get a real
 * initialize POST; stdio commands are spawned and must survive ~2.5s.
 * Returns { ok, detail } — never throws.
 */
async function testMcpServer(server, extraPath) {
  if (server.transport === 'streamable-http') {
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(server.headers || {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-desktop-test', version: '1.0' } },
        }),
        signal: AbortSignal.timeout(6000),
      })
      return { ok: res.ok, detail: `HTTP ${res.status}${res.ok ? '，服务可达' : '（服务在但返回异常，检查路径/认证头）'}` }
    } catch (err) {
      const msg = String(err && (err.cause?.message || err.message) || err)
      let hint = ''
      if (/certificate|SSL|TLS|wrong version number|packet length/i.test(msg)) {
        hint = '（疑似对 http 服务用了 https——本机/内网服务通常应写 http://）'
      } else if (/ECONNREFUSED/.test(msg)) {
        hint = '（端口没有服务在监听——确认 MCP 服务器已启动）'
      } else if (/timeout|aborted/i.test(msg)) {
        hint = '（连接超时——地址不可达或服务无响应）'
      }
      return { ok: false, detail: `连接失败：${msg} ${hint}` }
    }
  }
  // stdio: the command must start and stay alive briefly
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(server.command, server.args || [], {
        env: { ...process.env, ...(server.env || {}), ...(extraPath ? { PATH: `${extraPath}${path.delimiter}${process.env.PATH || ''}` } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, detail: `无法启动命令：${String(err && err.message || err)}` })
      return
    }
    let errTail = ''
    child.stderr.on('data', (c) => { errTail = (errTail + c.toString()).slice(-400) })
    child.on('error', (err) => resolve({ ok: false, detail: `无法启动命令：${String(err.message)}（命令不存在或不可执行）` }))
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* gone */ }
      resolve({ ok: true, detail: '命令可启动并保持运行（能否完成 MCP 握手以保存后实际连接为准）' })
    }, 2500)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: `命令启动后立即退出 (exit ${code})${errTail ? `：${errTail.trim()}` : ''}` })
    })
  })
}

ipcMain.handle('mcp:test', async (_event, server) => {
  const err = validateMcpServer(server, new Set())
  if (err) return { ok: false, detail: err }
  let extraPath
  try { extraPath = writeCliLaunchers() } catch { extraPath = undefined }
  return testMcpServer(server, extraPath)
})
ipcMain.handle('mcp:list', async () => readMcpServers())
ipcMain.handle('mcp:save', async (_event, servers) => {
  if (!Array.isArray(servers) || servers.length > 50) return { ok: false, error: '数据格式无效' }
  const seen = new Set()
  for (const s of servers) {
    const err = validateMcpServer(s, seen)
    if (err) return { ok: false, error: err }
  }
  try {
    fs.writeFileSync(mcpStorePath(), JSON.stringify(servers, null, 2))
    applyMcpToProfile(servers)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})
ipcMain.handle('app:openLog', async () => {
  const lf = logFile()
  if (lf && fs.existsSync(lf)) shell.openPath(lf)
})

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
ipcMain.handle('skills:list', async () => listSkills())
ipcMain.handle('skills:open', async () => {
  fs.mkdirSync(skillsDir(), { recursive: true })
  shell.openPath(skillsDir())
})
/** Extract a zip with OS-native tooling (no runtime deps). Throws on failure. */
function extractZip(zipPath, destDir) {
  const { spawnSync } = require('child_process')
  fs.mkdirSync(destDir, { recursive: true })
  let r
  if (process.platform === 'win32') {
    const esc = (s) => s.replace(/'/g, "''")
    r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(destDir)}' -Force`],
      { windowsHide: true, timeout: 60_000 })
  } else {
    r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { timeout: 60_000 })
  }
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`解压失败 (exit ${r.status})：${String(r.stderr || '').slice(0, 300)}`)
}

ipcMain.handle('skills:installZip', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(pluginWindow || mainWindow, {
    title: '选择技能包（.zip，可含单个或多个技能）',
    properties: ['openFile'],
    filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
  })
  if (canceled || filePaths.length === 0) return { ok: false, error: '' }
  const zipPath = filePaths[0]
  const tmp = path.join(app.getPath('userData'), `tmp-skill-${process.pid}-${Math.floor(performance.now())}`)
  try {
    extractZip(zipPath, tmp)
    const { collectSkills } = require('./runtime.js')
    const { found, rejected } = collectSkills(fs, tmp, path.basename(zipPath, '.zip'), path)
    if (found.length === 0) {
      return { ok: false, error: `压缩包里没有可识别的技能（需要 SKILL.md 目录包或 .md 文件）${rejected.length ? `；名称无法转为 kebab-case 的已跳过：${rejected.join(', ')}` : ''}` }
    }
    fs.mkdirSync(skillsDir(), { recursive: true })
    const exists = (name) => fs.existsSync(path.join(skillsDir(), name)) || fs.existsSync(path.join(skillsDir(), `${name}.md`))
    const conflicts = found.filter((s) => exists(s.name)).map((s) => s.name)

    // Same-name skills: ask once for the whole batch — overwrite, skip, or abort.
    let overwrite = false
    if (conflicts.length > 0) {
      const { response } = await dialog.showMessageBox(pluginWindow || mainWindow, {
        type: 'question',
        title: '技能已存在',
        message: `以下技能已存在：${conflicts.join('、')}`,
        detail: '覆盖会用压缩包里的版本替换现有技能（原内容删除）；跳过则只安装不冲突的技能。',
        buttons: ['覆盖', '跳过同名', '取消安装'],
        defaultId: 1,
        cancelId: 2,
      })
      if (response === 2) return { ok: false, error: '已取消安装' }
      overwrite = response === 0
    }

    const installed = []
    const overwritten = []
    const skipped = []
    for (const s of found) {
      const conflicted = exists(s.name)
      if (conflicted && !overwrite) { skipped.push(s.name); continue }
      if (conflicted) {
        fs.rmSync(path.join(skillsDir(), s.name), { recursive: true, force: true })
        fs.rmSync(path.join(skillsDir(), `${s.name}.md`), { force: true })
      }
      const dest = path.join(skillsDir(), s.kind === 'bundle' ? s.name : `${s.name}.md`)
      if (s.kind === 'bundle') fs.cpSync(s.src, dest, { recursive: true })
      else fs.copyFileSync(s.src, dest)
      ;(conflicted ? overwritten : installed).push(s.name)
    }
    return { ok: installed.length + overwritten.length > 0, installed, overwritten, skipped, rejected,
      error: installed.length + overwritten.length === 0 ? `全部同名跳过：${skipped.join(', ')}` : '' }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
ipcMain.handle('skills:delete', async (_event, name) => {
  const n = String(name || '').trim()
  if (!SKILL_NAME_RE.test(n) || n.length > 64) return { ok: false, error: '技能名无效' }
  const bundle = path.join(skillsDir(), n)
  const flat = path.join(skillsDir(), `${n}.md`)
  try {
    if (fs.existsSync(path.join(bundle, 'SKILL.md'))) fs.rmSync(bundle, { recursive: true })
    else if (fs.existsSync(flat)) fs.rmSync(flat)
    else return { ok: false, error: '技能不存在' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

function stopServer() {
  quitting = true
  if (serverProc) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree on Windows (dsh spawns its own children) and
        // wait for it, so quitting the app never abandons lock-holding
        // descendants (conpty agents etc.) in the install directory.
        require('child_process').spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
      } else {
        serverProc.kill('SIGTERM')
      }
    } catch { /* already gone */ }
    serverProc = null
  }
}

app.whenReady().then(async () => {
  resolveActiveRuntime()
  buildMenu()
  createWindow()
  try {
    const url = await startServer()
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(url)
    }
  } catch (err) {
    // An upgraded core that fails to boot gets quarantined; the app
    // relaunches on the bundled runtime automatically.
    if (activeRuntime && !activeRuntime.bundled) {
      try { fs.renameSync(activeRuntime.dir, `${activeRuntime.dir}.broken-${Date.now()}`) } catch { /* keep going */ }
      if (mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: 'DeepSeek Harness',
          message: `升级的 dsh 内核（v${activeRuntime.version}）启动失败，已回退到内置版本`,
          detail: String(err && err.message || err).slice(0, 800),
          buttons: ['重启应用'],
        })
      }
      app.relaunch()
      app.quit()
      return
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'DeepSeek Harness',
        message: 'Failed to start the dsh server.',
        detail: String(err && err.message || err),
      })
    }
    app.quit()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Silent startup update checks (only surface a dialog when newer exists):
  // the app itself (GitHub releases) and the dsh core (npm registry).
  setTimeout(() => { checkAppUpdates(false) }, 15_000)
  setTimeout(() => { checkCoreUpdates(false) }, 25_000)
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', stopServer)
process.on('exit', stopServer)
