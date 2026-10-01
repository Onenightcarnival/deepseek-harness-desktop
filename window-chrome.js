'use strict'

const { pathToFileURL } = require('url')
const path = require('path')
const fs = require('fs')

/** 原生标题栏与页面共用的基础配色。 */
function chromePalette(dark) {
  return dark
    ? { dark: true, sidebar: '#1b1b1c', content: '#141414', text: '#f9fafb' }
    : { dark: false, sidebar: '#f9fafb', content: '#ffffff', text: '#0f1115' }
}

/** 保留系统窗口按钮；Linux 沿用系统窗口装饰。 */
function chromeOptions(platform, palette) {
  const base = { backgroundColor: palette.sidebar }
  if (platform === 'win32') return { ...base, titleBarStyle: 'hidden',
    titleBarOverlay: { height: 40, color: palette.sidebar, symbolColor: palette.text } }
  if (platform === 'darwin') return { ...base, titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'sidebar',
    visualEffectState: 'active', backgroundColor: '#00000000' }
  return base
}

/** 只接受受管窗口主 frame 的本地页或当前内核来源。 */
function trustedChromeUrl(url, purpose, origin) {
  try {
    const parsed = new URL(url)
    const file = purpose === 'settings' ? 'plugins.html' : 'splash.html'
    if (parsed.href === pathToFileURL(path.join(__dirname, file)).href) return true
    return purpose === 'main' && !!origin && parsed.origin === new URL(origin).origin
  } catch { return false }
}

/** 管理标题栏外观、全屏状态和 Windows 原生菜单的受限 IPC。 */
function createWindowChrome({ ipcMain, nativeTheme, Menu, platform = process.platform, getOrigin }) {
  const windows = new Map()
  const css = fs.readFileSync(path.join(__dirname, 'desktop.css'), 'utf8')
  let palette = chromePalette(nativeTheme.shouldUseDarkColors)
  let webPalette = false
  function source(event) {
    const entry = windows.get(event.sender.id)
    if (!entry || entry.window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null
    return trustedChromeUrl(event.senderFrame.url, entry.purpose, getOrigin()) ? entry : null
  }
  function state(entry) {
    return { platform, purpose: entry.purpose, palette,
      fullscreen: entry.fullscreen, zoom: entry.window.webContents.getZoomFactor(),
      local: entry.window.webContents.getURL().startsWith('file:') }
  }
  function update(entry) {
    const win = entry.window
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    if (platform === 'win32') win.setTitleBarOverlay({ color: palette.sidebar, symbolColor: palette.text,
      height: Math.round(Math.max(40, 40 * win.webContents.getZoomFactor())) })
    if (platform === 'darwin') {
      const vibrant = win.isVisible() && !win.isMinimized()
      win.setVibrancy(vibrant ? 'sidebar' : null)
      win.setBackgroundColor(vibrant ? '#00000000' : palette.sidebar)
    } else win.setBackgroundColor(palette.sidebar)
    win.webContents.send('desktop:chrome-state', state(entry))
  }
  ipcMain.on('desktop:chrome-init', (event) => {
    const entry = source(event)
    event.returnValue = entry ? state(entry) : null
  })
  ipcMain.on('desktop:chrome-resize', event => {
    const entry = source(event)
    if (entry) update(entry)
  })
  ipcMain.on('desktop:chrome-palette', (event, value) => {
    const entry = source(event)
    if (!entry || entry.purpose !== 'main' || event.senderFrame.url.startsWith('file:')) return
    if (!value || typeof value.dark !== 'boolean' ||
      !['sidebar', 'content', 'text'].every(key => /^#[0-9a-f]{6}$/i.test(value[key]))) return
    palette = { dark: value.dark, sidebar: value.sidebar, content: value.content, text: value.text }
    webPalette = true
    // 原生菜单跟随页面主题；系统模式保留操作系统的主题变化。
    nativeTheme.themeSource = ['system', 'light', 'dark'].includes(value.source)
      ? value.source : value.dark ? 'dark' : 'light'
    for (const item of windows.values()) update(item)
  })
  ipcMain.handle('desktop:chrome-menu', async (event, name, x, y) => {
    const entry = source(event)
    if (!entry || platform !== 'win32' || !['application', 'edit'].includes(name) ||
      !Number.isFinite(x) || !Number.isFinite(y)) return
    const menu = Menu.getApplicationMenu()?.getMenuItemById(`desktop-${name}`)?.submenu
    if (!menu) return
    const zoom = event.sender.getZoomFactor()
    const [width, height] = entry.window.getContentSize()
    await new Promise(resolve => menu.popup({ window: entry.window,
      x: Math.round(Math.max(0, Math.min(width, x * zoom))),
      y: Math.round(Math.max(0, Math.min(height, y * zoom))), callback: resolve }))
  })
  nativeTheme.on('updated', () => {
    if (webPalette) return
    palette = chromePalette(nativeTheme.shouldUseDarkColors)
    for (const entry of windows.values()) update(entry)
  })
  return {
    options: () => chromeOptions(platform, palette),
    attach(window, purpose) {
      const entry = { window, purpose, fullscreen: window.isFullScreen() }
      windows.set(window.webContents.id, entry)
      const id = window.webContents.id
      if (platform === 'win32') window.setMenuBarVisibility(false)
      // Windows 在事件回调内的 isFullScreen() 仍可能是切换前的值。
      window.on('enter-full-screen', () => { entry.fullscreen = true; update(entry) })
      window.on('leave-full-screen', () => { entry.fullscreen = false; update(entry) })
      for (const event of ['show', 'restore', 'hide', 'minimize']) {
        window.on(event, () => update(entry))
      }
      window.webContents.on('did-finish-load', () => update(entry))
      window.webContents.on('dom-ready', () => {
        if (trustedChromeUrl(window.webContents.getURL(), purpose, getOrigin())) {
          window.webContents.insertCSS(css).catch(error => console.error('窗口样式加载失败:', error))
        }
      })
      window.webContents.on('zoom-changed', () => update(entry))
      window.on('closed', () => windows.delete(id))
    },
  }
}

module.exports = { chromePalette, chromeOptions, trustedChromeUrl, createWindowChrome }
