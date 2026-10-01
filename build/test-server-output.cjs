'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const { once } = require('node:events')
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
const implementation = source.slice(source.indexOf('async function startServer()'), source.indexOf('function createWindow()'))
async function test() {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  const chunks = []
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
  const noop = () => {}
  const context = vm.createContext({
    path, process: { env: {}, platform: 'win32', execPath: process.execPath }, setTimeout, clearTimeout,
    app: { getPath: () => __dirname }, activeRuntime: { dir: __dirname },
    fs: { existsSync: () => true, writeFileSync: noop, createWriteStream: () => output },
    dshEntry: () => 'kernel.js', logFile: () => 'dsh-server.log',
    ensureDesktopPlugins: noop, syncPresetPlugins: noop, healUnresolvableEntries: noop,
    writeCliLaunchers: () => __dirname, prependEnvPath: noop, withProxyEnv: noop, withNodePreloadEnv: noop,
    nodePreloadArgs: () => [], desktopPatchArgs: () => [], pickerPatchArgs: () => [],
    onServerMessage: noop, STARTUP_TIMEOUT_MS: 1000,
    READY_RE: /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/,
    spawn(_exe, _args, options) {
      assert.equal(options.env.PYTHONUTF8, '1')
      assert.equal(options.env.PYTHONIOENCODING, 'utf-8')
      return child
    },
  })
  const ready = vm.runInContext(implementation + '; startServer()', context)
  const stdout = Buffer.from('中文 ▀▄ 🐋\n')
  const stderr = Buffer.from('错误 ⚠\n')
  for (let i = 0; i < Math.max(stdout.length, stderr.length); i++) {
    if (i < stdout.length) child.stdout.write(stdout.subarray(i, i + 1))
    if (i < stderr.length) child.stderr.write(stderr.subarray(i, i + 1))
  }
  child.stdout.end('dsh web: http://127.0.0.1:1234/?token=test\n')
  child.stderr.end()
  assert.equal(await ready, 'http://127.0.0.1:1234/?token=test')
  const finished = once(output, 'finish')
  child.emit('close', 0)
  await finished
  const text = Buffer.concat(chunks).toString('utf8')
  assert(!text.includes('\uFFFD'), text)
  for (const char of '中文▀▄🐋错误⚠') assert(text.includes(char), char)
  console.log('PASS actual server output capture: interleaved UTF-8, ready URL and Python encoding')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
