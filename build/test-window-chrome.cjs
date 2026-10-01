'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'staging', 'window-chrome-test')

// node 入口启动独立 Electron 测试进程；只使用 staging 下的用户数据。
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const run = spawnSync(process.env.DSHDESKTOP_TEST_ELECTRON || require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit', timeout: 120000 })
  if (run.error) console.error(run.error)
  process.exit(run.status ?? 1)
}

const { app, BrowserWindow, ipcMain, nativeTheme, Menu } = require('electron')
const { chromeOptions, chromePalette, trustedChromeUrl, createWindowChrome } = require('../window-chrome.js')
app.setPath('userData', path.join(output, `user-data-${process.pid}`))
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const windows = []
let server
let kernel
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true })
  const light = chromePalette(false), dark = chromePalette(true)
  assert.equal(chromeOptions('win32', dark).titleBarOverlay.height, 40)
  assert.equal(chromeOptions('darwin', light).titleBarStyle, 'hiddenInset')
  assert.equal(chromeOptions('darwin', dark).backgroundColor, dark.sidebar)
  assert.equal(chromeOptions('darwin', dark).vibrancy, undefined)
  assert.equal(chromeOptions('linux', dark).titleBarStyle, undefined)
  const settingsUrl = pathToFileURL(path.join(root, 'plugins.html')).href
  assert(trustedChromeUrl(settingsUrl, 'settings', null))
  assert(!trustedChromeUrl(settingsUrl + '?foreign', 'settings', null))
  assert(!trustedChromeUrl('http://127.0.0.1:1235/', 'main', 'http://127.0.0.1:1234/'))
  assert(!trustedChromeUrl('http://127.0.0.1:1234/', 'settings', 'http://127.0.0.1:1234/'))

  // 使用内核相同的公开主题 token 和 frame DOM 契约。
  server = require('node:http').createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html><head><style>
      html,body{height:100%;margin:0}body{--dsw-specific-sidebar-fill:#f9fafb;--dsw-alias-label-primary:#0f1115;--dsw-alias-bg-base:#fff}
      body[data-ds-dark-theme]{--dsw-specific-sidebar-fill:#1b1b1c;--dsw-alias-label-primary:#f9fafb;--dsw-alias-bg-base:#141414}
      .frame{padding-top:var(--dsh-windows-titlebar-height);height:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base)}
      .frame:before{content:'';position:absolute;inset:0 0 auto;height:var(--dsh-windows-titlebar-height);background:var(--dsw-specific-sidebar-fill);-webkit-app-region:drag}
      </style></head><body><div class="frame"><div data-shell-overlay></div><input id="editor" value="菜单焦点测试"></div></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let activeOrigin = origin
  nativeTheme.themeSource = 'light'
  let language = 'zh'
  const chrome = createWindowChrome({ ipcMain, nativeTheme, Menu, getOrigin: () => activeOrigin, getLanguage: () => language, onLanguage: value => { language = value } })
  let saved = null
  ipcMain.handle('plugins:list', () => ({ deps: { 'dsh-toolkit': '0.7.0' }, bundles: ['dsh-toolkit'] }))
  ipcMain.handle('general:get', () => ({ settings: {}, platform: process.platform }))
  ipcMain.handle('general:save', (_event, settings) => { saved = settings; return { ok: true, settings } })
  ipcMain.handle('proxy:get', () => ({ mode: 'none' }))
  const popup = Menu.buildFromTemplate([{ role: 'copy' }, { role: 'paste' }])
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { id: 'desktop-application', label: '应用', submenu: [{ label: '测试' }] },
    { id: 'desktop-edit', label: '编辑', submenu: popup },
  ]))
  function create(purpose) {
    const win = new BrowserWindow({ width: 960, height: 700, show: false, ...chrome.options(),
      webPreferences: { preload: path.join(root, 'preload-desktop.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    windows.push(win)
    chrome.attach(win, purpose)
    win.webContents.on('preload-error', (_e, _file, error) => { throw error })
    return win
  }
  const settings = create('settings')
  const js = source => settings.webContents.executeJavaScript(source)
  await settings.loadFile(path.join(root, 'plugins.html'))
  await pause(250)
  assert.equal(await js('typeof pluginApi.generalGet'), 'function')
  assert.equal(await js('typeof startupApi'), 'undefined')
  assert.equal(await js('typeof require'), 'undefined')
  assert.equal(Math.round(await js('document.querySelector("#content").getBoundingClientRect().top')), process.platform === 'win32' ? 40 : process.platform === 'darwin' ? 48 : 0)
  assert.equal(await js('getComputedStyle(document.querySelector("#content")).borderTopLeftRadius'), '16px')
  const capture = async name => {
    await settings.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await pause(150)
    fs.writeFileSync(path.join(output, name + '.png'), (await settings.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  }
  await capture('settings-light')
  for (const pane of ['general', 'proxy', 'plugins']) {
    await js(`document.querySelector('[data-pane="${pane}"]').click()`)
    assert.equal(await js('document.querySelector(".pane.active").id'), `pane-${pane}`)
  }
  await js(`document.querySelector('[data-pane="general"]').click(); document.querySelector('#g-rows input').click()`)
  await pause(100)
  assert.equal(saved.openAtLogin, true)
  await js(`document.querySelector('[data-pane="plugins"]').click(); document.querySelector('#spec').focus()`)
  settings.webContents.insertText('test-input')
  await pause(100)
  assert.equal(await js('document.querySelector("#spec").value'), 'test-input')

  const main = create('main')
  await main.loadURL(origin)
  await pause(250)
  assert.equal(await main.webContents.executeJavaScript('typeof pluginApi'), 'undefined')
  await main.webContents.executeJavaScript('document.body.setAttribute("data-ds-dark-theme", "")')
  await pause(250)
  assert.equal(await js('getComputedStyle(document.querySelector("#content")).backgroundColor'), 'rgb(20, 20, 20)')
  assert.equal(nativeTheme.themeSource, 'dark', '原生菜单跟随深色页面')
  await main.webContents.executeJavaScript('document.documentElement.dataset.dsThemeSource = "light"; document.body.removeAttribute("data-ds-dark-theme")')
  await pause(200)
  assert.equal(nativeTheme.themeSource, 'light', '原生菜单跟随浅色页面')
  await main.webContents.executeJavaScript('document.documentElement.dataset.dsThemeSource = "system"')
  await pause(200)
  assert.equal(nativeTheme.themeSource, 'system', '跟随系统不固定深浅模式')
  await main.webContents.executeJavaScript('document.documentElement.dataset.dsThemeSource = "dark"; document.body.setAttribute("data-ds-dark-theme", "")')
  await pause(200)
  await main.webContents.executeJavaScript('document.documentElement.lang = "en"')
  await pause(250)
  assert.equal(await js('document.documentElement.lang'), 'en')
  assert.equal(await js('document.querySelector("#spec").value'), 'test-input')
  await js(`document.querySelector('[data-pane="proxy"]').click()`)
  assert(!/[\u4e00-\u9fff]/.test(await js('document.querySelector(".pane.active").innerText')), 'English proxy page must not contain Chinese UI text')
  await capture('settings-english')
  await main.webContents.executeJavaScript('document.documentElement.lang = "zh"')
  await pause(250)
  assert.equal(await js('document.documentElement.lang'), 'zh')
  await capture('settings-dark')
  if (process.platform === 'win32') {
    const safe = await main.webContents.executeJavaScript(`(() => {
      const el = document.createElement('div'); el.style.width='env(titlebar-area-width)';document.body.append(el);
      return { safe: el.getBoundingClientRect().width, drag:parseFloat(getComputedStyle(document.querySelector('.frame'),'::before').width), width:innerWidth }
    })()`)
    assert(safe.safe < safe.width, JSON.stringify(safe))
    assert.equal(safe.drag, safe.safe)
    let shown = false
    popup.once('menu-will-show', () => { shown = true; setTimeout(() => popup.closePopup(main), 100) })
    await main.webContents.executeJavaScript(`document.querySelector('#desktop-menu').shadowRoot.querySelectorAll('button')[1].click()`)
    await pause(300)
    assert(shown, '原生编辑菜单应打开')
    main.show()
    main.focus()
    await pause(150)
    await main.webContents.executeJavaScript(`document.querySelector('#editor').focus(); document.querySelector('#editor').setSelectionRange(0, 2); document.querySelector('#desktop-menu').shadowRoot.querySelectorAll('button')[1].focus()`)
    popup.once('menu-will-show', () => setTimeout(() => popup.closePopup(main), 100))
    await main.webContents.executeJavaScript(`document.querySelector('#desktop-menu').shadowRoot.querySelectorAll('button')[1].click()`)
    await pause(200)
    assert.equal(await main.webContents.executeJavaScript('document.activeElement.id'), 'editor')
    assert.equal(await main.webContents.executeJavaScript('document.querySelector("#editor").selectionEnd'), 2)
  }
  settings.setSize(760, 540)
  await pause(100)
  assert(await js('document.documentElement.scrollWidth <= innerWidth'))
  await capture('settings-small')
  settings.webContents.setZoomFactor(1.25)
  await pause(150)
  if (process.platform === 'win32') assert(Math.abs(await js('document.querySelector("#content").getBoundingClientRect().top') - 40) < 0.01)
  settings.webContents.setZoomFactor(1)
  settings.showInactive()
  await pause(150)
  settings.setFullScreen(true)
  await pause(700)
  assert.equal(await js('document.documentElement.hasAttribute("data-fullscreen")'), settings.isFullScreen())
  if (settings.isFullScreen()) assert.equal(await js('document.querySelector("#content").getBoundingClientRect().top'), 0)
  settings.setFullScreen(false)
  await pause(700)
  // macOS 布局模拟；原生红黄绿按钮 需在 macOS 运行本测试验收。
  settings.setSize(960, 700)
  await pause(100)
  await js(`document.documentElement.dataset.desktopPlatform='darwin';document.documentElement.style.setProperty('--desktop-titlebar-height','48px')`)
  assert.equal(await js('getComputedStyle(document.body).backgroundColor'), await js('getComputedStyle(document.querySelector("#desktop-titlebar")).backgroundColor'))
  await capture('settings-mac-layout')
  if (process.env.DSHDESKTOP_TEST_RUNTIME && process.env.DSHDESKTOP_TEST_HOME) {
    const { spawn } = require('node:child_process')
    const home = path.resolve(process.env.DSHDESKTOP_TEST_HOME)
    assert(home.startsWith(path.join(root, 'staging') + path.sep), '内核测试 home 必须在 staging 内')
    const entry = path.join(path.resolve(process.env.DSHDESKTOP_TEST_RUNTIME), 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    kernel = spawn(process.execPath, ['--expose-internals', '--require', path.join(root, 'win-spawn-shim.js'), entry,
      'web', '--no-open', '--port', '0'], { cwd: home, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_AGENTS_HOME: path.join(home, 'agents') }, stdio: ['ignore', 'pipe', 'pipe'] })
    const url = await new Promise((resolve, reject) => {
      let log = ''
      const timer = setTimeout(() => reject(new Error('内核启动超时: ' + log.slice(-2000))), 60000)
      const data = buffer => {
        log += buffer.toString()
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/.exec(log)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      }
      kernel.stdout.on('data', data)
      kernel.stderr.on('data', data)
      kernel.once('error', error => { clearTimeout(timer); reject(error) })
      kernel.once('exit', code => { clearTimeout(timer); reject(new Error(`内核退出 ${code}: ${log.slice(-2000)}`)) })
    })
    activeOrigin = url
    main.webContents.on('console-message', event => {
      if (event.level === 'warning' || event.level === 'error') fs.appendFileSync(path.join(output, 'runtime-console.log'), event.message + '\n')
    })
    await main.loadURL(url)
    for (let i = 0; i < 100; i++) {
      if (await main.webContents.executeJavaScript('!!document.querySelector("[data-shell-overlay]")')) break
      await pause(200)
    }
    assert(await main.webContents.executeJavaScript('!!document.querySelector("[data-shell-overlay]")'),
      '真实内核 frame 应完成加载: ' + await main.webContents.executeJavaScript('document.body.innerText.slice(0, 3000)'))
    if (process.platform === 'win32') assert(await main.webContents.executeJavaScript('document.documentElement.hasAttribute("data-windows-titlebar")'))
    assert.equal(await main.webContents.executeJavaScript('document.documentElement.hasAttribute("data-platform")'), false, 'Web 壳不得启用官方专用键盘协议')
    assert.equal(await main.webContents.executeJavaScript('typeof pluginApi'), 'undefined')
    await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => /^(继续|Continue)$/.test(button.textContent.trim()))?.click()`)
    await pause(250)
    await main.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await pause(200)
    fs.writeFileSync(path.join(output, 'main-runtime.png'), (await main.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
    if (process.platform === 'darwin') {
      const page = script => main.webContents.executeJavaScript(script)
      main.show(); main.focus()
      const clickControl = async selector => {
        const point = await page(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
        const zoom = main.webContents.getZoomFactor()
        const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
        main.webContents.sendInputEvent({ type: 'mouseMove', ...position })
        main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
        main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
      }
      const toggle = async () => clickControl(await page('document.querySelector("[data-desktop-frame]").hasAttribute("data-sidebar-collapsed")') ? '[data-desktop-leading-toggle]' : '[data-desktop-sidebar-toggle]')
      const setTheme = async label => {
        await page(`Array.from(document.querySelectorAll('button')).find(button => /^(Settings|设置)$/.test(button.textContent.trim())).click()`)
        await pause(200)
        await page(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
        main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        await pause(500)
      }
      const snapshot = () => page(`(() => {
        const frame=document.querySelector('[data-desktop-frame]'), center=document.querySelector('[data-desktop-center]'), sidebar=document.querySelector('[data-desktop-sidebar]');
        const control=document.querySelector(frame.hasAttribute('data-sidebar-collapsed') ? '[data-desktop-leading-toggle]' : '[data-desktop-sidebar-toggle]');
        return {top:center.getBoundingClientRect().top, sidebar:sidebar.getBoundingClientRect().width, collapsed:frame.hasAttribute('data-sidebar-collapsed'), visible:control.contains(document.elementFromPoint(control.getBoundingClientRect().x+14, control.getBoundingClientRect().y+14)), controlX:control.getBoundingClientRect().x, controlY:control.getBoundingClientRect().y, radius:getComputedStyle(center).borderTopLeftRadius, overflow:document.documentElement.scrollWidth>innerWidth};
      })()`)
      if ((await snapshot()).collapsed) { await toggle(); await pause(700) }
      await setTheme('Light')
      let layout = await snapshot()
      assert.equal(layout.top, 0, JSON.stringify(layout))
      assert(layout.sidebar >= 200, JSON.stringify(layout))
      assert.equal(layout.radius, '0px')
      assert(layout.controlY >= 0 && layout.controlY < 48, JSON.stringify(layout))
      assert(await page('document.querySelector("[data-desktop-logo-row]").getBoundingClientRect().top >= 48'), '品牌行应位于原生窗口按钮下方')
      assert.equal(layout.overflow, false)
      assert.equal(layout.visible, true, JSON.stringify(layout))
      const captureMain = async name => fs.writeFileSync(path.join(output, name + '.png'), (await main.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
      await captureMain('main-mac-integrated-light')
      await setTheme('Dark')
      assert(await page('document.body.hasAttribute("data-ds-dark-theme")'), '深色主题应同步到内核')
      await captureMain('main-mac-integrated-dark')
      await toggle(); await pause(700)
      layout = await snapshot()
      assert.equal(layout.sidebar, 0, JSON.stringify(layout))
      assert.equal(layout.top, 0, JSON.stringify(layout))
      assert(layout.controlX >= 88, JSON.stringify(layout))
      assert.equal(layout.overflow, false)
      assert.equal(layout.visible, true, JSON.stringify(layout))
      assert(await page(`(() => {
        const seat=document.querySelector('#desktop-leading'), button=seat.querySelector('button');
        return seat.parentElement === document.body && !seat.closest('[data-desktop-sidebar]') && getComputedStyle(seat).webkitAppRegion === 'no-drag' && getComputedStyle(button).webkitAppRegion === 'no-drag';
      })()`), '折叠入口必须位于侧栏之外的独立非拖拽区域')
      for (let i = 0; i < 3; i++) {
        await toggle(); await pause(700)
        assert((await snapshot()).sidebar >= 200, '坐标点击应展开侧栏')
        await toggle(); await pause(700)
        assert.equal((await snapshot()).sidebar, 0, '坐标点击应折叠侧栏')
      }
      await captureMain('main-mac-integrated-collapsed')
      main.webContents.setZoomFactor(1.25); await pause(300)
      layout = await snapshot()
      assert(layout.controlX * 1.25 >= 87, JSON.stringify(layout))
      assert.equal(layout.top, 0)
      await toggle(); await pause(700)
      assert((await snapshot()).sidebar >= 200, '缩放后坐标点击应展开侧栏')
      await toggle(); await pause(700)
      assert.equal((await snapshot()).sidebar, 0)
      main.webContents.setZoomFactor(1); await pause(300)
      main.show()
      main.setFullScreen(true); await pause(1200)
      if (!(await snapshot()).collapsed) { await toggle(); await pause(700) }
      layout = await snapshot()
      assert.equal(layout.top, 0)
      assert.equal(layout.controlX, 12, JSON.stringify(layout))
      assert.equal(layout.visible, true, JSON.stringify(layout))
      main.setFullScreen(false); await pause(1200)
      if ((await snapshot()).collapsed) { await toggle(); await pause(700) }
      assert((await snapshot()).sidebar >= 200, '侧栏应能重新展开')
      main.hide()
      console.log('PASS: coordinate clicks, independent leading controls, integrated Mac frame, sidebar toggle, native-button clearance and zoom')
    }
    console.log('PASS: real staged kernel and full profile UI')
  }
  await main.loadFile(path.join(root, 'splash.html'))
  assert.equal(await main.webContents.executeJavaScript('typeof startupApi'), 'undefined')
  assert.equal(await main.webContents.executeJavaScript('document.querySelector(".log")'), null)
  assert.equal(await main.webContents.executeJavaScript('typeof pluginApi'), 'undefined')
  // 设置窗口导航到其他来源后不得保留配置桥。
  await settings.loadURL(origin)
  assert.equal(await js('typeof pluginApi'), 'undefined')
  assert.equal(await js('document.documentElement.hasAttribute("data-desktop-platform")'), false)
  console.log('PASS: native options, trusted origins, isolated preload, themes, pane controls, menu popup, safe caption region, minimum size; screenshots:', output)
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
  server?.close()
  if (kernel && kernel.exitCode === null) {
    if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill.exe', ['/PID', String(kernel.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else kernel.kill()
  }
  app.exit(process.exitCode || 0)
})
