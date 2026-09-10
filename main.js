/**
 * DeepSeek Harness Desktop: Electron shell.
 *
 * Boots the bundled `dsh` server (via Electron's embedded Node using
 * ELECTRON_RUN_AS_NODE) on a free loopback port, waits for the ready line
 * ("dsh web: http://127.0.0.1:<port>/?token=…"), then shows the Web UI in a window.
 */
'use strict'

const { app, BrowserWindow, dialog, shell, Menu, ipcMain, session, net: electronNet } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { ENTRY_REL, compareVersions, releaseLine, runtimeVersion, pickRuntime, satisfiesNode, upsertManagedBlock, buildMcpBlock, prependEnvPath,
  COMMON_SETTINGS, validateCommonSettings, buildSettingsBlock, groupCommonSettings,
  listSkillStore, skillExists, removeSkill, setSkillEnabled, skillDetail, readSkillFile,
  applyProxyEnv, PROXY_ENV_KEYS } = require('./runtime.js')
const { createForwarder, routeFor } = require('./proxy-forward.js')

// The ready line carries a one-time browser-trust token (dsh 0.1.2-rc.1+);
// the bare origin answers 401. The whole URL is captured and loaded as-is;
// the token exchange (303 → cookie) happens inside the window.
const READY_RE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/
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
    const res = await electronNet.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
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
 * Preload args for every Node child: --require win-spawn-shim.js, which
 * defaults windowsHide for the whole child process (under a GUI parent each
 * unhidden console child gets a visible console host). Plain Node children
 * cannot read the asar; the shim is copied to userData once per boot. No-op
 * off Windows; injected on every platform so the Linux smoke run covers the
 * loading path.
 */
let spawnShimPath = null
function nodePreloadArgs() {
  if (spawnShimPath === null) {
    try {
      const dest = path.join(app.getPath('userData'), 'win-spawn-shim.js')
      fs.writeFileSync(dest, fs.readFileSync(path.join(__dirname, 'win-spawn-shim.js')))
      spawnShimPath = dest
    } catch (err) {
      console.error('spawn shim unavailable:', String((err && err.message) || err))
      spawnShimPath = '' // no retry on later calls
    }
  }
  return spawnShimPath ? ['--require', spawnShimPath] : []
}

/**
 * Propagate the shim to every descendant Node process via NODE_OPTIONS:
 * argv --require reaches only the direct child, while pwsh may be spawned by
 * a grandchild (background job runners, stdio MCP servers). The path is
 * quoted so spaces in the userData path survive. Appends after any user-set
 * NODE_OPTIONS. Mutates and returns env.
 */
function withNodePreloadEnv(env) {
  const args = nodePreloadArgs()
  if (args.length === 2) {
    // Forward slashes only: inside NODE_OPTIONS quotes Node treats backslash
    // as an escape, a native Windows path loses its separators, and the
    // --require failure kills every Node child. Node accepts / in require
    // paths on Windows; the quotes keep spaces intact.
    const inject = `--require "${args[1].replace(/\\/g, '/')}"`
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${inject}` : inject
  }
  return env
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
    const res = await electronNet.fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest', {
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
    // Presets are pinned to the bundled core's release line; a core from
    // another line boots under plugins built for the old one. Cross-line
    // upgrades go through a new desktop build.
    const bundledVersion = runtimeVersion(bundledDshDir()) || current
    if (releaseLine(latest) !== releaseLine(bundledVersion)) {
      if (interactive) {
        const { response } = await dialog.showMessageBox({
          type: 'info', title: 'DeepSeek Harness',
          message: `npm 上有 dsh v${latest}，属于新的版本线（${releaseLine(latest)}）`,
          detail: `本安装包内置 v${bundledVersion}（${releaseLine(bundledVersion)} 线）。预置插件与内核版本线绑定；跨线升级需下载新版桌面安装包。`,
          buttons: ['检查应用更新', '好'], defaultId: 0, cancelId: 1,
        })
        if (response === 0) await checkAppUpdates(true)
      }
      return
    }
    if (!satisfiesNode(process.versions.node, meta.engines && meta.engines.node)) {
      if (interactive) {
        await dialog.showMessageBox({
          type: 'warning', title: 'DeepSeek Harness',
          message: `dsh v${latest} 要求的 Node 版本高于本应用内置的 v${process.versions.node}`,
          detail: '请等待新版桌面安装包。',
          buttons: ['好'],
        })
      }
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'info', title: 'DeepSeek Harness',
      message: `发现 dsh 内核新版本 v${latest}（当前 v${current}）`,
      detail: '下载后重启应用生效；新内核启动失败时自动回退到内置版本。',
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
async function installCoreRuntime(version) {
  return new Promise((resolve, reject) => {
    const dir = path.join(runtimesDir(), version)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true }, null, 2))
    const pnpmCjs = pnpmEntry()
    if (!pnpmCjs) { reject(new Error('bundled pnpm missing')); return }
    // Full-flavor builds: the upgraded runtime carries the preset plugins;
    // the profile resolves plugins from the active runtime's app closure.
    // Exact staged versions, immune to minimumReleaseAge downgrades.
    const presetSpecs = []
    try {
      const presets = JSON.parse(fs.readFileSync(path.join(bundledDshDir(), 'preset-plugins.json'), 'utf8'))
      for (const group of [presets.seed, presets.carry]) {
        for (const [name, v] of Object.entries(group || {})) presetSpecs.push(`${name}@${v}`)
      }
    } catch { /* minimal flavor */ }
    const child = spawn(process.execPath, [...nodePreloadArgs(), pnpmCjs, '--config.minimum-release-age=0', '--config.auto-install-peers=false', 'add', `@deepseek-ai/dsh@${version}`, ...presetSpecs, '--ignore-scripts'], {
      cwd: dir,
      env: withNodePreloadEnv(withProxyEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '1' })),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let tail = ''
    const onChunk = (c) => { tail = (tail + c.toString()).slice(-4000) }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('exit', (code) => {
      if (code === 0 && runtimeVersion(dir) === version) {
        // Presets are dependencies of the dsh app manifest (same as
        // stage-dsh.mjs): the profile resolves plugins from the app's
        // dependency closure, not from the runtime root manifest.
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
 * (desktop-patch.yml, applied via `dsh web --patch`): presets, disables or
 * reconfigures plugins on top of the upstream defaults.
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
// that file and dsh-mcp-client hot-swaps on config change; saving takes
// effect without an app restart. Only the fenced block is touched; the
// user's own entries are preserved.

/**
 * Proxy config store, PyCharm-shaped:
 * {mode: 'none'|'system'|'manual', host, port, bypass, auth, login, remember,
 *  password?}. password is persisted only when remember is true; otherwise
 * it lives in sessionProxyPassword for this run and is re-entered after a
 * restart.
 */
function proxyStorePath() { return path.join(app.getPath('userData'), 'proxy.json') }
let sessionProxyPassword = ''
const PROXY_DEFAULTS = { mode: 'none', host: '', port: '', bypass: '', auth: false, login: '', remember: true, password: '', caPath: '', insecure: false }
function readProxyConfig() {
  let c = {}
  try { c = JSON.parse(fs.readFileSync(proxyStorePath(), 'utf8')) } catch { /* none yet */ }
  // one-time migration of the {enabled, url} shape
  if (c.url !== undefined && c.host === undefined) {
    try {
      const u = new URL(c.url)
      c = { mode: c.enabled ? 'manual' : 'none', host: u.hostname, port: u.port || '80', bypass: c.bypass || '',
            auth: !!u.username, login: decodeURIComponent(u.username || ''), remember: true, password: decodeURIComponent(u.password || '') }
    } catch { c = {} }
    try { fs.writeFileSync(proxyStorePath(), JSON.stringify(c, null, 2)) } catch { /* keep going */ }
  }
  const merged = { ...PROXY_DEFAULTS, ...c }
  if (merged.auth && !merged.remember && !merged.password) merged.password = sessionProxyPassword
  return merged
}
/**
 * Resolve the OS proxy for one URL via Chromium: PAC-aware, honours the
 * Windows exception list, cross-platform. Returns {host, port} or null
 * (direct). Called per request by the forwarder; never cached.
 */
async function resolveSystemProxy(url) {
  try {
    // Dedicated in-memory session: defaultSession carries our own setProxy()
    // config, so its resolveProxy() would be self-referential. This partition
    // keeps Chromium's default behaviour (OS settings, PAC).
    const probe = session.fromPartition('proxy-probe')
    const s = await probe.resolveProxy(url || 'https://registry.npmjs.org/')
    const m = /(?:PROXY|HTTPS)\s+([^;\s:]+):(\d+)/.exec(s || '')
    return m ? { host: m[1], port: m[2] } : null
  } catch { return null }
}
/**
 * Mirror the proxy config onto Electron's (Chromium) network layer: shell
 * window traffic and update checks follow the same setting. The dsh child
 * process and its descendants are plain Node processes and go through the
 * forwarder below. Chromium bypasses loopback implicitly; the local web UI
 * is unaffected.
 */
async function applyChromiumProxy(config) {
  const c = config || PROXY_DEFAULTS
  try {
    if (c.mode === 'manual' && String(c.host || '').trim() && String(c.port ?? '').trim()) {
      const bypass = ['127.0.0.1', 'localhost', '::1']
      // same separators as runtime.js bypassPatterns; shell window and
      // forwarder read one list
      for (const part of String(c.bypass || '').split(/[,;\s]+/)) { if (part.trim()) bypass.push(part.trim()) }
      await session.defaultSession.setProxy({
        proxyRules: `http://${String(c.host).trim()}:${String(c.port).trim()}`,
        proxyBypassRules: bypass.join(','),
      })
    } else if (c.mode === 'none') {
      await session.defaultSession.setProxy({ mode: 'direct' })
    } else {
      await session.defaultSession.setProxy({ mode: 'system' })
    }
  } catch { /* previous proxy setting stays in effect */ }
}

/**
 * In-process forwarding proxy every child process is pointed at. Started
 * once at boot; the routing decision is read from the stored config per
 * request, so a config change needs no respawn.
 */
let forwarder = null
async function startForwarder() {
  if (forwarder) return forwarder
  forwarder = await createForwarder({
    getConfig: readProxyConfig,
    resolveSystem: resolveSystemProxy,
    onError: (err) => console.error('proxy forwarder:', String((err && err.message) || err)),
  })
  if (!forwarder.port) console.error('proxy forwarder could not listen; children use direct connections')
  return forwarder
}
/**
 * Apply the app's proxy environment to a child env: inherited HTTP_PROXY and
 * related vars are stripped, then the forwarder endpoint is written in.
 * Mutates and returns env.
 */
function withProxyEnv(env) {
  return applyProxyEnv(env, forwarder ? forwarder.port : 0, readProxyConfig())
}

function mcpStorePath() { return path.join(app.getPath('userData'), 'mcp-servers.json') }
function profilePatchPath() { return path.join(app.getPath('home'), '.dsh', 'profiles', 'web', 'cordis.patch.yml') }

function readMcpServers() {
  try { return JSON.parse(fs.readFileSync(mcpStorePath(), 'utf8')) } catch { return [] }
}

// ---- common settings (curated built-in plugin config overrides) ----
// Registry lives in runtime.js (COMMON_SETTINGS); values persist in userData
// and are applied to the profile patch layer as a second managed block
// ('settings'): same mechanism and hot reload as the MCP block, regenerated
// together on quarantine self-heal.
function settingsStorePath() { return path.join(app.getPath('userData'), 'common-settings.json') }
function readCommonSettings() {
  try { return JSON.parse(fs.readFileSync(settingsStorePath(), 'utf8')) } catch { return {} }
}
function applySettingsToProfile(values) {
  const file = profilePatchPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { text = '[]\n' }
  fs.writeFileSync(file, upsertManagedBlock(text, 'settings', buildSettingsBlock(values)))
}

/** Apply the GUI-managed MCP servers into the profile patch layer. */
function applyMcpToProfile(servers) {
  const file = profilePatchPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { text = '[]\n' }
  fs.writeFileSync(file, upsertManagedBlock(text, 'mcp', buildMcpBlock(servers)))
  // remove the pre-0.1.3 launcher overlay
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
    if (s.cwd !== undefined && s.cwd !== '' && !noCtl(s.cwd)) return `"${s.serverName}" 的工作目录无效`
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

function listSkills() { return listSkillStore(fs, path, skillsDir()) }

/**
 * Windows: the bundled dsh's native folder dialog (a koffi child process
 * re-spawning process.execPath) does not run under the Electron-as-node
 * packaging; the in-app "browse" directory picker is pinned via a patch overlay.
 */
function pickerPatchArgs() {
  if (process.platform !== 'win32') return []
  const p = path.join(app.getPath('userData'), 'win-picker-patch.yml')
  // The "browse" interaction is a pair: host backend + client UI surface
  // (what dsh-host-directory-picker-auto mounts when it resolves to browse).
  // Both must be composed; the UI has no dialog to open otherwise.
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

function proxyShimLines(win) {
  // Shims do not inherit the machine's HTTP_PROXY; CLI and GUI route the
  // same way. The forwarder endpoint is valid only while the app runs (shims
  // are rewritten on every launch); with the app closed the shim still
  // clears the inherited vars.
  const lines = []
  for (const key of PROXY_ENV_KEYS) {
    for (const k of [key, key.toLowerCase()]) lines.push(win ? `set "${k}="` : `unset ${k}`)
  }
  const env = applyProxyEnv({}, forwarder ? forwarder.port : 0, readProxyConfig())
  for (const [k, v] of Object.entries(env)) lines.push(win ? `set "${k}=${v}"` : `export ${k}="${v}"`)
  return lines
}

/**
 * Write `dsh` and `pnpm` command-line launchers into userData/bin. Both run
 * on Electron's embedded Node (ELECTRON_RUN_AS_NODE), so `dsh plugin add`
 * works with no Node.js/pnpm installed on the machine. Returns the bin dir,
 * which is also prepended to the server's PATH so dsh finds pnpm.
 */
/**
 * JavaScript entry of the bundled pnpm (cjs preferred, mjs accepted); empty
 * string when absent. pnpm ships only with the bundled runtime. stage pins
 * the 11 line: from 12 the npm package is a placeholder script and the
 * native binary is downloaded by postinstall.
 */
function pnpmEntry() {
  const bin = path.join(bundledDshDir(), 'tools', 'node_modules', 'pnpm', 'bin')
  for (const f of ['pnpm.cjs', 'pnpm.mjs']) {
    const p = path.join(bin, f)
    if (fs.existsSync(p)) return p
  }
  return ''
}

function writeCliLaunchers() {
  const binDir = path.join(app.getPath('userData'), 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const entry = dshEntry()
  // pnpm ships with the bundled runtime only (an upgraded core runtime under
  // userData/runtimes has no tools/ directory).
  const pnpmCjs = pnpmEntry()
  const exe = process.execPath
  const npxShim = path.join(binDir, 'npx-shim.js')
  fs.writeFileSync(npxShim, NPX_SHIM_SOURCE)
  const uvDir = path.join(bundledDshDir(), 'tools', 'uv')
  const uvExe = fs.existsSync(path.join(uvDir, process.platform === 'win32' ? 'uv.exe' : 'uv'))
  if (process.platform === 'win32') {
    const winProxy = proxyShimLines(true).join('\r\n') + '\r\n'
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\n${winProxy}"${exe}" --expose-internals "${entry}" %*\r\n`)
    // `node` shim: dependency install scripts (`node xxx.js`) need a node on
    // PATH; machines without Node.js get Electron's embedded one.
    fs.writeFileSync(path.join(binDir, 'node.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${winProxy}"${exe}" %*\r\n`)
    if (fs.existsSync(pnpmCjs)) {
      // --config.minimum-release-age=0: the bundled pnpm gates new releases
      // for 24h by default; the dsh ecosystem ships daily rc releases, and
      // pnpm's remove path has no handler for the resulting violations
      // (ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED).
      // --config.auto-install-peers=false: with auto-install on (pnpm's
      // default when the profile workspace file does not set it), any add
      // re-resolves the peers of every installed plugin; the range
      // intersection drops prerelease qualifiers (^0.1.0-rc.8 ∩ * →
      // >=0.1.0 <0.2.0) and the dsh core publishes prereleases only, so a
      // preset with @deepseek-ai peers (better-sidebar) fails every later
      // install with ERR_PNPM_NO_MATCHING_VERSION. Peers are provided by the
      // app closure at runtime.
      // env/npmrc channels are ignored for both keys; the CLI flag before
      // the subcommand is the one channel that works. dsh resolves pnpm via
      // PATH, i.e. through this shim.
      fs.writeFileSync(path.join(binDir, 'pnpm.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\n${winProxy}"${exe}" "${pnpmCjs}" --config.minimum-release-age=0 --config.auto-install-peers=false %*\r\n`)
      // `npx`: routed to `pnpm dlx` through a small argv filter (npx's
      // -y/--yes has no pnpm equivalent), so Node-based stdio MCP servers run
      // on the embedded Node with nothing installed. cross-spawn (the MCP
      // SDK's spawner) resolves .cmd shims on PATH.
      fs.writeFileSync(path.join(binDir, 'npx.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\nset "DSHDESKTOP_PNPM_CJS=${pnpmCjs}"\r\n${winProxy}"${exe}" "${npxShim}" %*\r\n`)
    }
    if (uvExe) {
      // `uvx`/`uv`: bundled Python-side runtime for `uvx <pkg>` MCP servers.
      // Caches and interpreters live under userData; env already set by the
      // user wins (`if not defined`), e.g. UV_PYTHON_INSTALL_MIRROR.
      for (const name of ['uvx', 'uv']) {
        fs.writeFileSync(path.join(binDir, `${name}.cmd`),
          `@echo off\r\nset "PATH=${binDir};%PATH%"\r\n${uvEnvLines(true).join('\r\n')}\r\n${winProxy}"${path.join(uvDir, name + '.exe')}" %*\r\n`)
      }
    }
  } else {
    const shProxy = proxyShimLines(false).join('\n') + '\n'
    fs.writeFileSync(path.join(binDir, 'dsh'),
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport PATH="${binDir}:$PATH"\n${shProxy}exec "${exe}" --expose-internals "${entry}" "$@"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(binDir, 'node'),
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\n${shProxy}exec "${exe}" "$@"\n`, { mode: 0o755 })
    if (fs.existsSync(pnpmCjs)) {
      // flags: see the .cmd twin above
      fs.writeFileSync(path.join(binDir, 'pnpm'),
        `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport PATH="${binDir}:$PATH"\n${shProxy}exec "${exe}" "${pnpmCjs}" --config.minimum-release-age=0 --config.auto-install-peers=false "$@"\n`, { mode: 0o755 })
      // see the .cmd twin above
      fs.writeFileSync(path.join(binDir, 'npx'),
        `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport PATH="${binDir}:$PATH"\nexport DSHDESKTOP_PNPM_CJS="${pnpmCjs}"\n${shProxy}exec "${exe}" "${npxShim}" "$@"\n`, { mode: 0o755 })
    }
    if (uvExe) {
      for (const name of ['uvx', 'uv']) {
        fs.writeFileSync(path.join(binDir, name),
          `#!/bin/sh\nexport PATH="${binDir}:$PATH"\n${uvEnvLines(false).join('\n')}\n${shProxy}exec "${path.join(uvDir, name)}" "$@"\n`, { mode: 0o755 })
      }
    }
  }
  return binDir
}

/**
 * Environment for the bundled uv: cache, downloaded interpreters and tool
 * venvs live under userData (removed with the app; nothing under ~/.local).
 * A value the user already exported wins.
 */
function uvEnvLines(win) {
  const base = path.join(app.getPath('userData'), 'uv')
  const vars = {
    UV_CACHE_DIR: path.join(base, 'cache'),
    UV_PYTHON_INSTALL_DIR: path.join(base, 'python'),
    UV_TOOL_DIR: path.join(base, 'tools'),
    UV_TOOL_BIN_DIR: path.join(base, 'bin'),
    // OS certificate store instead of uv's bundled roots: matches the proxy
    // page's "trust the system store" default. Behind TLS-intercepting
    // proxies the bundled roots time out decoding the response instead of
    // failing on the certificate.
    UV_NATIVE_TLS: '1',
  }
  return Object.entries(vars).map(([k, v]) => win
    ? `if not defined ${k} set "${k}=${v}"`
    : `[ -n "\${${k}:-}" ] || export ${k}="${v}"`)
}

/**
 * The npx → pnpm dlx argv filter, written next to the launchers (userData is
 * outside the asar, so the embedded Node can load it). npx-only flags are
 * dropped; `--package=<spec>` / `-p <spec>` become pnpm dlx's `--package`.
 */
const NPX_SHIM_SOURCE = `'use strict'
const { spawn } = require('child_process')
const pnpmCjs = process.env.DSHDESKTOP_PNPM_CJS
const args = process.argv.slice(2)
const out = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '-y' || a === '--yes' || a === '-q' || a === '--quiet' || a === '--no-install' || a === '--ignore-existing') continue
  if (a === '-p' || a === '--package') { out.push('--package', args[++i]); continue }
  if (a.startsWith('--package=')) { out.push(a); continue }
  out.push(a)
}
const child = spawn(process.execPath, [pnpmCjs, '--config.minimum-release-age=0', '--config.auto-install-peers=false', 'dlx', ...out], { stdio: 'inherit', windowsHide: true })
child.on('exit', (code, signal) => process.exit(code === null ? 1 : code))
child.on('error', (err) => { console.error('npx shim: ' + err.message); process.exit(127) })
// dsh stops a stdio server by signalling this process; the signal is
// forwarded so pnpm's child goes down with the shim.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig) } catch {} })
`

/**
 * Open an OS terminal window with the bundled dsh/pnpm CLI on PATH, so
 * users can run `dsh …` immediately without any manual setup.
 */
function openCliTerminal() {
  const binDir = writeCliLaunchers()
  if (process.platform === 'win32') {
    // A batch file run via ShellExecute (openPath) allocates a visible
    // console; spawn('cmd.exe', …, { detached }) does not (libuv maps
    // detached to DETACHED_PROCESS). Batch is parsed in the console
    // codepage: chcp 65001 precedes any non-ASCII line (file saved as UTF-8).
    const cmdFile = path.join(binDir, 'DeepSeek Harness CLI.cmd')
    fs.writeFileSync(cmdFile, [
      '@echo off',
      'chcp 65001 >nul',
      'title DeepSeek Harness CLI',
      `set "PATH=${binDir};%PATH%"`,
      ...proxyShimLines(true),
      'echo dsh 命令行已就绪：可直接使用 dsh / pnpm 命令',
      'echo 例如：dsh plugin --profile web add ^<插件包^>',
      'cmd /K',
      '',
    ].join('\r\n'))
    shell.openPath(cmdFile).then((err) => {
      if (err) dialog.showErrorBox('无法打开命令行窗口', `${err}\n\n可手动运行该文件：\n${cmdFile}`)
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
      ...proxyShimLines(false),
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
 * Preset plugin bundles (full flavor): plugins-full.json → stage-dsh.mjs →
 * preset-plugins.json inside the runtime. Being a dependency of the bundled
 * dsh app makes a package resolvable from the profile (dsh symlinks the app
 * closure into profiles/node_modules); activation requires the profile
 * manifest to list it in dependencies + dsh.profile.bundles. Activation is
 * handled by syncPresetPlugins.
 */
/** Does <base>/<name> hold a loadable copy of the package (entry file exists)? */
function pkgUsableAt(base, name) {
  const pkgDir = path.join(base, ...name.split('/'))
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const entry = pj.main || (typeof pj.exports === 'string' ? pj.exports : null) || 'index.js'
    return fs.existsSync(path.join(pkgDir, entry))
  } catch { return false }
}

/**
 * Is <base>/<name> an intact package for bundle/dependency purposes? Weaker
 * than pkgUsableAt: a meta bundle package (manifest + cordis.patch.yml, no
 * JS entry, e.g. dsh-skins) is valid. Intact = valid manifest and every
 * declared artifact (entry, bundle patch) present; a package declaring
 * nothing needs its implicit index.js. `dsh plugin remove` remnants that
 * keep package.json but lose the code fail this check.
 */
function pkgIntactAt(base, name) {
  const pkgDir = path.join(base, ...name.split('/'))
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const entry = pj.main || (typeof pj.exports === 'string' ? pj.exports : null)
    const bundlePatch = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch
    if (entry && !fs.existsSync(path.join(pkgDir, entry))) return false
    if (bundlePatch && !fs.existsSync(path.join(pkgDir, bundlePatch))) return false
    if (!entry && !bundlePatch) return fs.existsSync(path.join(pkgDir, 'index.js')) || !!pj.dsh
    return true
  } catch { return false }
}

/**
 * The loader persists plugin entries into the profile's cordis.yml (e.g. a
 * skin picked in the skin center is pnpm-installed and recorded). An entry
 * whose package no longer resolves (flavor switch, broken local install)
 * makes dsh refuse to boot (ERR_MODULE_NOT_FOUND during the plugin tree
 * load). User config is not edited; a no-op stub package is placed in the
 * profile's node_modules so the entry loads and does nothing. The stub
 * carries a marker file and retires itself once the active runtime provides
 * the real package; a real pnpm (re)install overwrites it.
 */
function healUnresolvableEntries() {
  try {
    const profileDir = path.join(app.getPath('home'), '.dsh', 'profiles', 'web')
    const localNm = path.join(profileDir, 'node_modules')
    const runtimeNm = path.join((activeRuntime && activeRuntime.dir) || bundledDshDir(), 'node_modules')
    const candidates = new Set()
    for (const file of ['cordis.yml', 'cordis.patch.yml']) {
      let text = ''
      try { text = fs.readFileSync(path.join(profileDir, file), 'utf8') } catch { continue }
      // Entry lines look like `name: "@scope/pkg"` (quotes optional),
      // restricted to the npm name grammar. A non-package `name:` value
      // fails the resolvability checks or yields an unused stub dir.
      for (const m of text.matchAll(/^[\s-]*name:\s*["']?((?:@[a-z0-9~][\w.-]*\/)?[a-z0-9~][\w.-]*)["']?\s*$/gim)) {
        candidates.add(m[1])
      }
    }
    // Retire stubs first, by scanning for marker files rather than config
    // references: dsh rewrites cordis.yml and may drop the entry behind a
    // stub, and an orphaned stub still shadows the real package.
    try {
      const names = []
      for (const e of fs.readdirSync(localNm)) {
        if (e.startsWith('@')) {
          try { for (const s of fs.readdirSync(path.join(localNm, e))) names.push(`${e}/${s}`) } catch { /* ignore */ }
        } else if (e !== '.pnpm' && e !== '.bin') names.push(e)
      }
      for (const name of names) {
        const dir = path.join(localNm, ...name.split('/'))
        if (fs.existsSync(path.join(dir, '.dsh-desktop-stub')) && pkgUsableAt(runtimeNm, name)) {
          fs.rmSync(dir, { recursive: true, force: true })
          console.log(`retired stub of ${name}: runtime provides it again`)
        }
      }
    } catch { /* no node_modules yet */ }
    for (const name of candidates) {
      if (pkgUsableAt(runtimeNm, name)) continue // resolvable from runtime closure
      if (pkgUsableAt(localNm, name)) continue // real local install (or an existing stub)
      writeStubPackage(localNm, name)
      console.log(`stubbed unresolvable plugin entry ${name}`)
    }
  } catch (err) {
    console.error('entry healing failed (non-fatal):', err)
  }
}

/** Replace whatever is at localNm/<name> with a no-op stub package. */
function writeStubPackage(localNm, name) {
  const stubDir = path.join(localNm, ...name.split('/'))
  try { fs.rmSync(stubDir, { recursive: true, force: true }) } catch { /* dangling link etc. */ }
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name, version: '0.0.1', main: 'index.js' }, null, 2))
  fs.writeFileSync(path.join(stubDir, 'index.js'), [
    "'use strict'",
    `console.warn('dsh-desktop: 插件 ${name} 不在当前安装包中，已用空实现替代；重新安装该插件或安装含该插件的版本可恢复')`,
    `module.exports = { name: ${JSON.stringify(name)}, apply() {} }`,
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(stubDir, '.dsh-desktop-stub'), '')
}

/**
 * Reactive boot healing, the backstop behind the proactive passes: parse a
 * fatal dsh boot error and repair the known classes of profile damage:
 * config entries referencing packages that no longer resolve (link the
 * runtime's copy in, or stub), broken local leftovers shadowing the closure,
 * and profile bundles nothing resolves (withdraw). The error message is
 * authoritative; proactive scans do not enumerate every place dsh persists
 * entries. Returns true when something was repaired; the caller retries.
 */
const repairedOverlays = new Set()
const repairedCredentials = new Set()
function applyBootErrorFix(errText) {
  try {
    let fixed = false
    // A failing shim injection aborts every Node child before dsh runs. When
    // the boot error blames the shim, the injection is disabled for this run.
    if (/win-spawn-shim/i.test(errText) && spawnShimPath !== '') {
      console.error('boot failed on win-spawn-shim injection; disabled for this run')
      spawnShimPath = '' // nodePreloadArgs/withNodePreloadEnv become no-ops
      return true
    }
    // A newer dsh forward-migrates ~/.dsh/.credentials.yaml (`version`
    // becomes a number); this core's parser refuses to boot: `the value for
    // "version" in <path> must be a string`. Step 1 quotes the number in
    // place (keeps logins when the schema is otherwise accepted). Step 2,
    // when the same file fails again, quarantines it; the user logs in
    // again. The retry loop drives both steps in order.
    const credM = /the value for "version" in ([^\n]+?) must be a string/.exec(errText)
    if (credM && credM[1].includes('.credentials')) {
      const file = credM[1].trim()
      try {
        if (!repairedCredentials.has(file)) {
          repairedCredentials.add(file)
          const raw = fs.readFileSync(file, 'utf8')
          const coerced = raw.replace(/^(\s*version:\s*)([0-9]+(?:\.[0-9]+)*)\s*$/m, '$1"$2"')
          if (coerced !== raw) {
            fs.writeFileSync(`${file}.bak`, raw)
            fs.writeFileSync(file, coerced)
            console.log(`boot heal: quoted numeric version in ${file} (backup .bak)`)
            return true
          }
        }
        fs.renameSync(file, `${file}.broken-${Date.now()}`)
        console.log(`boot heal: quarantined ${file}; 凭据需重新登录`)
        return true
      } catch (err2) { console.error('credentials heal failed:', err2) }
    }
    const profileDir = path.join(app.getPath('home'), '.dsh', 'profiles', 'web')
    const localNm = path.join(profileDir, 'node_modules')
    const runtimeNm = path.join((activeRuntime && activeRuntime.dir) || bundledDshDir(), 'node_modules')
    const names = new Set()
    // bare specifier form: Cannot find package '@scope/pkg' imported from …
    for (const m of errText.matchAll(/Cannot find (?:package|module) '((?:@[a-z0-9~][\w.-]*\/)?[a-z0-9~][\w.-]*)'/g)) names.add(m[1])
    // path form: Cannot find package '…/node_modules/@scope/pkg/…' (a broken
    // local copy shadowing the closure)
    for (const m of errText.matchAll(/Cannot find (?:package|module) '[^']*[/\\]node_modules[/\\](@[^/\\']+[/\\][^/\\']+|[^@][^/\\']*)/g)) {
      names.add(m[1].replace(/\\/g, '/'))
    }
    for (const name of names) {
      const localDir = path.join(localNm, ...name.split('/'))
      let stat = null
      try { stat = fs.lstatSync(localDir) } catch { /* absent */ }
      if (stat && !pkgUsableAt(localNm, name) && !pkgIntactAt(localNm, name)) {
        fs.rmSync(localDir, { recursive: true, force: true })
        console.log(`boot heal: cleared broken ${name} from profile node_modules`)
        fixed = true
        stat = null
      }
      if (!pkgUsableAt(localNm, name)) {
        if (pkgUsableAt(runtimeNm, name)) {
          // runtime ships it but the profile did not resolve it: link the
          // runtime copy in
          try { fs.rmSync(localDir, { recursive: true, force: true }) } catch { /* ignore */ }
          fs.mkdirSync(path.dirname(localDir), { recursive: true })
          fs.symlinkSync(path.join(runtimeNm, ...name.split('/')), localDir, 'junction')
          console.log(`boot heal: linked ${name} from the bundled runtime`)
        } else {
          writeStubPackage(localNm, name)
          console.log(`boot heal: stubbed unresolvable ${name}`)
        }
        fixed = true
      }
    }
    // duplicate loader entry id: a preset bundle's insert collides with an
    // entry already in the user's config (e.g. a skin installed via the skin
    // center before it became a preset). The preset bundle is withdrawn; the
    // user's own entry keeps the feature, resolving against the carried
    // package in the runtime closure.
    const dupIds = [...errText.matchAll(/duplicate loader entry id: ([^\s'"]+)/g)].map((m) => m[1])
    if (dupIds.length > 0) {
      let presets = {}
      try { presets = JSON.parse(fs.readFileSync(path.join(bundledDshDir(), 'preset-plugins.json'), 'utf8')).seed || {} } catch { /* minimal */ }
      const pkgPath = path.join(profileDir, 'package.json')
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
      let wrote = false
      for (const name of Object.keys(presets)) {
        if (!bundles.includes(name)) continue
        let patchText = ''
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(runtimeNm, ...name.split('/'), 'package.json'), 'utf8'))
          const rel = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch
          if (rel) patchText = fs.readFileSync(path.join(runtimeNm, ...name.split('/'), rel), 'utf8')
        } catch { continue }
        if (dupIds.some((id) => new RegExp(`id:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm').test(patchText))) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((x) => x !== name)
          if (pkg.dependencies) delete pkg.dependencies[name]
          // excluded for this app version only: dsh's config rewrites often
          // drop the colliding user entry, and the next installed version
          // retries
          addPresetExclusion(name)
          console.log(`boot heal: excluded preset ${name} for this version (duplicate entry id with user config)`)
          wrote = true
          fixed = true
        }
      }
      if (wrote) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    }
    // Unparseable overlay/config file ("dsh: failed to parse overlay <path>:
    // YAMLException: …", e.g. a row corrupted by a plugin's config writer).
    // dsh refuses to boot; the file is quarantined (renamed, content kept
    // for manual salvage). When it is the profile patch holding the managed
    // blocks, those are regenerated from the desktop's own store.
    const dshHome = path.join(app.getPath('home'), '.dsh')
    const badConfigFiles = new Set()
    // YAML syntax errors: "dsh: failed to parse <label> <path>: YAMLException…"
    for (const m of errText.matchAll(/failed to parse \w+ (.+?\.ya?ml)\b/g)) badConfigFiles.add(m[1])
    // wrong top-level type (a map, or an empty file parsing to null):
    // "dsh: <label> <path> must be a top-level YAML array of loader patch entries"
    for (const m of errText.matchAll(/dsh: \w+ (.+?\.ya?ml) must be a top-level YAML array/g)) badConfigFiles.add(m[1])
    for (const file of badConfigFiles) {
      if (!file.startsWith(dshHome)) continue // only files under user dsh data
      if (!fs.existsSync(file)) continue
      // First attempt, once per file per run: the common corruption is the
      // default flow empty list `[]` coexisting with block entries appended
      // by plugin config writers (invalid YAML). Dropping the standalone `[]`
      // line usually restores validity and keeps the user's entries. A
      // backup is kept either way.
      if (!repairedOverlays.has(file)) {
        repairedOverlays.add(file)
        try {
          const text = fs.readFileSync(file, 'utf8')
          const lines = text.split(/\r?\n/)
          const meaningful = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
          if (meaningful.some((l) => l.trim() === '[]') && meaningful.length > 1) {
            fs.copyFileSync(file, `${file}.bak-${Date.now()}`)
            fs.writeFileSync(file, lines.filter((l) => l.trim() !== '[]').join('\n'))
            console.log(`boot heal: removed stray [] line from ${file} (backup kept)`)
            fixed = true
            continue
          }
        } catch { /* fall through to quarantine */ }
      }
      const quarantined = `${file}.broken-${Date.now()}`
      try {
        fs.renameSync(file, quarantined)
        console.log(`boot heal: quarantined unparseable config ${file} -> ${quarantined}`)
        fixed = true
        if (path.basename(file) === 'cordis.patch.yml' && path.dirname(file) === path.join(dshHome, 'profiles', 'web')) {
          try {
            applyMcpToProfile(readMcpServers())
            applySettingsToProfile(readCommonSettings())
            console.log('boot heal: regenerated MCP + settings managed blocks from the desktop store')
          } catch (err) { console.error('managed block regeneration failed:', err) }
        }
      } catch (err) { console.error(`quarantine of ${file} failed:`, err) }
    }
    // unresolvable profile bundle: dsh names it verbatim
    const bundleNames = [...errText.matchAll(/cannot resolve profile bundle "([^"]+)"/g)].map((m) => m[1])
    if (bundleNames.length > 0) {
      const pkgPath = path.join(profileDir, 'package.json')
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
      for (const name of bundleNames) {
        if (bundles.includes(name) || (pkg.dependencies && pkg.dependencies[name])) {
          pkg.dsh.profile.bundles = bundles.filter((x) => x !== name)
          if (pkg.dependencies) delete pkg.dependencies[name]
          console.log(`boot heal: withdrew unresolvable bundle ${name}`)
          fixed = true
        }
      }
      if (fixed) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
      // keep the managed list consistent (sync would repair it anyway)
      try {
        const managedPath = path.join(app.getPath('userData'), 'managed-presets.json')
        const managed = JSON.parse(fs.readFileSync(managedPath, 'utf8'))
        fs.writeFileSync(managedPath, JSON.stringify(managed.filter((n) => !bundleNames.includes(n)), null, 2))
      } catch { /* no list */ }
    }
    return fixed
  } catch (err) {
    console.error('boot heal failed:', err)
    return false
  }
}

/** Per-app-version duplicate-id exclusions: a preset whose entry id
 * collides with an entry already in the user's config is excluded from
 * the sync for this app version only. Every new install retries once, so
 * a collision that has since disappeared (dsh rewrites its config files)
 * heals itself. */
function presetExclusionsPath() { return path.join(app.getPath('userData'), 'preset-exclusions.json') }
function readPresetExclusions() {
  try {
    const j = JSON.parse(fs.readFileSync(presetExclusionsPath(), 'utf8'))
    if (j.version === app.getVersion() && Array.isArray(j.names)) return j.names
  } catch { /* none for this version */ }
  return []
}
function addPresetExclusion(name) {
  const names = readPresetExclusions()
  if (!names.includes(name)) names.push(name)
  fs.writeFileSync(presetExclusionsPath(), JSON.stringify({ version: app.getVersion(), names }, null, 2))
}

/**
 * Manual resync: clear this version's duplicate-id exclusions and stale
 * preset stubs, then relaunch; the boot sync re-applies every preset the
 * build ships.
 */
async function restorePresetPlugins() {
  let presets = {}
  try { presets = JSON.parse(fs.readFileSync(path.join(bundledDshDir(), 'preset-plugins.json'), 'utf8')).seed || {} } catch { /* minimal */ }
  const names = Object.keys(presets)
  if (names.length === 0) {
    await dialog.showMessageBox({
      type: 'info', title: 'DeepSeek Harness',
      message: '当前版本没有预置插件', detail: '此安装包为精简版；预置插件随 full 版分发。', buttons: ['好'],
    })
    return
  }
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'DeepSeek Harness',
    message: '重新同步本版本的预置插件？',
    detail: `以下插件将全部挂载：\n${names.join('\n')}\n\n需要重启应用。`,
    buttons: ['同步并重启', '取消'], defaultId: 0, cancelId: 1,
  })
  if (response !== 0) return
  try {
    fs.rmSync(presetExclusionsPath(), { force: true })
    const localNm = path.join(app.getPath('home'), '.dsh', 'profiles', 'web', 'node_modules')
    for (const name of names) {
      const dir = path.join(localNm, ...name.split('/'))
      if (fs.existsSync(path.join(dir, '.dsh-desktop-stub'))) fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('preset resync failed:', err)
  }
  app.relaunch()
  app.quit()
}

/**
 * Declarative preset sync, run before every server boot in every flavor:
 * the preset portion of the user profile is owned by the installed build
 * and is made to match preset-plugins.json exactly (minus this version's
 * duplicate-id exclusions and anything the active runtime cannot resolve).
 * userData/managed-presets.json records only what is currently managed, so
 * a flavor switch or trimmed manifest knows which entries to remove;
 * user-installed plugins are never touched. Removing a preset via the GUI
 * does not persist across launches; the minimal build ships no presets.
 */
function syncPresetPlugins() {
  try {
    let manifest = {}
    try { manifest = JSON.parse(fs.readFileSync(path.join(bundledDshDir(), 'preset-plugins.json'), 'utf8')).seed || {} } catch { /* minimal flavor */ }
    const managedPath = path.join(app.getPath('userData'), 'managed-presets.json')
    let managed = []
    try { managed = JSON.parse(fs.readFileSync(managedPath, 'utf8')) } catch {
      // migrate from the old seeding marker, then retire it
      try {
        managed = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'seeded-presets.json'), 'utf8'))
        fs.rmSync(path.join(app.getPath('userData'), 'seeded-presets.json'), { force: true })
      } catch { /* fresh */ }
    }
    if (Object.keys(manifest).length === 0 && managed.length === 0) return
    const profileDir = path.join(app.getPath('home'), '.dsh', 'profiles', 'web')
    const localNm = path.join(profileDir, 'node_modules')
    const runtimeNm = path.join((activeRuntime && activeRuntime.dir) || bundledDshDir(), 'node_modules')
    const resolvable = (name) => pkgIntactAt(localNm, name) || pkgIntactAt(runtimeNm, name)

    // Leftovers of preset packages in the profile's own node_modules shadow
    // the closure: broken ones crash boot, stale-version ones keep serving
    // the old plugin after an overwrite install. Both are cleared;
    // resolution then falls back to the closure link onto the bundled copy.
    for (const name of new Set([...Object.keys(manifest), ...managed])) {
      const localDir = path.join(localNm, ...name.split('/'))
      try {
        if (!fs.existsSync(localDir)) continue
        if (!pkgIntactAt(localNm, name)) {
          fs.rmSync(localDir, { recursive: true, force: true })
          console.log(`cleared broken leftover of ${name} from profile node_modules`)
          continue
        }
        const want = manifest[name]
        if (!want) continue
        let got = null
        try { got = JSON.parse(fs.readFileSync(path.join(localDir, 'package.json'), 'utf8')).version } catch { /* unreadable: left to pkgIntactAt */ }
        if (got && got !== want) {
          fs.rmSync(localDir, { recursive: true, force: true })
          console.log(`cleared stale ${name}@${got} from profile node_modules (preset is ${want})`)
        }
      } catch { /* best-effort */ }
    }

    const exclusions = readPresetExclusions()
    const desired = Object.keys(manifest).filter((n) => !exclusions.includes(n) && resolvable(n))
    for (const name of Object.keys(manifest)) {
      if (exclusions.includes(name)) console.log(`preset ${name} excluded for this version (entry-id conflict)`)
      else if (!resolvable(name)) console.log(`preset ${name} not resolvable by active runtime; skipped`)
    }

    const pkgPath = path.join(profileDir, 'package.json')
    const pkg = fs.existsSync(pkgPath)
      ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      : { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
    pkg.dependencies ??= {}
    pkg.dsh ??= {}
    pkg.dsh.profile ??= {}
    pkg.dsh.profile.bundles ??= []
    let changed = false

    // Remove what we manage but no longer want (flavor switch, trimmed
    // manifest, unresolvable, excluded).
    for (const name of managed) {
      if (desired.includes(name)) continue
      if (pkg.dsh.profile.bundles.includes(name) || pkg.dependencies[name]) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((x) => x !== name)
        delete pkg.dependencies[name]
        console.log(`preset sync: removed ${name}`)
        changed = true
      }
    }
    // Ensure every desired preset is present at the manifest version: the
    // profile pin follows the installed build on every overwrite install.
    // Another version of a preset is installed by hand on the minimal build.
    for (const name of desired) {
      if (pkg.dependencies[name] !== manifest[name]) {
        if (pkg.dependencies[name]) console.log(`preset sync: ${name} ${pkg.dependencies[name]} -> ${manifest[name]}`)
        else console.log(`preset sync: applied ${name}`)
        pkg.dependencies[name] = manifest[name]
        changed = true
      }
      if (!pkg.dsh.profile.bundles.includes(name)) {
        pkg.dsh.profile.bundles.push(name)
        changed = true
      }
    }

    if (changed) {
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    }
    fs.writeFileSync(managedPath, JSON.stringify(desired, null, 2))
  } catch (err) {
    console.error('preset sync failed (non-fatal):', err)
  }
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const entry = dshEntry()
    if (!fs.existsSync(entry)) {
      reject(new Error(`bundled dsh not found at ${entry}`))
      return
    }
    syncPresetPlugins()
    healUnresolvableEntries()

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    // Electron-specific vars must not leak into the node child.
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    // Expose the bundled dsh/pnpm CLI launchers to the server and its
    // children (dsh's plugin command locates pnpm via PATH).
    try {
      const binDir = writeCliLaunchers()
      // case-insensitive: on Windows the spread key is "Path"; writing
      // "PATH" leaves the child with PATH = binDir only
      prependEnvPath(env, binDir, path.delimiter)
    } catch { /* CLI launchers are best-effort */ }
    withProxyEnv(env)
    withNodePreloadEnv(env)
    // win-spawn-shim.js gives the server an invisible host console: the
    // Windows sandbox spawns pwsh via CreateProcessAsUserW without a console
    // flag (hidden-console children die under the restricted token), and a
    // sandboxed command with no console to inherit opens a visible one.
    // Server only; CLI runs own a real terminal.
    env.DSHDESKTOP_CONSOLE_HOST = '1'
    // Per-process console-attach trace (server + every runner); fresh per
    // app launch.
    try {
      const dbgFile = path.join(app.getPath('userData'), 'console-debug.log')
      if (process.platform === 'win32') fs.writeFileSync(dbgFile, '')
      env.DSHDESKTOP_CONSOLE_DEBUG_FILE = dbgFile
    } catch { /* diagnostics are best-effort */ }

    // --no-open: dsh web (rc8+) opens the OS default browser by default; the
    // desktop shell is the browser. rc7 does not know the flag; this argv
    // ships with the rc8 lock.
    // Order: the dsh launcher consumes only its own leading flags
    // (--profile/--patch) and hands everything from the first unknown token
    // to the app's commander, so --patch precedes app flags like
    // --no-open/--port.
    serverProc = spawn(process.execPath, ['--expose-internals', ...nodePreloadArgs(), entry, 'web', ...desktopPatchArgs(), ...pickerPatchArgs(), '--no-open', '--port', '0'], {
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

    const thisProc = serverProc
    serverProc.on('exit', (code) => {
      // a late exit of an already-replaced process leaves the current one
      // alone and shows no dialog
      if (serverProc === thisProc) serverProc = null
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`dsh server exited early (code ${code}).\nOutput:\n${tail.slice(-2000)}`))
      } else if (!quitting && !restartingServer && serverProc === null) {
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
        { type: 'separator' },
        { label: '重新同步预置插件…', click: () => { restorePresetPlugins() } },
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
async function runDshCli(args) {
  return new Promise((resolve) => {
    const binDir = writeCliLaunchers()
    const child = spawn(process.execPath, ['--expose-internals', ...nodePreloadArgs(), dshEntry(), ...args], {
      env: prependEnvPath(withNodePreloadEnv(withProxyEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '1' })), binDir, path.delimiter),
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
  // Every npm install spec shape is accepted: plain names, @scope/name@range,
  // github:owner/repo#ref, git+https://…, https://….tgz, file:/link: paths.
  // Args go through spawn(argv[]) without a shell; the check rejects
  // whitespace/control characters only.
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
 * everywhere: npm-package-arg parses file:/link: specs as URLs and rejects
 * raw Windows backslashes.
 */
function localSpec(protocol, absPath) {
  let p = path.resolve(absPath)
  if (process.platform === 'win32') p = p.replace(/\\/g, '/')
  return `${protocol}:${p}`
}
/**
 * Install a plugin from local disk. Directory → link: (symlink; edits are
 * picked up on app restart, the plugin manages its own node_modules); .tgz
 * (npm pack output) → file: (copied, deps installed). Picker paths skip the
 * text-spec hygiene check; args go through spawn(argv[]).
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
    return { code: -1, output: `所选目录没有 package.json：\n${target}` }
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
 * Returns { ok, detail }; never throws.
 */
async function testMcpServer(server, extraPath) {
  if (server.transport === 'streamable-http') {
    try {
      const res = await electronNet.fetch(server.url, {
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
      return { ok: res.ok, detail: `HTTP ${res.status}${res.ok ? '，服务可达' : '（服务可达但返回异常，检查路径与认证头）'}` }
    } catch (err) {
      const msg = String(err && (err.cause?.message || err.message) || err)
      let hint = ''
      if (/certificate|SSL|TLS|wrong version number|packet length/i.test(msg)) {
        hint = '（协议可能不匹配，本机/内网服务通常为 http://）'
      } else if (/ECONNREFUSED/.test(msg)) {
        hint = '（端口无服务监听，确认 MCP 服务器已启动）'
      } else if (/timeout|aborted/i.test(msg)) {
        hint = '（连接超时，地址不可达或服务无响应）'
      }
      return { ok: false, detail: `连接失败：${msg} ${hint}` }
    }
  }
  // stdio: spawn the command the way dsh does (PATH with the launchers,
  // proxy env, the entry's own env/cwd), run a real MCP initialize handshake
  // over stdin/stdout, then count tools. Long timeout: `npx -y …` / `uvx …`
  // download on first run.
  return new Promise((resolve) => {
    const env = withProxyEnv({ ...process.env })
    Object.assign(env, server.env || {})
    if (extraPath) prependEnvPath(env, extraPath, path.delimiter)
    const { file, args, shell } = resolveSpawnCommand(server.command, server.args || [], env)
    let child
    try {
      child = spawn(file, args, {
        env, shell,
        cwd: server.cwd && server.cwd.trim() ? server.cwd.trim() : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, detail: `无法启动命令：${String(err && err.message || err)}` })
      return
    }
    let errTail = ''
    let outBuf = ''
    let done = false
    let serverInfo = null
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill() } catch { /* gone */ }
      resolve(r)
    }
    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n') } catch { /* closed */ } }
    child.stderr.on('data', (c) => { errTail = (errTail + c.toString()).slice(-600) })
    child.stdout.on('data', (c) => {
      outBuf += c.toString()
      let nl
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        const line = outBuf.slice(0, nl).trim()
        outBuf = outBuf.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue } // servers may log to stdout before speaking JSON-RPC
        if (msg.id === 1 && msg.result) {
          serverInfo = msg.result.serverInfo || {}
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (msg.id === 1 && msg.error) {
          finish({ ok: false, detail: `服务器拒绝 initialize：${msg.error.message || JSON.stringify(msg.error)}` })
        } else if (msg.id === 2) {
          const n = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools.length : '?'
          const who = serverInfo && serverInfo.name ? `${serverInfo.name}${serverInfo.version ? ' ' + serverInfo.version : ''}` : '服务器'
          finish({ ok: true, detail: `握手成功：${who}，提供 ${n} 个工具` })
        }
      }
    })
    child.on('error', (err) => finish({ ok: false, detail: `无法启动命令：${String(err.message)}（命令不存在或不可执行）` }))
    child.on('exit', (code) => {
      finish({ ok: false, detail: `命令在完成 MCP 握手前退出 (exit ${code})${errTail ? `：${errTail.trim()}` : ''}` })
    })
    const timer = setTimeout(() => {
      finish({ ok: false, detail: `90 秒内未完成 MCP 握手（首次运行需下载依赖，可稍后重试；确认命令是 stdio 型 MCP 服务器）${errTail ? `：${errTail.trim()}` : ''}` })
    }, 90_000)
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-desktop-test', version: '1.0' } },
    })
  })
}

/**
 * Resolve a stdio command the way cross-spawn (the MCP SDK's spawner) does
 * on Windows: a bare name that lands on a .cmd/.bat launcher (the npx/pnpm
 * shims, npm-installed CLIs) runs through cmd.exe. Elsewhere the command
 * runs as given.
 */
function resolveSpawnCommand(command, args, env) {
  if (process.platform !== 'win32' || /[\\/]/.test(command) || /\.(exe|cmd|bat|com)$/i.test(command)) return { file: command, args, shell: false }
  const pathVar = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  const dirs = (pathVar ? env[pathVar] : '').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
      const candidate = path.join(dir, command + ext)
      if (!fs.existsSync(candidate)) continue
      if (ext === '.cmd' || ext === '.bat') {
        // cmd.exe parses the joined line: anything with spaces/metachars is
        // quoted (the launcher path lives under %APPDATA%\DeepSeek Harness\bin).
        const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
        return { file: quote(candidate), args: args.map(quote), shell: true }
      }
      return { file: candidate, args, shell: false }
    }
  }
  return { file: command, args, shell: false }
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
ipcMain.handle('skills:open', async (_event, name) => {
  fs.mkdirSync(skillsDir(), { recursive: true })
  // With a name: open that skill's directory (or the folder holding a flat
  // .md), wherever it lives (enabled or .disabled).
  const n = String(name || '').trim()
  if (n !== '') {
    const d = skillDetail(fs, path, skillsDir(), n)
    if (d) { shell.openPath(d.dir); return }
  }
  shell.openPath(skillsDir())
})
// Detail view: frontmatter summary + file tree; file reads are fenced to the
// skill's own directory, text-only and size-capped (runtime.js).
ipcMain.handle('skills:detail', async (_event, name) => {
  const d = skillDetail(fs, path, skillsDir(), String(name || '').trim())
  return d ? { ok: true, detail: d } : { ok: false, error: '技能不存在' }
})
ipcMain.handle('skills:readFile', async (_event, name, rel) => {
  const d = skillDetail(fs, path, skillsDir(), String(name || '').trim())
  if (!d) return { error: '技能不存在' }
  try {
    return readSkillFile(fs, path, d.dir, String(rel || ''))
  } catch (err) {
    return { error: String(err && err.message || err) }
  }
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

// ---- proxy config ----
ipcMain.handle('proxy:get', async () => readProxyConfig())
ipcMain.handle('proxy:save', async (_event, config) => {
  if (!config || typeof config !== 'object') return { ok: false, error: '数据格式无效' }
  const c = {
    mode: config.mode === 'manual' ? 'manual' : config.mode === 'system' ? 'system' : 'none',
    host: String(config.host || '').trim(),
    port: String(config.port || '').trim(),
    bypass: String(config.bypass || '').trim(),
    auth: !!config.auth,
    login: String(config.login || ''),
    remember: !!config.remember,
    password: String(config.password || ''),
    caPath: String(config.caPath || '').trim(),
    insecure: !!config.insecure,
  }
  if (c.mode === 'manual') {
    if (!/^[\w.-]+$/.test(c.host) || c.host.length > 255) return { ok: false, error: '主机名无效' }
    if (!/^\d{1,5}$/.test(c.port) || Number(c.port) < 1 || Number(c.port) > 65535) return { ok: false, error: '端口需为 1-65535' }
  }
  if (c.bypass.length > 2000 || /[\r\n\0]/.test(c.bypass)) return { ok: false, error: '例外列表格式无效' }
  if (c.login.length > 200 || c.password.length > 200) return { ok: false, error: '用户名或密码过长' }
  if (c.caPath && !fs.existsSync(c.caPath)) return { ok: false, error: 'CA 证书文件不存在' }
  try {
    // password persists only with "remember"; otherwise session-only
    sessionProxyPassword = c.auth && !c.remember ? c.password : ''
    const stored = { ...c, password: c.auth && c.remember ? c.password : '' }
    fs.writeFileSync(proxyStorePath(), JSON.stringify(stored, null, 2))
    applyChromiumProxy(c) // mirror onto the shell window's network layer
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})
ipcMain.handle('proxy:pickCa', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(pluginWindow || mainWindow, {
    title: '选择代理的 CA 证书（PEM 格式）',
    properties: ['openFile'],
    filters: [{ name: '证书文件', extensions: ['pem', 'crt', 'cer'] }],
  })
  if (canceled || filePaths.length === 0) return { canceled: true }
  return { canceled: false, path: filePaths[0] }
})
/**
 * End-to-end proxy probe: start a throwaway forwarder driven by the config
 * in the form (not the saved one), spawn a node child with the env the dsh
 * server gets, and fetch the target through it. The target is editable so
 * an intranet address can be checked alongside an internet one.
 */
ipcMain.handle('proxy:test', async (_event, config, url) => {
  const target = String(url || '').trim() || 'https://registry.npmjs.org/-/ping'
  let u
  try { u = new URL(target) } catch { return { ok: false, detail: '测试地址无效（需以 http:// 或 https:// 开头）' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, detail: '测试地址需以 http:// 或 https:// 开头' }
  const cfg = { ...(config || {}) }
  const probe = await createForwarder({ getConfig: () => cfg, resolveSystem: resolveSystemProxy })
  if (!probe.port) return { ok: false, detail: '本地转发代理无法监听端口' }
  try {
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    const route = await routeFor(cfg, resolveSystemProxy, u.hostname, port, u.protocol.slice(0, -1))
    const label = route ? `${u.hostname} → 代理 ${route.host}:${route.port}，` : `${u.hostname} → 直连，`
    const env = applyProxyEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }, probe.port, cfg)
    const script = `
      const t0 = Date.now()
      fetch(${JSON.stringify(target)}, { signal: AbortSignal.timeout(8000) })
        .then((r) => { console.log(JSON.stringify({ ok: r.ok, status: r.status, ms: Date.now() - t0 })); process.exit(0) })
        .catch((err) => { console.log(JSON.stringify({ ok: false, error: String(err && err.cause && err.cause.message || err.message || err) })); process.exit(0) })
    `
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      child.stdout.on('data', (c) => { out += c.toString() })
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 10_000)
      child.on('exit', () => {
        clearTimeout(timer)
        try {
          const r = JSON.parse(out.trim())
          if (r.ok) resolve({ ok: true, detail: `${label}连通（HTTP ${r.status}，${r.ms}ms）` })
          else resolve({ ok: false, detail: `${label}失败：${r.error || `HTTP ${r.status}`}` })
        } catch {
          resolve({ ok: false, detail: '测试进程异常退出' })
        }
      })
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, detail: String(err) }) })
    })
  } finally {
    probe.close()
  }
})

// ---- common settings ----
ipcMain.handle('settings:get', async () => ({
  options: COMMON_SETTINGS.map(({ key, label, hint, type, def }) => ({ key, label, hint, type, def })),
  groups: groupCommonSettings().map((g) => ({ entryId: g.entryId, label: g.label, hint: g.hint, keys: g.options.map((o) => o.key) })),
  values: readCommonSettings(),
}))
ipcMain.handle('settings:save', async (_event, values) => {
  const err = validateCommonSettings(values)
  if (err) return { ok: false, error: err }
  // keep only known keys with real overrides
  const clean = {}
  for (const opt of COMMON_SETTINGS) {
    const v = values[opt.key]
    if (v !== undefined && v !== null && v !== '') clean[opt.key] = v
  }
  try {
    fs.writeFileSync(settingsStorePath(), JSON.stringify(clean, null, 2))
    applySettingsToProfile(clean)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

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
    // A disabled copy under .disabled/ counts as existing: overwriting
    // removes the disabled copy and installs the new one enabled.
    const exists = (name) => skillExists(fs, path, skillsDir(), name)
    const conflicts = found.filter((s) => exists(s.name)).map((s) => s.name)

    // Same-name skills: one prompt for the whole batch (overwrite, skip, or abort).
    let overwrite = false
    if (conflicts.length > 0) {
      const { response } = await dialog.showMessageBox(pluginWindow || mainWindow, {
        type: 'question',
        title: '技能已存在',
        message: `以下技能已存在：${conflicts.join('、')}`,
        detail: '覆盖：用压缩包中的版本替换现有技能，原内容删除。跳过同名：只安装不冲突的技能。',
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
      if (conflicted) removeSkill(fs, path, skillsDir(), s.name)
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
  try {
    if (!removeSkill(fs, path, skillsDir(), n)) return { ok: false, error: '技能不存在' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})
// Enable = move back to the root; disable = move under .disabled/
// (runtime.js setSkillEnabled). dsh's watcher picks up the rename without a
// restart.
ipcMain.handle('skills:setEnabled', async (_event, name, enabled) => {
  const n = String(name || '').trim()
  try {
    return setSkillEnabled(fs, path, skillsDir(), n, enabled === true)
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

/** Kill the dsh server without marking the app as quitting (for restarts). */
function killServer() {
  if (serverProc) {
    try {
      if (process.platform === 'win32') {
        // Windows: kill the whole tree and wait for it; descendants (conpty
        // agents etc.) hold locks in the install directory.
        require('child_process').spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
      } else {
        serverProc.kill('SIGTERM')
      }
    } catch { /* already gone */ }
    serverProc = null
  }
}
function stopServer() {
  quitting = true
  killServer()
}

/** Boot the server with the reactive self-heal retry loop. */
async function bootServerWithHeal() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startServer()
    } catch (err) {
      if (attempt < 6 && applyBootErrorFix(String((err && err.message) || err))) {
        console.log(`boot self-heal applied, retrying (attempt ${attempt + 1}/6)`)
        continue
      }
      throw err
    }
  }
}

/**
 * Restart the dsh server in place (no app relaunch), for config changes
 * (proxy) that reach the server through its environment. The window shows
 * the splash while the new server boots, then reloads the web UI.
 */
let restartingServer = false
async function restartDshServer() {
  if (restartingServer) return { ok: false, error: '正在重启中，请稍候' }
  if (quitting) return { ok: false, error: '应用正在退出' }
  restartingServer = true
  try {
    killServer()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'splash.html'))
    const url = await bootServerWithHeal()
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 500) }
  } finally {
    restartingServer = false
  }
}
ipcMain.handle('server:restart', async () => restartDshServer())

// Proxy credentials for Chromium's own network layer (shell window traffic).
// The dsh child process goes through the forwarder, which adds
// Proxy-Authorization itself.
app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy) return
  const c = readProxyConfig()
  if (c.mode === 'manual' && c.auth && c.login) {
    event.preventDefault()
    callback(c.login, c.password || '')
  }
})

app.whenReady().then(async () => {
  resolveActiveRuntime()
  applyChromiumProxy(readProxyConfig())
  await startForwarder()
  buildMenu()
  createWindow()
  try {
    const url = await bootServerWithHeal()
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(url)
    }
  } catch (err) {
    // An upgraded core that fails to boot is quarantined; the app relaunches
    // on the bundled runtime.
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

  // Silent startup update checks (a dialog appears only when a newer version
  // exists): the app itself (GitHub releases) and the dsh core (npm registry).
  setTimeout(() => { checkAppUpdates(false) }, 15_000)
  setTimeout(() => { checkCoreUpdates(false) }, 25_000)
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', stopServer)
app.on('will-quit', () => {
  // The CLI shims are persistent files while the forwarder dies with the
  // app: a stale HTTP_PROXY=http://127.0.0.1:<port> in them breaks all
  // network access for `dsh`/`pnpm` run from the user's own terminal while
  // the app is closed. They are rewritten scrub-only (direct) on the way
  // out; the next launch writes the fresh port back. A crash skips this;
  // the next launch heals it.
  try { forwarder = null; writeCliLaunchers() } catch { /* best effort */ }
})
process.on('exit', stopServer)
