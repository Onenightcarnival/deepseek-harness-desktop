'use strict'
const { contextBridge, ipcRenderer, webFrame } = require('electron')

const initialState = ipcRenderer.sendSync('desktop:chrome-init')
let currentLanguage = initialState?.language || 'zh'
if (initialState) contextBridge.exposeInMainWorld('desktopLocale', { get: () => currentLanguage })

// 配置 API 只存在于主进程验证过的配置中心本地页。
if (initialState?.purpose === 'settings' && initialState.local) contextBridge.exposeInMainWorld('pluginApi', {
  list: () => ipcRenderer.invoke('plugins:list'),
  run: (action, spec) => ipcRenderer.invoke('plugins:run', action, spec),
  installLocal: (kind) => ipcRenderer.invoke('plugins:installLocal', kind),
  restart: () => ipcRenderer.invoke('plugins:restart'),
  generalGet: () => ipcRenderer.invoke('general:get'),
  generalSave: (values) => ipcRenderer.invoke('general:save', values),
  proxyGet: () => ipcRenderer.invoke('proxy:get'),
  proxySave: (config) => ipcRenderer.invoke('proxy:save', config),
  proxyTest: (config, url) => ipcRenderer.invoke('proxy:test', config, url),
  proxyPickCa: () => ipcRenderer.invoke('proxy:pickCa'),
  serverRestart: () => ipcRenderer.invoke('server:restart'),
})

/** 标记上游支持的平台布局，并同步本地页与原生窗口配色。 */
function applyState(state) {
  const root = document.documentElement
  currentLanguage = state.language || 'zh'
  if (state.local && root.lang !== currentLanguage) {
    root.lang = currentLanguage
    window.dispatchEvent(new Event('desktop-language-change'))
  }
  const title = document.getElementById('desktop-titlebar')
  if (title) title.textContent = state.purpose === 'settings' ? (currentLanguage === 'en' ? 'Configuration center' : '配置中心') : state.platform === 'darwin' ? '' : 'DeepSeek Harness'
  // 上游 data-platform 同时启用官方键盘桥；Web 壳使用独立的视觉标记。
  root.dataset.desktopPlatform = state.platform
  root.toggleAttribute('data-fullscreen', state.fullscreen)
  root.toggleAttribute('data-desktop-local', state.local)
  root.toggleAttribute('data-desktop-dark', state.palette.dark)
  const zoom = webFrame.getZoomFactor()
  const height = state.platform === 'win32' ? Math.round(Math.max(40, 40 * zoom)) : state.platform === 'darwin' ? 48 : 0
  root.style.setProperty('--desktop-titlebar-height', `${height / zoom}px`)
  root.style.setProperty('--desktop-traffic-clearance', `${88 / zoom}px`)
  if (state.platform === 'win32' && !state.local) {
    root.setAttribute('data-windows-titlebar', '')
    root.style.setProperty('--dsh-windows-titlebar-height', `${height / zoom}px`)
  }
  for (const key of ['sidebar', 'content', 'text']) root.style.setProperty(`--desktop-${key}`, state.palette[key])
}

/** Windows 两个入口调用原生菜单，鼠标打开菜单时保留编辑器焦点。 */
function mountMenu() {
  const host = document.createElement('div')
  host.id = 'desktop-menu'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    :host { position:fixed; top:0; left:var(--dsh-windows-menu-start,48px); z-index:1100;
      height:var(--dsh-windows-titlebar-height); display:flex; align-items:center;
      -webkit-app-region:no-drag; font:14px "Segoe UI", "Microsoft YaHei", sans-serif; }
    [role=menubar] { display:flex; gap:2px; }
    button { border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary, var(--desktop-text));
      padding:0 10px; height:28px; font:inherit; }
    button:hover, button[aria-expanded=true] { background:var(--dsw-alias-interactive-bg-hover, #8883); }
    button:focus-visible { outline:2px solid #4d6bfe; outline-offset:-2px; }
  `
  const bar = document.createElement('div')
  bar.setAttribute('role', 'menubar')
  bar.setAttribute('aria-label', currentLanguage === 'en' ? 'App menu' : '应用菜单')
  let restoreEditor = () => {}
  document.addEventListener('focusout', event => {
    const editor = event.composedPath()[0]
    if (!(editor instanceof HTMLElement) || shadow.contains(editor)) return
    const input = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
    if (!input && !editor.isContentEditable) return
    const selection = document.getSelection()
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
    const start = input ? editor.selectionStart : null, end = input ? editor.selectionEnd : null
    restoreEditor = () => {
      if (!editor.isConnected) return
      editor.focus({ preventScroll: true })
      if (input && start !== null && end !== null) editor.setSelectionRange(start, end)
      else if (selection && ranges.length) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
    }
  }, true)
  const buttons = (currentLanguage === 'en' ? ['App', 'Edit'] : ['应用', '编辑']).map((label, index) => {
    const button = document.createElement('button')
    button.textContent = label
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.addEventListener('mousedown', event => event.preventDefault())
    const open = async () => {
      if (button.getAttribute('aria-expanded') === 'true') return
      const rect = button.getBoundingClientRect()
      button.setAttribute('aria-expanded', 'true')
      if (document.activeElement === host) restoreEditor()
      try { await ipcRenderer.invoke('desktop:chrome-menu', index ? 'edit' : 'application', rect.left, rect.bottom) }
      catch (error) { console.error('Menu failed to open:', error) }
      finally { button.setAttribute('aria-expanded', 'false') }
    }
    button.addEventListener('click', open)
    button.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        if (event.key === 'ArrowDown') void open()
        else buttons[1 - index].focus()
      }
    })
    bar.append(button)
    return button
  })
  window.addEventListener('desktop-menu-language', () => {
    bar.setAttribute('aria-label', currentLanguage === 'en' ? 'App menu' : '应用菜单')
    buttons.forEach((button, i) => { button.textContent = (currentLanguage === 'en' ? ['App', 'Edit'] : ['应用', '编辑'])[i] })
  })
  shadow.append(style, bar)
  document.body.append(host)
}

/** 读取内核的实际主题 token，转成原生标题栏支持的 RGB。 */
function watchPalette() {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-bg-base)'
  document.body.append(probe)
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  let last = '', pending = false
  const hex = color => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const rgb = context.getImageData(0, 0, 1, 1).data
    return '#' + Array.from(rgb).slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')
  }
  const read = () => {
    pending = false
    if (!getComputedStyle(probe).getPropertyValue('--dsw-specific-sidebar-fill').trim()) return
    const computed = getComputedStyle(probe)
    const value = { sidebar: hex(computed.backgroundColor), content: hex(computed.borderTopColor), text: hex(computed.color),
      dark: document.body.hasAttribute('data-ds-dark-theme') || document.documentElement.hasAttribute('data-ds-dark-theme'),
      source: document.documentElement.dataset.dsThemeSource,
      language: document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en' }
    const next = JSON.stringify(value)
    if (next !== last) { last = next; ipcRenderer.send('desktop:chrome-palette', value) }
  }
  const schedule = () => { if (!pending) { pending = true; queueMicrotask(read) } }
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'data-ds-theme-source', 'lang'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule)
  read()
}

if (initialState) {
  let state = initialState
  ipcRenderer.on('desktop:chrome-state', (_event, next) => {
    state = next
    if (document.documentElement) applyState(state)
    window.dispatchEvent(new Event('desktop-menu-language'))
  })
  window.addEventListener('resize', () => { applyState(state); ipcRenderer.send('desktop:chrome-resize') })
  window.addEventListener('DOMContentLoaded', () => {
    applyState(state)
    if ((state.local && state.platform !== 'linux') || state.platform === 'darwin') {
      const title = document.createElement('header')
      title.id = 'desktop-titlebar'
      title.textContent = state.purpose === 'settings' ? (currentLanguage === 'en' ? 'Configuration center' : '配置中心') : 'DeepSeek Harness'
      document.body.prepend(title)
    }
    if (!state.local) {
      if (state.platform === 'win32') mountMenu()
      watchPalette()
    }
  }, { once: true })
}
