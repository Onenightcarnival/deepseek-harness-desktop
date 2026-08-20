'use strict'
/**
 * Preloaded (--require) into every Node child the shell spawns — the dsh
 * server, the dsh CLI runner, pnpm — to stop console windows flashing on
 * Windows.
 *
 * Why: our processes are GUI-subsystem (Electron), so any console-subsystem
 * grandchild (pwsh/cmd/git) spawned WITHOUT windowsHide gets a brand-new
 * visible console host — a black window that pops up and vanishes on every
 * shell command dsh runs. In a terminal nobody notices (children inherit the
 * console); packaged as a GUI app it is a constant flicker. We cannot patch
 * dsh's own spawn call sites, but we are the ones launching dsh's Node, so a
 * preload can default `windowsHide: true` for the whole process.
 *
 * Only a MISSING windowsHide is filled in; an explicit `windowsHide: false`
 * (something intentionally showing a window) is preserved. node-pty terminals
 * are unaffected (native ConPTY, not child_process). No-op off Windows.
 */

/** Insert/patch the options argument of a child_process-style call. */
function withHide(args) {
  const a = Array.prototype.slice.call(args)
  for (let i = 1; i < a.length; i++) {
    const v = a[i]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (v.windowsHide === undefined) a[i] = { ...v, windowsHide: true }
      return a
    }
    if (typeof v === 'function') break // callback reached — no options given
  }
  const opts = { windowsHide: true }
  if (typeof a[a.length - 1] === 'function') a.splice(a.length - 1, 0, opts)
  else a.push(opts)
  return a
}

/**
 * Patch spawn/exec-family on a child_process-like object. Exported separately
 * so plain-node unit tests can drive it against a mock on any platform.
 * (exec/execFile call the module-internal spawn, not the export, so every
 * public entry point must be wrapped individually.)
 */
function patchChildProcess(cp) {
  const custom = require('util').promisify.custom
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const orig = cp[name]
    if (typeof orig !== 'function') continue
    const wrapped = function (...args) { return orig.apply(this, withHide(args)) }
    // Keep own symbols/props (util.promisify.custom on exec/execFile —
    // losing it silently changes promisify(exec)'s resolved value).
    for (const key of Reflect.ownKeys(orig)) {
      if (key === 'length' || key === 'name' || key === 'prototype' || key === custom) continue
      try { Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(orig, key)) } catch { /* non-configurable */ }
    }
    // The original custom promisified closes over the ORIGINAL function, so
    // promisify(exec) would bypass the wrapper — rebuild it on top of the
    // wrapped one, mirroring Node's semantics ({stdout, stderr}; rejection
    // carries stdout/stderr on the error).
    if (orig[custom]) {
      Object.defineProperty(wrapped, custom, {
        configurable: true, enumerable: false,
        value: function (...args) {
          return new Promise((resolve, reject) => {
            wrapped(...args, (err, stdout, stderr) => {
              if (err) { err.stdout = stdout; err.stderr = stderr; reject(err) } else resolve({ stdout, stderr })
            })
          })
        },
      })
    }
    cp[name] = wrapped
  }
  return cp
}

/**
 * The second, sneakier console-flash source: dsh's Windows SANDBOX launches
 * pwsh via raw CreateProcessAsUserW (koffi FFI), bypassing child_process
 * entirely — and it deliberately passes no console flag, because a
 * CREATE_NO_WINDOW child dies with STATUS_DLL_INIT_FAILED under the
 * restricted token; the child is expected to SHARE THE HOST CONSOLE. Run
 * from a terminal that console exists and nothing is visible; under the GUI
 * shell there is no console, so Windows allocates a fresh VISIBLE one per
 * pwsh call.
 *
 * Fix: give this process an invisible console to share. AllocConsole would
 * flash (and may open a Windows Terminal tab), so instead: spawn a tiny cmd
 * helper with CREATE_NO_WINDOW — its console never has a window — attach to
 * it with AttachConsole, then kill the helper (a console lives while any
 * process is attached). koffi is resolved out of the dsh runtime's own tree;
 * everything is best-effort — on any failure behavior is simply today's.
 * Gated on DSH_DESKTOP_CONSOLE_HOST=1 (main.js sets it for the dsh server
 * only) and skipped when a console already exists (CLI usage in a real
 * terminal — never touch the user's console).
 */
function setupHiddenConsole(deps = {}) {
  const env = deps.env || process.env
  const platform = deps.platform || process.platform
  if (platform !== 'win32' || env.DSH_DESKTOP_CONSOLE_HOST !== '1') return false
  try {
    const loadKoffi = deps.loadKoffi || (() => {
      const path = require('path')
      const fs = require('fs')
      const entry = process.argv[1]
      const bases = entry ? [path.dirname(entry)] : []
      // npm-installed (bundled) runtimes have koffi at top level; pnpm-installed
      // (upgraded) ones hide it under .pnpm — resolve from a package that
      // depends on it.
      try {
        const acl = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/package.json', { paths: bases })
        bases.push(path.dirname(fs.realpathSync(acl)))
      } catch { /* not present in this runtime */ }
      for (const base of bases) {
        try { return require(require.resolve('koffi', { paths: [base] })) } catch { /* next */ }
      }
      return null
    })
    // Outcome lines land in dsh-server.log via the server's stderr — the
    // only remote-debuggable signal for why sandboxed pwsh still flashes.
    const log = deps.log || ((msg) => { try { process.stderr.write(`[dsh-desktop] hidden console host: ${msg}\n`) } catch { /* stderr gone */ } })
    const koffi = loadKoffi()
    if (!koffi) { log('koffi unresolvable — sandboxed pwsh may flash a console'); return false }
    const kernel32 = koffi.load('kernel32.dll')
    const GetConsoleCP = kernel32.func('uint32_t __stdcall GetConsoleCP()')
    const AttachConsole = kernel32.func('int __stdcall AttachConsole(uint32_t dwProcessId)')
    if (GetConsoleCP() !== 0) return false // already have a console — hands off
    const spawnHelper = deps.spawnHelper || (() => require('child_process').spawn(
      env.ComSpec || 'cmd.exe', ['/d', '/q', '/c', 'pause'],
      // stdin is a pipe we never write: `pause` blocks forever, keeping the
      // console alive until we have attached. CREATE_NO_WINDOW via windowsHide.
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
    ))
    const helper = spawnHelper()
    if (!helper || !helper.pid) return false
    if (helper.on) helper.on('error', () => { /* swallowed — cosmetic feature */ })
    const setInt = deps.setInterval || setInterval
    const clearInt = deps.clearInterval || clearInterval
    let tries = 0
    const timer = setInt(() => {
      tries++
      let attached = false
      try { attached = AttachConsole(helper.pid) !== 0 || GetConsoleCP() !== 0 } catch { /* retry */ }
      if (attached || tries >= 40) { // give up after ~4s
        clearInt(timer)
        try { helper.kill() } catch { /* already gone */ }
        log(attached ? 'attached' : 'attach failed after 40 tries — sandboxed pwsh may flash a console')
      }
    }, 100)
    if (timer && timer.unref) timer.unref()
    if (helper.unref) helper.unref()
    return true
  } catch { return false /* never break the host process */ }
}

if (process.platform === 'win32') {
  try { patchChildProcess(require('child_process')) } catch { /* never break the host process */ }
  setupHiddenConsole()
}

module.exports = { patchChildProcess, withHide, setupHiddenConsole }
