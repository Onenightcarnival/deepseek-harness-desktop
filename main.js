/**
 * DeepSeek Harness Desktop: Electron shell.
 *
 * Runs the bundled `dsh` server on Electron's embedded Node
 * (ELECTRON_RUN_AS_NODE) at a free loopback port, reads the ready line
 * `dsh web: http://127.0.0.1:<port>/?token=…` and loads that URL in a window.
 */
'use strict'

const { app, BrowserWindow, dialog, shell, Menu, Tray, nativeImage, nativeTheme, powerSaveBlocker, ipcMain, session, net: electronNet } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { ENTRY_REL, compareVersions, releaseLine, runtimeVersion, pickRuntime, satisfiesNode, prependEnvPath,
  applyProxyEnv, PROXY_ENV_KEYS, normalizeGeneralSettings, hideToTrayEffective } = require('./runtime.js')
const { createForwarder, routeFor } = require('./proxy-forward.js')
const { createWindowChrome } = require('./window-chrome.js')
const { translate, normalizeLanguage } = require('./desktop-i18n.js')
let uiLanguage = 'zh'
// Chromium localizes native accelerator names once, before app readiness.
try {
  uiLanguage = normalizeLanguage(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'ui-language.json'), 'utf8')))
  app.commandLine.appendSwitch('lang', uiLanguage === 'zh' ? 'zh-CN' : 'en-US')
} catch { /* First launch uses the system locale. */ }
const t = (key, ...values) => translate(key, uiLanguage, ...values)
const windowChrome = createWindowChrome({ ipcMain, nativeTheme, Menu, getOrigin: () => currentWebUrl,
  getLanguage: () => uiLanguage, onLanguage: language => {
    if (language === uiLanguage) return
    uiLanguage = language
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'ui-language.json'), JSON.stringify(language)) } catch { /* Optional preference persistence. */ }
    buildMenu()
    syncTray()
  } })

// Ready line with the one-time browser-trust token. The whole URL (query
// included) is loaded as-is; the token exchange (303 → cookie) happens in
// the window.
const READY_RE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/
const STARTUP_TIMEOUT_MS = 90_000
/** GitHub repo the update check queries ("owner/name"), from package.json. */
const UPDATE_REPO = (() => {
  try { return require('./package.json').updateRepo || null } catch { return null }
})()
/** Build flavor stamped by the release workflow (extraMetadata.flavor): "full" or "minimal". */
const APP_FLAVOR = (() => {
  try { return require('./package.json').flavor === 'full' ? 'full' : 'minimal' } catch { return 'minimal' }
})()

/**
 * In-place app updates (Windows only): electron-updater against the GitHub
 * Releases of UPDATE_REPO, channel by flavor (`latest.yml` minimal,
 * `full.yml` full). The new installer downloads in the background; on
 * confirmation the app quits and runs it silently (`/S --updated`), which
 * relaunches the app. macOS keeps the download-page flow.
 */
let appUpdater = null
let appUpdateState = 'idle' // idle | checking | available | downloading | downloaded
let appUpdateInfo = null
function getAppUpdater() {
  if (process.platform !== 'win32' || !UPDATE_REPO || !app.isPackaged) return null
  if (appUpdater) return appUpdater
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    // The channel setter turns allowDowngrade on; it is reset right after.
    autoUpdater.channel = APP_FLAVOR === 'full' ? 'full' : 'latest'
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = { info: (m) => console.log('[updater]', m), warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m), debug: () => {} }
    autoUpdater.on('download-progress', (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(Math.max(0, Math.min(1, p.percent / 100)))
    })
    autoUpdater.on('update-downloaded', (info) => {
      appUpdateState = 'downloaded'
      appUpdateInfo = info
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
      buildMenu()
      offerRestartForUpdate(info)
    })
    autoUpdater.on('error', (err) => {
      if (appUpdateState === 'downloading' && mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
      if (appUpdateState === 'downloading') {
        appUpdateState = 'available'
        buildMenu()
        dialog.showMessageBox({ type: 'warning', title: 'DeepSeek Harness', message: t("更新下载失败"), detail: String((err && err.message) || err), buttons: [t("好")] })
      }
    })
    appUpdater = autoUpdater
  } catch (err) {
    console.error('electron-updater unavailable:', String((err && err.message) || err))
    return null
  }
  return appUpdater
}

/** Start the background download of an available update. */
async function downloadAppUpdate() {
  const updater = getAppUpdater()
  if (!updater || appUpdateState === 'downloading' || appUpdateState === 'downloaded') return
  appUpdateState = 'downloading'
  buildMenu()
  try {
    await updater.downloadUpdate()
  } catch {
    // reported through the updater's error event
  }
}

/** Downloaded update: restart now (silent install, relaunch) or keep it for the next quit. */
async function offerRestartForUpdate(info) {
  const version = (info && info.version) || (appUpdateInfo && appUpdateInfo.version) || ''
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'DeepSeek Harness',
    message: t("v{0} 已下载完成", version),
    detail: t("重启后完成安装。选择「稍后」则在下次退出应用时安装。"),
    buttons: [t("立即重启"), t("稍后")],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) restartForUpdate()
}

function restartForUpdate() {
  const updater = getAppUpdater()
  if (!updater || appUpdateState !== 'downloaded') return
  stopServer()
  setImmediate(() => { updater.quitAndInstall(true, true) })
}

/**
 * Check the GitHub releases of UPDATE_REPO for a newer app version.
 * Windows: offer a background download that installs on restart; other
 * platforms and any updater failure: offer the release page.
 * @param interactive - also report "already up to date" / errors via dialog.
 */
async function checkAppUpdates(interactive) {
  if (!UPDATE_REPO) return
  if (appUpdateState === 'downloaded') { await offerRestartForUpdate(appUpdateInfo); return }
  if (appUpdateState === 'downloading') {
    if (interactive) await dialog.showMessageBox({ type: 'info', title: 'DeepSeek Harness', message: t("更新正在后台下载"), detail: t("下载完成后会提示重启。"), buttons: [t("好")] })
    return
  }
  const updater = getAppUpdater()
  if (updater) {
    try {
      appUpdateState = 'checking'
      const result = await updater.checkForUpdates()
      const info = result && result.updateInfo
      const latest = info ? String(info.version || '') : ''
      if (latest && compareVersions(latest, app.getVersion()) > 0) {
        appUpdateState = 'available'
        appUpdateInfo = info
        buildMenu()
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: 'DeepSeek Harness',
          message: t("发现新版本 v{0}（当前 v{1}）", latest, app.getVersion()),
          detail: t("在后台下载，完成后重启即可更新。"),
          buttons: [t("后台下载"), t("前往下载页"), t("取消")],
          defaultId: 0,
          cancelId: 2,
        })
        if (response === 0) await downloadAppUpdate()
        else if (response === 1) shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/tag/v${latest}`)
        return
      }
      appUpdateState = 'idle'
      if (interactive) {
        await dialog.showMessageBox({
          type: 'info', title: 'DeepSeek Harness',
          message: t("当前已是最新版本（v{0}）", app.getVersion()), buttons: [t("好")],
        })
      }
      return
    } catch (err) {
      appUpdateState = 'idle'
      console.error('[updater] check failed, falling back to the release page:', String((err && err.message) || err))
    }
  }
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
        message: t("发现新版本 v{0}（当前 v{1}）", latest, app.getVersion()),
        detail: rel.name || '',
        buttons: [t("前往下载"), t("取消")],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) shell.openExternal(rel.html_url || `https://github.com/${UPDATE_REPO}/releases`)
    } else if (interactive) {
      await dialog.showMessageBox({
        type: 'info', title: 'DeepSeek Harness',
        message: t("当前已是最新版本（v{0}）", app.getVersion()), buttons: [t("好")],
      })
    }
  } catch (err) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'warning', title: 'DeepSeek Harness',
        message: t("检查更新失败"), detail: String(err && err.message || err), buttons: [t("好")],
      })
    }
  }
}

let serverProc = null
let mainWindow = null
let quitting = false

// Second launch signals the active instance and exits.
// The ready handler starts services only while holding hasInstanceLock.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => { showMainWindow() })
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
 * Preload args for every Node child: `--require win-spawn-shim.js`
 * (windowsHide defaults for the whole child process). The shim is copied to
 * userData once per boot: plain Node children cannot read the asar.
 * Injected on every platform; no-op off Windows.
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
 * Add the shim to NODE_OPTIONS so every descendant Node process loads it
 * (argv --require reaches the direct child only). Appended after any
 * user-set NODE_OPTIONS. Mutates and returns env.
 */
function withNodePreloadEnv(env) {
  const args = nodePreloadArgs()
  if (args.length === 2) {
    // Quoted, forward slashes only: inside NODE_OPTIONS quotes a backslash
    // is an escape; Node accepts / in require paths on Windows.
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
          message: t("dsh 内核已是最新（v{0}）", current), buttons: [t("好")],
        })
      }
      return
    }
    // Same release line only: presets are pinned to the bundled core's line.
    // Cross-line upgrades ship as a new desktop build.
    const bundledVersion = runtimeVersion(bundledDshDir()) || current
    if (releaseLine(latest) !== releaseLine(bundledVersion)) {
      if (interactive) {
        const { response } = await dialog.showMessageBox({
          type: 'info', title: 'DeepSeek Harness',
          message: t("npm 上有 dsh v{0}，属于新的版本线（{1}）", latest, releaseLine(latest)),
          detail: t("本安装包内置 v{0}（{1} 线）。跨版本线升级需下载新版桌面安装包。", bundledVersion, releaseLine(bundledVersion)),
          buttons: [t("检查应用更新"), t("好")], defaultId: 0, cancelId: 1,
        })
        if (response === 0) await checkAppUpdates(true)
      }
      return
    }
    if (!satisfiesNode(process.versions.node, meta.engines && meta.engines.node)) {
      if (interactive) {
        await dialog.showMessageBox({
          type: 'warning', title: 'DeepSeek Harness',
          message: t("dsh v{0} 要求的 Node 版本高于本应用内置的 v{1}", latest, process.versions.node),
          detail: t("请等待新版桌面安装包。"),
          buttons: [t("好")],
        })
      }
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'info', title: 'DeepSeek Harness',
      message: t("发现 dsh 内核新版本 v{0}（当前 v{1}）", latest, current),
      detail: t("下载后重启应用生效；新内核启动失败时自动回退到内置版本。"),
      buttons: [t("下载并升级"), t("取消")], defaultId: 0, cancelId: 1,
    })
    if (response !== 0) return
    coreUpgradeBusy = true
    try {
      await installCoreRuntime(latest)
      const { response: r2 } = await dialog.showMessageBox({
        type: 'info', title: 'DeepSeek Harness',
        message: t("dsh v{0} 已就绪", latest), detail: t("重启应用后生效。"),
        buttons: [t("立即重启"), t("稍后")], defaultId: 0, cancelId: 1,
      })
      if (r2 === 0) { app.relaunch(); app.quit() }
    } finally {
      coreUpgradeBusy = false
    }
  } catch (err) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'warning', title: 'DeepSeek Harness',
        message: t("检查内核更新失败"), detail: String(err && err.message || err), buttons: [t("好")],
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
    // Full flavor: the upgraded runtime carries the preset plugins at the
    // exact staged versions (the profile resolves plugins from the active
    // runtime's app closure).
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
        ensureDesktopPlugins(dir)
        // Presets are registered as dependencies of the dsh app manifest
        // (same as stage-dsh.mjs); the profile resolves through the app's
        // dependency closure, not the runtime root manifest.
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
        reject(new Error(t("内核下载失败 (pnpm exit {0})\n{1}", code, tail.slice(-1500))))
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
 * Plugin-composition overlay shipped with the app (desktop-patch.yml,
 * applied via `dsh web --patch`): presets, disables or reconfigures plugins
 * on top of the upstream defaults.
 */
function desktopPatchArgs() {
  const candidates = [
    path.join(process.resourcesPath || '', 'desktop-patch.yml'),
    path.join(__dirname, 'desktop-patch.yml'), // dev (`npm start`)
  ]
  const p = candidates.find((c) => c && fs.existsSync(c))
  return p ? ['--patch', p] : []
}

/**
 * Proxy config store: {mode: 'none'|'system'|'manual', host, port, bypass,
 * auth, login, remember, password?}. `password` is persisted only with
 * `remember`; otherwise it lives in sessionProxyPassword for this run.
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
 * Resolve the OS proxy for one URL through Chromium (PAC-aware, honours the
 * OS exception list). Returns {host, port} or null (direct). Called per
 * request by the forwarder; never cached.
 */
async function resolveSystemProxy(url) {
  try {
    // Dedicated in-memory session with Chromium's default (OS) proxy
    // behaviour; defaultSession carries the app's own setProxy() config.
    const probe = session.fromPartition('proxy-probe')
    const s = await probe.resolveProxy(url || 'https://registry.npmjs.org/')
    const m = /(?:PROXY|HTTPS)\s+([^;\s:]+):(\d+)/.exec(s || '')
    return m ? { host: m[1], port: m[2] } : null
  } catch { return null }
}
/**
 * Apply the proxy config to Electron's (Chromium) network layer: shell
 * window traffic and update checks. Node child processes go through the
 * forwarder instead. Chromium bypasses loopback implicitly.
 */
async function applyChromiumProxy(config) {
  const c = config || PROXY_DEFAULTS
  try {
    if (c.mode === 'manual' && String(c.host || '').trim() && String(c.port ?? '').trim()) {
      const bypass = ['127.0.0.1', 'localhost', '::1']
      // same separators as runtime.js bypassPatterns: one list for the
      // shell window and the forwarder
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

/**
 * Workspace directory picker: the shell's own backend (plugins/
 * dsh-desktop-directory-picker) paired with dsh's native client surface,
 * composed in place of directory-picker-auto. A pick request arrives over
 * the server's IPC channel; the shell opens the OS folder dialog modal to
 * the app window (dialog.showOpenDialog). dsh's own native backend is not
 * used.
 */
function pickerPatchArgs() {
  const p = path.join(app.getPath('userData'), 'desktop-picker-patch.yml')
  fs.writeFileSync(p, [
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-desktop',
    `      name: '${DESKTOP_PICKER_PLUGIN}'`,
    '    - id: directory-picker-native-ui',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-native'",
    '    - id: desktop-activity',
    `      name: '${DESKTOP_ACTIVITY_PLUGIN}'`,
    '',
  ].join('\n'))
  return ['--patch', p]
}

const DESKTOP_PICKER_PLUGIN = 'dsh-desktop-directory-picker'
const DESKTOP_ACTIVITY_PLUGIN = 'dsh-desktop-activity'
const ACTIVITY_MESSAGE = 'dsh-desktop:activity'
const PICK_REQUEST = 'dsh-desktop:pick-directory'
const PICK_RESULT = 'dsh-desktop:pick-directory-result'
const PICK_CANCEL = 'dsh-desktop:pick-directory-cancel'

/** Source directory of the shell's plugin packages (extraResources when packaged, the repo in dev). */
function desktopPluginsSourceDir() {
  const packaged = path.join(process.resourcesPath || '', 'plugins')
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'plugins')
}

/**
 * Copy the shell's plugin packages into a runtime tree and register them in
 * the dsh app manifest (what stage-dsh.mjs does for the bundled runtime).
 * Runs before every server start and after a runtime upgrade. Files are
 * overwritten; a failure leaves the runtime as it was.
 */
function ensureDesktopPlugins(runtimeDir) {
  try {
    const srcRoot = desktopPluginsSourceDir()
    const names = fs.readdirSync(srcRoot).filter((n) => fs.existsSync(path.join(srcRoot, n, 'package.json')))
    for (const name of names) {
      const dest = path.join(runtimeDir, 'node_modules', name)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.cpSync(path.join(srcRoot, name), dest, { recursive: true })
    }
    const appManifestPath = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const appManifest = JSON.parse(fs.readFileSync(appManifestPath, 'utf8'))
    appManifest.dependencies ??= {}
    let changed = false
    for (const name of names) {
      if (appManifest.dependencies[name] === undefined) { appManifest.dependencies[name] = '*'; changed = true }
    }
    if (changed) fs.writeFileSync(appManifestPath, JSON.stringify(appManifest, null, 2))
  } catch (err) {
    console.error('desktop plugins not installed into runtime:', String((err && err.message) || err))
  }
}

/** The pick dialog title and button in the app language. */
function pickerStrings() {
  const zh = uiLanguage === 'zh'
  return zh ? { title: t("选择工作区目录"), buttonLabel: t("选择") } : { title: 'Select Workspace Directory', buttonLabel: 'Select' }
}

/**
 * Serve one pick request from the dsh server: open the OS folder dialog
 * modal to the main window and answer with the chosen path (null when
 * cancelled). A cancel notice from the server drops the answer.
 */
const cancelledPicks = new Set()
function onServerMessage(proc, message) {
  if (message === null || typeof message !== 'object') return
  if (message.type === ACTIVITY_MESSAGE) { setServerBusy(message.busy === true); return }
  if (message.type === PICK_CANCEL) { cancelledPicks.add(message.id); return }
  if (message.type !== PICK_REQUEST) return
  const id = message.id
  const reply = (payload) => {
    if (cancelledPicks.delete(id)) return
    if (proc.connected) { try { proc.send({ type: PICK_RESULT, id, ...payload }) } catch { /* server gone */ } }
  }
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const { title, buttonLabel } = pickerStrings()
  const options = { title, buttonLabel, defaultPath: app.getPath('home'), properties: ['openDirectory', 'createDirectory'] }
  ;(win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    .then((result) => { reply({ path: result.canceled ? null : (result.filePaths[0] || null) }) })
    .catch((err) => { reply({ path: null, error: String((err && err.message) || err) }) })
}

function proxyShimLines(win) {
  // Shims never inherit the machine's HTTP_PROXY: CLI and GUI route the same
  // way. The forwarder endpoint is valid while the app runs (shims are
  // rewritten on every launch); with the app closed the shim still clears
  // the inherited vars.
  const lines = []
  for (const key of PROXY_ENV_KEYS) {
    for (const k of [key, key.toLowerCase()]) lines.push(win ? `set "${k}="` : `unset ${k}`)
  }
  const env = applyProxyEnv({}, forwarder ? forwarder.port : 0, readProxyConfig())
  for (const [k, v] of Object.entries(env)) lines.push(win ? `set "${k}=${v}"` : `export ${k}="${v}"`)
  return lines
}

/**
 * Write the CLI launchers (dsh / pnpm / node / npx) into
 * userData/bin. All run on Electron's embedded Node (ELECTRON_RUN_AS_NODE);
 * nothing needs to be installed on the machine. Returns the bin dir, which
 * is also prepended to the server's PATH.
 */
/**
 * JavaScript entry of the bundled pnpm (cjs preferred, mjs accepted); empty
 * string when absent. pnpm ships with the bundled runtime only, pinned to
 * the 11 line.
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
  // pnpm ships with the bundled runtime only; upgraded runtimes under
  // userData/runtimes have no tools/ directory.
  const pnpmCjs = pnpmEntry()
  const exe = process.execPath
  const npxShim = path.join(binDir, 'npx-shim.js')
  fs.writeFileSync(npxShim, NPX_SHIM_SOURCE)
  require('./runtime').removeLegacyUvLaunchers(binDir)
  if (process.platform === 'win32') {
    const winProxy = proxyShimLines(true).join('\r\n') + '\r\n'
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\n${winProxy}"${exe}" --expose-internals "${entry}" %*\r\n`)
    // `node` shim: dependency install scripts (`node xxx.js`) need a node
    // on PATH.
    fs.writeFileSync(path.join(binDir, 'node.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${winProxy}"${exe}" %*\r\n`)
    if (fs.existsSync(pnpmCjs)) {
      // --config.minimum-release-age=0 disables the release-age gate.
      // --config.auto-install-peers=false: peers come from the app closure
      //   at runtime.
      // Both keys work only as CLI flags before the subcommand (env and
      // npmrc are ignored). dsh resolves pnpm via PATH, i.e. this shim.
      fs.writeFileSync(path.join(binDir, 'pnpm.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\n${winProxy}"${exe}" "${pnpmCjs}" --config.minimum-release-age=0 --config.auto-install-peers=false %*\r\n`)
      // `npx` → `pnpm dlx` through a small argv filter (npx-only flags are
      // dropped). cross-spawn (the MCP SDK's spawner) resolves .cmd shims on
      // PATH.
      fs.writeFileSync(path.join(binDir, 'npx.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "PATH=${binDir};%PATH%"\r\nset "DSHDESKTOP_PNPM_CJS=${pnpmCjs}"\r\n${winProxy}"${exe}" "${npxShim}" %*\r\n`)
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

  }
  return binDir
}

/**
 * The npx → pnpm dlx argv filter, written next to the launchers (userData is
 * outside the asar). npx-only flags are dropped; `--package=<spec>` /
 * `-p <spec>` become pnpm dlx's `--package`.
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
 * Open an OS terminal with the bundled CLI launchers on PATH.
 */
function openCliTerminal() {
  const binDir = writeCliLaunchers()
  if (process.platform === 'win32') {
    // ShellExecute opens the UTF-8 batch in a visible console.
    // chcp 65001 precedes all non-ASCII content.
    const cmdFile = path.join(binDir, 'DeepSeek Harness CLI.cmd')
    fs.writeFileSync(cmdFile, [
      '@echo off',
      'chcp 65001 >nul',
      'title DeepSeek Harness CLI',
      `set "PATH=${binDir};%PATH%"`,
      ...proxyShimLines(true),
      t("echo dsh 命令行已就绪：可直接使用 dsh / pnpm 命令"),
      t("echo 例如：dsh plugin --profile web add ^<插件包^>"),
      'cmd /K',
      '',
    ].join('\r\n'))
    shell.openPath(cmdFile).then((err) => {
      if (err) dialog.showErrorBox(t("无法打开命令行窗口"), t("{0}\n\n可手动运行该文件：\n{1}", err, cmdFile))
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
      t("echo \"dsh 命令行已就绪：可直接使用 dsh / pnpm 命令\""),
      t("echo \"例如：dsh plugin --profile web add <插件包>\""),
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
 * preset-plugins.json inside the runtime. Registration as a dependency of
 * the bundled dsh app makes a package resolvable from the profile;
 * activation requires the profile manifest to list it in dependencies +
 * dsh.profile.bundles (syncPresetPlugins).
 */

/**
 * The package's entry file relative to its root: `main`, else the `.` export
 * (string, or the first string among its default / import / require / node
 * conditions), else undefined.
 */
function pkgEntryOf(pj) {
  if (typeof pj.main === 'string' && pj.main !== '') return pj.main
  const exports = pj.exports
  const root = typeof exports === 'string' ? exports : (exports && typeof exports === 'object' ? exports['.'] : undefined)
  if (typeof root === 'string') return root
  if (root && typeof root === 'object') {
    for (const key of ['default', 'import', 'require', 'node']) {
      if (typeof root[key] === 'string') return root[key]
    }
  }
  return undefined
}

/** Whether <base>/<name> contains a package with an existing JS entry. */
function pkgUsableAt(base, name) {
  const pkgDir = path.join(base, ...name.split('/'))
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return fs.existsSync(path.join(pkgDir, pkgEntryOf(pj) || 'index.js'))
  } catch { return false }
}

/**
 * Whether <base>/<name> has a valid manifest and all declared artifacts.
 * Meta bundles may omit a JS entry. With no entry or bundle patch, the
 * package must contain index.js or dsh metadata.
 */
function pkgIntactAt(base, name) {
  const pkgDir = path.join(base, ...name.split('/'))
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const entry = pkgEntryOf(pj)
    const bundlePatch = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch
    if (entry && !fs.existsSync(path.join(pkgDir, entry))) return false
    if (bundlePatch && !fs.existsSync(path.join(pkgDir, bundlePatch))) return false
    if (!entry && !bundlePatch) return fs.existsSync(path.join(pkgDir, 'index.js')) || !!pj.dsh
    return true
  } catch { return false }
}

/**
 * Stub loader entries whose package no longer resolves (flavor switch,
 * broken local install); dsh refuses to boot on such an entry
 * (ERR_MODULE_NOT_FOUND while loading the plugin tree). User config is not
 * edited: a no-op stub package with a marker file goes into the profile's
 * node_modules. The stub retires once the active runtime provides the real
 * package; a real pnpm (re)install overwrites it.
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
      // Entry lines: `name: "@scope/pkg"` (quotes optional), npm name
      // grammar only.
      for (const m of text.matchAll(/^[\s-]*name:\s*["']?((?:@[a-z0-9~][\w.-]*\/)?[a-z0-9~][\w.-]*)["']?\s*$/gim)) {
        candidates.add(m[1])
      }
    }
    // Retire stubs by marker file, not by config reference: dsh rewrites
    // cordis.yml and may drop the entry behind a stub, and an orphaned stub
    // still shadows the real package.
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
      if (pkgUsableAt(localNm, name) || pkgIntactAt(localNm, name)) continue // real local install (or an existing stub)
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
    `console.warn('dsh-desktop: ${name} is missing from the runtime; using a stub until the plugin is reinstalled')`,
    `module.exports = { name: ${JSON.stringify(name)}, apply() {} }`,
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(stubDir, '.dsh-desktop-stub'), '')
}

/**
 * Reactive boot healing, the backstop behind the proactive passes: parse a
 * fatal dsh boot error and repair the known classes of profile damage
 * (entries referencing packages that no longer resolve → link the runtime's
 * copy or stub; broken local leftovers shadowing the closure → remove;
 * profile bundles nothing resolves → withdraw). Returns true when something
 * was repaired; the caller retries.
 */
const repairedOverlays = new Set()
const repairedCredentials = new Set()
function applyBootErrorFix(errText) {
  try {
    let fixed = false
    // A boot error blaming the shim disables the injection for this run.
    if (/win-spawn-shim/i.test(errText) && spawnShimPath !== '') {
      console.error('boot failed on win-spawn-shim injection; disabled for this run')
      spawnShimPath = '' // nodePreloadArgs/withNodePreloadEnv become no-ops
      return true
    }
    // ~/.dsh/.credentials.yaml forward-migrated by a newer dsh (`version`
    // became a number; this core requires a string). Step 1 quotes the
    // number in place (logins kept); step 2, when the same file fails again,
    // quarantines it. The retry loop drives both steps in order.
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
        console.log(`boot heal: quarantined ${file}; sign-in required`)
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
      if (!pkgUsableAt(localNm, name) && !pkgIntactAt(localNm, name)) {
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
    // entry already in the user's config. The preset bundle is withdrawn;
    // the user's entry keeps the feature via the carried package.
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
          // excluded for this app version only; the next installed version
          // retries
          addPresetExclusion(name)
          console.log(`boot heal: excluded preset ${name} for this version (duplicate entry id with user config)`)
          wrote = true
          fixed = true
        }
      }
      if (wrote) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    }
    // Unparseable overlay/config file: dsh refuses to boot. The file is
    // quarantined (renamed, content kept).
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
      // First attempt, once per file per run: drop a standalone flow `[]`
      // line coexisting with block entries (the common corruption). A
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

/** Per-app-version duplicate-id exclusions: presets whose entry id collides
 * with an entry already in the user's config, skipped by the sync for this
 * app version only. Every new install retries once. */
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
      message: t("当前版本没有预置插件"), detail: t("此安装包为精简版；预置插件随 full 版分发。"), buttons: [t("好")],
    })
    return
  }
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'DeepSeek Harness',
    message: t("重新同步本版本的预置插件？"),
    detail: t("以下插件将全部挂载：\n{0}\n\n需要重启应用。", names.join('\n')),
    buttons: [t("同步并重启"), t("取消")], defaultId: 0, cancelId: 1,
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
 * the preset portion of the user profile is made to match
 * preset-plugins.json exactly (minus this version's duplicate-id exclusions
 * and anything the active runtime cannot resolve).
 * userData/managed-presets.json records what is currently managed, so a
 * flavor switch or trimmed manifest knows what to remove; user-installed
 * plugins are never touched.
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

    // Preset leftovers in the profile's own node_modules shadow the closure
    // (broken ones crash boot, stale versions keep serving the old plugin).
    // Both are cleared; resolution falls back to the closure link.
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

    // Withdraw managed entries absent from the resolved preset set.
    for (const name of managed) {
      if (desired.includes(name)) continue
      if (pkg.dsh.profile.bundles.includes(name) || pkg.dependencies[name]) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((x) => x !== name)
        delete pkg.dependencies[name]
        console.log(`preset sync: removed ${name}`)
        changed = true
      }
    }
    // Ensure every desired preset is present at the manifest version (the
    // profile pin follows the installed build).
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
    ensureDesktopPlugins(activeRuntime.dir)
    syncPresetPlugins()
    healUnresolvableEntries()

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSHDESKTOP_DISABLED_SKILLS: path.join(app.getPath('userData'), 'disabled-skills') }
    env.DSHDESKTOP_LOG_FILE = logFile()
    env.PYTHONUTF8 = '1'
    env.PYTHONIOENCODING = 'utf-8'
    // Electron-specific vars must not leak into the node child.
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    // Expose the bundled dsh/pnpm CLI launchers to the server and its
    // children (dsh's plugin command locates pnpm via PATH).
    try {
      const binDir = writeCliLaunchers()
      // case-insensitive: on Windows the spread key is "Path"
      prependEnvPath(env, binDir, path.delimiter)
    } catch { /* CLI launchers are best-effort */ }
    withProxyEnv(env)
    withNodePreloadEnv(env)
    // The server and Windows sandbox share setupHiddenConsole's hidden console.
    // CLI launches retain their real terminal.
    env.DSHDESKTOP_CONSOLE_HOST = '1'
    // Per-process console-attach trace (server + every runner); fresh per
    // app launch.
    try {
      const dbgFile = path.join(app.getPath('userData'), 'console-debug.log')
      if (process.platform === 'win32') fs.writeFileSync(dbgFile, '')
      env.DSHDESKTOP_CONSOLE_DEBUG_FILE = dbgFile
    } catch { /* diagnostics are best-effort */ }

    // --no-open: the desktop shell is the browser.
    // Order: the dsh launcher consumes only its own leading flags
    // (--profile/--patch); app flags (--no-open/--port) come after.
    // fd 3: Node IPC channel for the directory picker and activity plugins.
    serverProc = spawn(process.execPath, ['--expose-internals', ...nodePreloadArgs(), entry, 'web', ...desktopPatchArgs(), ...pickerPatchArgs(), '--no-open', '--port', '0'], {
      env,
      cwd: app.getPath('home'),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    const thisProc = serverProc
    serverProc.on('message', (message) => { onServerMessage(thisProc, message) })

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

    const onChunk = (text) => {
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

    // Each pipe retains partial UTF-8 characters until the next data chunk.
    serverProc.stdout.setEncoding('utf8').on('data', onChunk)
    serverProc.stderr.setEncoding('utf8').on('data', onChunk)
    serverProc.once('close', () => logStream?.end())

    serverProc.on('exit', (code) => {
      // a late exit of an already-replaced process leaves the current one
      // alone and shows no dialog
      if (serverProc === thisProc) { serverProc = null; setServerBusy(false) }
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`dsh server exited early (code ${code}).\nOutput:\n${tail.slice(-2000)}`))
      } else if (!quitting && !restartingServer && serverProc === null) {
        // Server died while the app is open.
        if (mainWindow && !mainWindow.isDestroyed()) {
          showMainWindow()
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'DeepSeek Harness',
            message: t('内核服务意外停止'),
            detail: lf ? t('日志文件：{0}', lf) : String(code),
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
    ...windowChrome.options(),
    // 「启动时最小化到托盘」: the window loads hidden and the tray brings it back
    show: !(generalSettings.startMinimized && hideToTrayEffective(generalSettings, process.platform)),
    icon: process.platform === 'linux' ? path.join(__dirname, 'build', 'icon.png') : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload-desktop.js'),
    },
  })

  windowChrome.attach(mainWindow, 'main')
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

  // 「关闭时最小化到托盘」: closing hides the window; the dsh server and its
  // running work continue. Quit comes from the tray menu, the app menu or
  // the OS (before-quit sets `quitting`).
  mainWindow.on('close', (e) => {
    if (quitting || !hideToTrayEffective(generalSettings, process.platform)) return
    e.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('closed', () => { mainWindow = null })
}


// ---- 通用配置: tray, close/start to tray, login item, keep awake ----
function generalStorePath() { return path.join(app.getPath('userData'), 'general.json') }
function readGeneralSettings() {
  try { return normalizeGeneralSettings(JSON.parse(fs.readFileSync(generalStorePath(), 'utf8'))) } catch { return normalizeGeneralSettings({}) }
}
let generalSettings = normalizeGeneralSettings({})

/** Show the main window (restoring a hidden or minimized one; recreating a closed one). */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    if (currentWebUrl) loadWebUi(currentWebUrl)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

let tray = null
function trayImage() {
  const src = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
  if (src.isEmpty()) return src
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: src.resize({ width: 16, height: 16 }).toPNG() })
  img.addRepresentation({ scaleFactor: 2, buffer: src.resize({ width: 32, height: 32 }).toPNG() })
  return img
}
function syncTray() {
  if (generalSettings.trayIcon && tray === null) {
    tray = new Tray(trayImage())
    tray.setToolTip('DeepSeek Harness')
    // Windows / Linux: a click on the icon opens the window; macOS opens the menu.
    tray.on('click', () => { if (process.platform !== 'darwin') showMainWindow() })
    tray.on('double-click', () => { showMainWindow() })
  } else if (!generalSettings.trayIcon && tray !== null) {
    tray.destroy()
    tray = null
    // without a tray a hidden window has no way back on Windows / Linux
    if (process.platform !== 'darwin' && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('打开 DeepSeek Harness'), click: showMainWindow },
    { label: t('配置中心…'), click: openPluginManager },
    { type: 'separator' }, { label: t('退出'), click: () => app.quit() },
  ]))
}

function syncLoginItem() {
  if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) return
  try {
    app.setLoginItemSettings({ openAtLogin: generalSettings.openAtLogin, openAsHidden: generalSettings.startMinimized })
  } catch (err) { console.error('login item not updated:', String((err && err.message) || err)) }
}

// 「运行任务时保持系统唤醒」: the dsh-desktop-activity plugin reports the
// server's work state over IPC; a power-save blocker runs while there is
// work and the option is on.
let serverBusy = false
let awakeBlocker = null
function setServerBusy(busy) {
  if (busy !== serverBusy) console.log(`dsh server ${busy ? 'busy' : 'idle'}`)
  serverBusy = busy
  syncKeepAwake()
}
function syncKeepAwake() {
  const want = generalSettings.keepAwake && serverBusy
  if (want && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
  else if (!want && awakeBlocker !== null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null }
}

/** Apply the current settings to the running app (startup and every save). */
function applyGeneralSettings() {
  syncTray()
  syncLoginItem()
  syncKeepAwake()
}

ipcMain.handle('general:get', async () => ({ settings: generalSettings, platform: process.platform }))
ipcMain.handle('general:save', async (_event, values) => {
  const next = normalizeGeneralSettings(values)
  try {
    fs.writeFileSync(generalStorePath(), JSON.stringify(next, null, 2))
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  generalSettings = next
  applyGeneralSettings()
  return { ok: true, settings: generalSettings }
})

function buildMenu() {
  const editItems = () => [['撤销','undo'],['重做','redo'],['剪切','cut'],['复制','copy'],['粘贴','paste'],['粘贴并匹配样式','pasteAndMatchStyle'],['删除','delete'],['全选','selectAll']].map(([label, role]) => ({label:t(label),role}))
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ label: 'DeepSeek Harness', submenu: [{label:t('关于 DeepSeek Harness'),role:'about'}, {type:'separator'}, {label:t('服务'),role:'services'}, {type:'separator'}, {label:t('隐藏 DeepSeek Harness'),role:'hide'}, {label:t('隐藏其他应用'),role:'hideOthers'}, {label:t('显示全部'),role:'unhide'}, {type:'separator'}, {label:t('退出'),role:'quit'}] }] : []),
    { label: t("文件"), role: 'fileMenu', submenu: [{label:t('关闭窗口'),role:'close'}] },
    { label: t("编辑"), role: 'editMenu', submenu: editItems() },
    {
      label: t("查看"),
      submenu: [
        { label: t("重新加载"), role: 'reload' }, { label: t("强制重新加载"), role: 'forceReload' }, { label: t("开发者工具"), role: 'toggleDevTools' },
        { type: 'separator' },
        { label: t("实际大小"), role: 'resetZoom' }, { label: t("放大"), role: 'zoomIn' }, { label: t("缩小"), role: 'zoomOut' },
        { type: 'separator' }, { label: t("切换全屏"), role: 'togglefullscreen' },
      ],
    },
    { label: t("窗口"), role: 'windowMenu', submenu: [{label:t('最小化'),role:'minimize'},{label:t('缩放窗口'),role:'zoom'}, ...(isMac ? [{label:t('全部置于前台'),role:'front'}] : [])] },
    {
      label: t("插件"),
      submenu: [
        { label: t("配置中心…（插件 / 通用 / 代理）"), click: () => { openPluginManager() } },
        { label: t("打开命令行窗口"), click: () => { openCliTerminal() } },
        { type: 'separator' },
        { label: t("重新同步预置插件…"), click: () => { restorePresetPlugins() } },
      ],
    },
    {
      label: t("帮助"),
      submenu: [
        { label: t("内核版本：v{0}{1}", (activeRuntime && activeRuntime.version) || '?', activeRuntime && !activeRuntime.bundled ? t("（已升级）") : ''), enabled: false },
        { label: t("检查内核更新…"), click: () => { checkCoreUpdates(true) } },
        appUpdateState === 'downloaded'
          ? { label: t("重启以更新到 v{0}…", (appUpdateInfo && appUpdateInfo.version) || ''), click: () => { offerRestartForUpdate(appUpdateInfo) } }
          : appUpdateState === 'downloading'
            ? { label: t("正在下载应用更新…"), enabled: false }
            : { label: t("检查应用更新…"), click: () => { checkAppUpdates(true) } },
        { type: 'separator' },
        { label: t("GitHub 仓库"), click: () => { if (UPDATE_REPO) shell.openExternal(`https://github.com/${UPDATE_REPO}`) } },
      ],
    },
  ]
  const items = process.platform === 'win32' ? [
    { id: 'desktop-application', label: t("应用"), submenu: [
      { label: t("配置中心…"), accelerator: 'CmdOrCtrl+,', click: () => { openPluginManager() } },
      { type: 'separator' },
      ...template.filter(item => item.role !== 'editMenu'),
      { type: 'separator' }, { label: t("退出"), role: 'quit' },
    ] },
    { id: 'desktop-edit', label: t("编辑"), role: 'editMenu', submenu: editItems() },
  ] : template
  Menu.setApplicationMenu(Menu.buildFromTemplate(items))
  if (process.platform === 'win32') for (const win of BrowserWindow.getAllWindows()) win.setMenuBarVisibility(false)
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
  if (pluginWindow && !pluginWindow.isDestroyed()) {
    if (pluginWindow.isMinimized()) pluginWindow.restore()
    pluginWindow.show(); pluginWindow.focus(); return
  }
  pluginWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 760,
    minHeight: 540,
    title: t("配置中心"),
    ...windowChrome.options(),
    parent: mainWindow || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload-desktop.js'),
    },
  })
  pluginWindow.setMenuBarVisibility(false)
  windowChrome.attach(pluginWindow, 'settings')
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
  // Every npm install spec shape is accepted (names, @scope/name@range,
  // github:owner/repo#ref, git+https://…, https://….tgz, file:/link:).
  // Args go through spawn(argv[]) without a shell; only whitespace/control
  // characters are rejected.
  if (cleaned.length === 0 || cleaned.length > 300 || /[\s'"`\\]/.test(cleaned)) {
    return { code: -1, output: t("无效的包名") }
  }
  if (action !== 'add' && action !== 'remove') return { code: -1, output: t("无效操作") }
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
  if (kind !== 'dir' && kind !== 'tgz') return { code: -1, output: t("无效操作") }
  const opts = kind === 'dir'
    ? { title: t("选择插件目录（需含 package.json）"), properties: ['openDirectory'] }
    : { title: t("选择插件包（npm pack 打出的 .tgz）"), properties: ['openFile'], filters: [{ name: t("npm 包"), extensions: ['tgz'] }] }
  const { canceled, filePaths } = await dialog.showOpenDialog(pluginWindow || mainWindow, opts)
  if (canceled || filePaths.length === 0) return { canceled: true, code: 0, output: '' }
  const target = filePaths[0]
  if (kind === 'dir' && !fs.existsSync(path.join(target, 'package.json'))) {
    return { code: -1, output: t("所选目录没有 package.json：\n{0}", target) }
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

// ---- proxy config ----
ipcMain.handle('proxy:get', async () => readProxyConfig())
ipcMain.handle('proxy:save', async (_event, config) => {
  if (!config || typeof config !== 'object') return { ok: false, error: t("数据格式无效") }
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
    if (!/^[\w.-]+$/.test(c.host) || c.host.length > 255) return { ok: false, error: t("主机名无效") }
    if (!/^\d{1,5}$/.test(c.port) || Number(c.port) < 1 || Number(c.port) > 65535) return { ok: false, error: t("端口需为 1-65535") }
  }
  if (c.bypass.length > 2000 || /[\r\n\0]/.test(c.bypass)) return { ok: false, error: t("例外列表格式无效") }
  if (c.login.length > 200 || c.password.length > 200) return { ok: false, error: t("用户名或密码过长") }
  if (c.caPath && !fs.existsSync(c.caPath)) return { ok: false, error: t("CA 证书文件不存在") }
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
    title: t("选择代理的 CA 证书（PEM 格式）"),
    properties: ['openFile'],
    filters: [{ name: t("证书文件"), extensions: ['pem', 'crt', 'cer'] }],
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
  try { u = new URL(target) } catch { return { ok: false, detail: t("测试地址无效（需以 http:// 或 https:// 开头）") } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, detail: t("测试地址需以 http:// 或 https:// 开头") }
  const cfg = { ...(config || {}) }
  const probe = await createForwarder({ getConfig: () => cfg, resolveSystem: resolveSystemProxy })
  if (!probe.port) return { ok: false, detail: t("本地转发代理无法监听端口") }
  try {
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    const route = await routeFor(cfg, resolveSystemProxy, u.hostname, port, u.protocol.slice(0, -1))
    const label = route ? t("{0} → 代理 {1}:{2}，", u.hostname, route.host, route.port) : t("{0} → 直连，", u.hostname)
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
          if (r.ok) resolve({ ok: true, detail: t("{0}连通（HTTP {1}，{2}ms）", label, r.status, r.ms) })
          else resolve({ ok: false, detail: t("{0}失败：{1}", label, r.error || `HTTP ${r.status}`) })
        } catch {
          resolve({ ok: false, detail: t("测试进程异常退出") })
        }
      })
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, detail: String(err) }) })
    })
  } finally {
    probe.close()
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
 * Load the ready URL after removing all 127.0.0.1 `dsh-auth-*` cookies.
 * Authentication cookies are scoped by host and shared across service ports.
 */
let currentWebUrl = null
async function loadWebUi(url) {
  currentWebUrl = url
  try {
    const jar = session.defaultSession.cookies
    const host = new URL(url).hostname
    for (const c of await jar.get({ domain: host })) {
      if (c.name.startsWith('dsh-auth-')) await jar.remove(`http://${host}${c.path || '/'}`, c.name)
    }
  } catch { /* stale cookies only matter once they pile up */ }
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url)
}

/**
 * Restart the dsh server in place (no app relaunch), for config changes
 * (proxy) that reach the server through its environment. The window shows
 * the splash while the new server boots, then reloads the web UI.
 */
let restartingServer = false
async function restartDshServer() {
  if (restartingServer) return { ok: false, error: t("正在重启中，请稍候") }
  if (quitting) return { ok: false, error: t("应用正在退出") }
  restartingServer = true
  try {
    killServer()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'splash.html'))
    const url = await bootServerWithHeal()
    await loadWebUi(url)
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
  if (!hasInstanceLock) return
  try { uiLanguage = normalizeLanguage(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'ui-language.json'), 'utf8'))) }
  catch { uiLanguage = normalizeLanguage(app.getLocale()) }
  resolveActiveRuntime()
  applyChromiumProxy(readProxyConfig())
  await startForwarder()
  generalSettings = readGeneralSettings()
  buildMenu()
  createWindow()
  applyGeneralSettings()
  try {
    const url = await bootServerWithHeal()
    await loadWebUi(url)
  } catch (err) {
    // An upgraded core that fails to boot is quarantined; the app relaunches
    // on the bundled runtime.
    if (activeRuntime && !activeRuntime.bundled) {
      try { fs.renameSync(activeRuntime.dir, `${activeRuntime.dir}.broken-${Date.now()}`) } catch { /* keep going */ }
      if (mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: 'DeepSeek Harness',
          message: t("升级的 dsh 内核（v{0}）启动失败，已回退到内置版本", activeRuntime.version),
          detail: String(err && err.message || err).slice(0, 800),
          buttons: [t("重启应用")],
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
        message: t('内核服务启动失败'),
        detail: String(err && err.message || err),
      })
    }
    app.quit()
  }

  app.on('activate', () => { showMainWindow() })

  // Update checks run only from the Help menu; nothing contacts GitHub or
  // the npm registry at startup.
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', stopServer)
app.on('will-quit', () => {
  // Shims are persistent files while the forwarder dies with the app: they
  // are rewritten scrub-only (direct) on the way out and the next launch
  // writes the fresh port back. A crash skips this; the next launch heals
  // it.
  try { forwarder = null; writeCliLaunchers() } catch { /* best effort */ }
})
process.on('exit', stopServer)
