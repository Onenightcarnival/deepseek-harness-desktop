'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const run = spawnSync(process.env.DSHDESKTOP_TEST_ELECTRON || require('electron'), [__filename],
    { env, windowsHide: true, stdio: 'inherit', timeout: 180000 })
  if (run.error) console.error(run.error)
  process.exit(run.status ?? 1)
}
const { app, BrowserWindow, ipcMain, nativeTheme, Menu, webContents } = require('electron')
const { createWindowChrome } = require('../window-chrome.js')
const { createDesktopBrowser } = require('../desktop-browser.js')
const runtime = process.env.DSHDESKTOP_TEST_RUNTIME || path.join(root, 'staging/win32-x64/dsh')
const work = fs.mkdtempSync(path.join(root, 'staging/browser-test-'))
const home = path.join(work, 'home')
fs.mkdirSync(home)
if (process.env.DSHDESKTOP_TEST_FULL === '1') {
  const presets = JSON.parse(fs.readFileSync(path.join(runtime, 'preset-plugins.json'), 'utf8'))
  const profile = path.join(home, 'profiles/web')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true,
    dependencies: presets.seed, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(presets.seed)] } } }))
}
app.setPath('userData', path.join(work, 'user-data'))
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
let main, kernel, fixtures, browser, origin
let kernelLog = ''
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await pause(100) }
  throw new Error('Timed out: ' + label)
}
const js = source => main.webContents.executeJavaScript(source)
function key(contents, keyCode, modifiers = []) {
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}
const primary = process.platform === 'darwin' ? 'meta' : 'control'
app.whenReady().then(async () => {
  fixtures = require('node:http').createServer((request, response) => {
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Type', 'text/html')
    if (request.url === '/download') {
      response.setHeader('Content-Disposition', 'attachment; filename=test.txt')
      response.end('download')
    } else response.end(`<title>Browser fixture ${request.url}</title><input id="field"><a href="/second">Next</a><a id="popup" href="/popup" target="_blank">Popup</a><script>window.pageInstance=crypto.randomUUID()</script>`)
  })
  await new Promise(resolve => fixtures.listen(0, '127.0.0.1', resolve))
  const fixtureUrl = `http://127.0.0.1:${fixtures.address().port}/first`
  kernel = spawn(process.execPath, ['--expose-internals', path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'web', '--patch', path.join(root, 'desktop-patch.yml'), '--no-open', '--port', '0'], {
    cwd: home, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_AGENTS_HOME: path.join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  kernel.stdout.on('data', value => { kernelLog += value })
  kernel.stderr.on('data', value => { kernelLog += value })
  await waitFor(() => /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/.test(kernelLog), 'kernel ready', 60000)
  origin = kernelLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/)[1]
  browser = createDesktopBrowser({ getWindow: () => main, getUrl: () => origin, runtimeDir: runtime,
    userData: app.getPath('userData'), updateMenu: () => {} })
  const chrome = createWindowChrome({ ipcMain, nativeTheme, Menu, getOrigin: () => origin })
  main = new BrowserWindow({ width: 1360, height: 900, show: false, ...chrome.options(),
    webPreferences: { preload: path.join(root, 'preload-desktop.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false } })
  chrome.attach(main, 'main')
  browser.attach(main)
  main.webContents.on('preload-error', (_event, _file, error) => { throw error })
  main.webContents.on('console-message', event => {
    if (event.level === 'error') fs.appendFileSync(path.join(work, 'console.log'), event.message + '\n')
  })
  await main.loadURL(origin)
  await waitFor(() => js('!!document.querySelector("[data-shell-overlay]")'), 'application UI')
  assert.equal(await js('typeof dshDesktop.browser.acquire'), 'function')
  assert.equal(await js('document.documentElement.dataset.platform'), process.platform)
  await js(`Array.from(document.querySelectorAll('button')).find(b=>/^(继续|Continue)$/.test(b.textContent.trim()))?.click()`)
  main.show(); main.focus(); await pause(500)
  key(main.webContents, 't', [primary])
  await waitFor(() => js(`!!document.querySelector('input[placeholder*="HTTP(S)"]')`), 'Ctrl+T Browser tab')
  await js(`(() => { const input=document.querySelector('input[placeholder*="HTTP(S)"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(fixtureUrl)});
    input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await pause(150)
  await js(`document.querySelector('input[placeholder*="HTTP(S)"]').closest('form').requestSubmit()`)
  await waitFor(() => webContents.getAllWebContents().some(c => c.getType() === 'webview' && c.getURL() === fixtureUrl), 'guest navigation')
  const guest = webContents.getAllWebContents().find(c => c.getType() === 'webview' && c.getURL() === fixtureUrl)
  await waitFor(() => guest.executeJavaScript('!!window.pageInstance'), 'guest DOM')
  assert.deepEqual(await guest.executeJavaScript('[typeof require,typeof process,typeof dshDesktop]'), ['undefined','undefined','undefined'])
  const prefs = guest.getLastWebPreferences()
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.preload, undefined)
  console.log('PASS: official Browser UI, Ctrl+T, X-Frame-Options page, isolated sandboxed guest')
  const instance = await guest.executeJavaScript('window.pageInstance')
  await js(`document.querySelector('webview').focus()`)
  guest.focus(); key(guest, 't', [primary])
  await waitFor(() => js(`document.querySelectorAll('input[placeholder*="HTTP(S)"]').length===2`), 'guest Ctrl+T')
  assert.equal(await guest.executeJavaScript('window.pageInstance'), instance)
  console.log('PASS: focused guest shortcut and retained page across tab switch')

  // Lease ownership and workspace storage are checked through the production preload API.
  const partitions = await js(`(async()=>{const a=await dshDesktop.browser.acquire('workspace:test');const b=await dshDesktop.browser.acquire('workspace:test');const c=await dshDesktop.browser.acquire('workspace:other');await Promise.all([a,b,c].map(v=>dshDesktop.browser.release(v.lease)));return [a.partition,b.partition,c.partition]})()`)
  assert.equal(partitions[0], partitions[1]); assert.notEqual(partitions[0], partitions[2]); assert(!partitions[0].startsWith('persist:'))
  assert.equal(guest.session.getStoragePath(), null)
  let denied = false
  try { await guest.loadURL(new URL(origin).origin) } catch { denied = true }
  assert(denied, 'guest cannot request authenticated host')
  await guest.loadURL(fixtureUrl)
  await waitFor(() => guest.executeJavaScript('!!window.pageInstance'), 'guest reload')
  const permission = await guest.executeJavaScript(`navigator.permissions.query({name:'geolocation'}).then(p=>p.state)`)
  assert.equal(permission, 'denied')
  await guest.executeJavaScript(`document.querySelector('#popup').click()`, true)
  await waitFor(() => webContents.getAllWebContents().some(c => c.getType() === 'webview' && c.getURL().endsWith('/popup')), 'popup sidebar tab')
  const popup = webContents.getAllWebContents().find(c => c.getType() === 'webview' && c.getURL().endsWith('/popup'))
  await waitFor(() => popup.executeJavaScript('!!window.pageInstance'), 'popup loaded')
  const popupRoot = `(() => { let el=Array.from(document.querySelectorAll('webview')).find(v=>v.getWebContentsId()===${popup.id}); while(el&&!el.querySelector('form'))el=el.parentElement; return el; })()`
  await waitFor(() => js(`${popupRoot}.querySelector('input').value.endsWith('/popup') && !${popupRoot}.innerText.includes('正在打开')`), 'popup controller ready')
  await pause(200)
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  console.log('PASS: shared workspace partitions, host access denied, guest permissions denied, popup becomes sidebar tab')
  void popup.executeJavaScript(`document.querySelector('a').click()`, true).catch(() => {})
  await waitFor(() => popup.getURL().endsWith('/second') && !popup.isLoading(), 'native navigation')
  await waitFor(() => js(`Array.from(${popupRoot}.querySelectorAll('button[aria-label]')).some(b=>/^(后退|Back)$/.test(b.getAttribute('aria-label'))&&!b.disabled)`), 'back enabled')
  await js(`Array.from(${popupRoot}.querySelectorAll('button[aria-label]')).find(b=>/^(后退|Back)$/.test(b.getAttribute('aria-label'))).click()`)
  await waitFor(() => popup.getURL().endsWith('/popup') && !popup.isLoading(), 'toolbar back')
  await waitFor(() => js(`Array.from(${popupRoot}.querySelectorAll('button[aria-label]')).some(b=>/^(前进|Forward)$/.test(b.getAttribute('aria-label'))&&!b.disabled)`), 'forward enabled')
  await js(`Array.from(${popupRoot}.querySelectorAll('button[aria-label]')).find(b=>/^(前进|Forward)$/.test(b.getAttribute('aria-label'))).click()`)
  await waitFor(() => popup.getURL().endsWith('/second') && !popup.isLoading(), 'toolbar forward')
  const beforeReload = await popup.executeJavaScript('window.pageInstance')
  await js(`Array.from(document.querySelectorAll('webview')).find(v=>v.getWebContentsId()===${popup.id}).focus()`)
  popup.focus(); key(popup, 'r', [primary])
  await waitFor(async () => !popup.isLoading() && await popup.executeJavaScript('window.pageInstance') !== beforeReload, 'guest Ctrl+R')
  await main.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }).then(image => fs.writeFileSync(path.join(work, 'browser.png'), image.toPNG()))
  popup.focus(); key(popup, 'w', [primary])
  await waitFor(() => popup.isDestroyed(), 'guest Ctrl+W')
  assert(!main.isDestroyed())
  console.log('PASS: toolbar history, focused guest refresh and close shortcuts')

  const { assertDesktopSender } = require('../desktop-browser-ipc.js')
  assert.throws(() => assertDesktopSender({ sender: guest, senderFrame: guest.mainFrame }))
  assert.throws(() => assertDesktopSender({ sender: main.webContents, senderFrame: { url: origin } }))
  console.log('PASS: guest and non-main frames cannot use product IPC')
  const mainOrigin = new URL(origin).origin
  await main.loadFile(path.join(root, 'splash.html'))
  await waitFor(() => guest.isDestroyed(), 'guest teardown on application navigation')
  assert.equal(await js('typeof dshDesktop'), 'undefined')
  assert.equal(await js('document.documentElement.hasAttribute("data-platform")'), false)
  assert(mainOrigin.startsWith('http://127.0.0.1:'))
  console.log('PASS: main-frame IPC isolation and guest cleanup; artifacts:', work)
}).catch(async error => {
  console.error(error); process.exitCode = 1
  if (main && !main.isDestroyed()) {
    fs.writeFileSync(path.join(work, 'failure.txt'), await js('document.body.innerText').catch(() => ''))
    await main.webContents.capturePage().then(image => fs.writeFileSync(path.join(work, 'failure.png'), image.toPNG())).catch(() => {})
  }
}).finally(() => {
  fs.writeFileSync(path.join(work, 'kernel.log'), kernelLog)
  main?.destroy(); browser?.dispose(); fixtures?.close()
  if (kernel && kernel.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(kernel.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else kernel.kill()
  }
  app.exit(process.exitCode || 0)
})
