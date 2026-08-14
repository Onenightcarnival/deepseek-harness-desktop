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
const { ENTRY_REL, compareVersions, runtimeVersion, pickRuntime, satisfiesNode } = require('./runtime.js')

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
    const child = spawn(process.execPath, [pnpmCjs, 'add', `@deepseek-ai/dsh@${version}`, '--ignore-scripts'], {
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
    // A fresh console window running cmd with PATH prepended.
    const child = spawn('cmd.exe', ['/K', `set "PATH=${binDir};%PATH%" && title DeepSeek Harness CLI && echo dsh 命令行已就绪：可直接使用 dsh / pnpm 命令`], {
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    child.unref()
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

function startServer() {
  return new Promise((resolve, reject) => {
    const entry = dshEntry()
    if (!fs.existsSync(entry)) {
      reject(new Error(`bundled dsh not found at ${entry}`))
      return
    }

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
        { label: '插件管理…', click: () => { openPluginManager() } },
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
    width: 640,
    height: 560,
    title: '插件管理',
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
ipcMain.handle('plugins:restart', async () => {
  app.relaunch()
  app.quit()
})

function stopServer() {
  quitting = true
  if (serverProc) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree on Windows (dsh spawns its own children).
        spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true })
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
