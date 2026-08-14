/**
 * DeepSeek Harness Desktop — Electron shell.
 *
 * Boots the bundled `dsh` server (via Electron's embedded Node using
 * ELECTRON_RUN_AS_NODE) on a free loopback port, waits for the ready line
 * ("dsh web: http://127.0.0.1:<port>"), then shows the Web UI in a window.
 */
'use strict'

const { app, BrowserWindow, dialog, shell, Menu } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const READY_RE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/
const STARTUP_TIMEOUT_MS = 90_000

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

function dshEntry() {
  // Packaged: resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
  const packaged = path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(packaged)) return packaged
  // Dev fallback (`npm start` after `node stage-dsh.mjs`)
  return path.join(__dirname, 'staging', `${process.platform}-${process.arch}`, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function logFile() {
  try {
    return path.join(app.getPath('userData'), 'dsh-server.log')
  } catch {
    return null
  }
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

    serverProc = spawn(process.execPath, ['--expose-internals', entry, 'web', ...pickerPatchArgs(), '--port', '0'], {
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
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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
  buildMenu()
  createWindow()
  try {
    const url = await startServer()
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(url)
    }
  } catch (err) {
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
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', stopServer)
process.on('exit', stopServer)
