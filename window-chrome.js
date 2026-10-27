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
    trafficLightPosition: { x: 16, y: 18 } }
  return base
}

const LOCAL_PAGES = { settings: 'plugins.html', splash: 'splash.html' }

/** 只接受受管窗口主 frame 的本地页或当前内核来源：main 仅内核来源，settings 与 splash 仅对应本地文件。 */
function trustedChromeUrl(url, purpose, origin) {
  try {
    const parsed = new URL(url)
    const file = LOCAL_PAGES[purpose]
    if (file) return parsed.href === pathToFileURL(path.join(__dirname, file)).href
    return purpose === 'main' && !!origin && parsed.origin === new URL(origin).origin
  } catch { return false }
}

const EDIT_ROLES = { undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选' }

/**
 * 右键菜单模板：可编辑区域提供编辑角色并按 editFlags 置灰，选中文本提供复制，其余不弹出。
 * 空 accelerator 抑制角色自带的快捷键标注。
 */
function contextMenuItems(params, translate = key => key) {
  const { isEditable, selectionText = '', editFlags = {} } = params
  const role = (name, enabled) => ({ role: name, label: translate(EDIT_ROLES[name]), enabled: enabled !== false, accelerator: '' })
  if (isEditable) {
    return [
      role('undo', editFlags.canUndo), role('redo', editFlags.canRedo), { type: 'separator' },
      role('cut', editFlags.canCut), role('copy', editFlags.canCopy), role('paste', editFlags.canPaste), { type: 'separator' },
      role('selectAll', editFlags.canSelectAll),
    ]
  }
  if (selectionText.length > 0) return [role('copy', editFlags.canCopy)]
  return []
}

/** 管理标题栏外观、全屏状态、右键菜单和 Windows 原生菜单的受限 IPC。 */
function createWindowChrome({ ipcMain, nativeTheme, Menu, platform = process.platform, getOrigin, getLanguage = () => 'zh', onLanguage = () => {}, translate = key => key }) {
  const windows = new Map()
  const css = fs.readFileSync(path.join(__dirname, 'desktop.css'), 'utf8')
  let palette = chromePalette(nativeTheme.shouldUseDarkColors)
  let webPalette = false
  function source(event) {
    const entry = windows.get(event.sender.id)
    if (!entry || entry.window.isDestroyed() || entry.contents.isDestroyed() || event.senderFrame !== entry.contents.mainFrame) return null
    return trustedChromeUrl(event.senderFrame.url, entry.purpose, getOrigin()) ? entry : null
  }
  function state(entry) {
    return { platform, purpose: entry.purpose, palette, language: getLanguage(),
      fullscreen: entry.fullscreen, zoom: entry.contents.getZoomFactor(),
      local: entry.contents.getURL().startsWith('file:'),
      browser: entry.purpose === 'main' && entry.contents.getLastWebPreferences().webviewTag === true }
  }
  function update(entry) {
    const win = entry.window
    if (win.isDestroyed() || entry.contents.isDestroyed()) return
    if (entry.contents === win.webContents) {
      if (platform === 'win32') win.setTitleBarOverlay({ color: palette.sidebar, symbolColor: palette.text,
        height: Math.round(Math.max(40, 40 * win.webContents.getZoomFactor())) })
      win.setBackgroundColor(palette.sidebar)
    }
    entry.contents.send('desktop:chrome-state', state(entry))
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
    if (['en', 'zh'].includes(value.language)) onLanguage(value.language)
    // 原生菜单跟随页面主题；系统模式保留操作系统的主题变化。
    nativeTheme.themeSource = ['system', 'light', 'dark'].includes(value.source)
      ? value.source : value.dark ? 'dark' : 'light'
    for (const item of windows.values()) update(item)
  })
  ipcMain.handle('desktop:chrome-menu', async (event, name, x, y) => {
    const entry = source(event)
    if (!entry || entry.purpose === 'splash' || platform !== 'win32' || !['application', 'edit'].includes(name) ||
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
  /** 登记一个 webContents；覆盖层视图与其宿主窗口共享全屏与显示状态。 */
  function register(window, contents, purpose) {
    const entry = { window, contents, purpose, fullscreen: window.isFullScreen() }
    const id = contents.id
    windows.set(id, entry)
    if (platform === 'win32' && contents === window.webContents) window.setMenuBarVisibility(false)
    // Windows 在事件回调内的 isFullScreen() 仍可能是切换前的值。
    const listeners = [
      ['enter-full-screen', () => { entry.fullscreen = true; update(entry) }],
      ['leave-full-screen', () => { entry.fullscreen = false; update(entry) }],
      ...['show', 'restore', 'hide', 'minimize'].map(event => [event, () => update(entry)]),
    ]
    for (const [event, listener] of listeners) window.on(event, listener)
    contents.on('did-finish-load', () => update(entry))
    contents.on('dom-ready', () => {
      if (trustedChromeUrl(contents.getURL(), purpose, getOrigin())) {
        contents.insertCSS(css).catch(error => console.error('Window stylesheet failed to load:', error))
      }
    })
    contents.on('zoom-changed', () => update(entry))
    if (purpose !== 'splash') {
      contents.on('context-menu', (_event, params) => {
        const items = contextMenuItems(params, translate)
        if (items.length > 0 && !window.isDestroyed()) Menu.buildFromTemplate(items).popup({ window })
      })
    }
    const release = () => {
      windows.delete(id)
      if (!window.isDestroyed()) for (const [event, listener] of listeners) window.off(event, listener)
    }
    contents.once('destroyed', release)
    window.once('closed', release)
  }
  return {
    options: () => chromeOptions(platform, palette),
    attach(window, purpose) { register(window, window.webContents, purpose) },
    /** 登记启动页覆盖层（purpose splash）；视图销毁时自动撤销登记。 */
    attachView(window, view) { register(window, view.webContents, 'splash') },
  }
}

module.exports = { chromePalette, chromeOptions, trustedChromeUrl, contextMenuItems, createWindowChrome }
