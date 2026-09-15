'use strict'
/**
 * Preloaded (--require) into every Node child the shell spawns (dsh server,
 * dsh CLI runner, pnpm) to suppress console windows on Windows.
 *
 * The host processes are GUI-subsystem (Electron); a console-subsystem
 * descendant (pwsh/cmd/git) spawned without windowsHide gets a new visible
 * console host on every shell command. The preload defaults
 * `windowsHide: true` on all child_process entry points of the process.
 *
 * Only a missing windowsHide is filled in; an explicit `windowsHide: false`
 * is preserved. node-pty terminals (native ConPTY) are unaffected. No-op off
 * Windows. Children started with this process's own executable get the shim
 * on their argv as well (withPreload), so a runner that strips NODE_OPTIONS
 * still loads it.
 */

/**
 * True once setupHiddenConsole attached this process to the shell's
 * invisible host console. Console inheritance then replaces CREATE_NO_WINDOW:
 * a windowsHide child has no console, so any console app it spawns (uv ->
 * python for a `uvx` MCP server) gets a new visible window; inheriting the
 * invisible console keeps the whole subtree windowless. An explicit
 * `windowsHide: true` is flipped and a missing value is filled the same way;
 * a detached spawn is left alone (DETACHED_PROCESS drops the console).
 */
let hostConsole = false

/** Insert/patch the options argument of a child_process-style call. */
function withHide(args) {
  const want = !hostConsole
  const a = Array.prototype.slice.call(args)
  for (let i = 1; i < a.length; i++) {
    const v = a[i]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (v.windowsHide === undefined) a[i] = { ...v, windowsHide: want }
      else if (v.windowsHide === true && hostConsole && !v.detached) a[i] = { ...v, windowsHide: false }
      return a
    }
    if (typeof v === 'function') break // callback reached; no options given
  }
  const opts = { windowsHide: want }
  if (typeof a[a.length - 1] === 'function') a.splice(a.length - 1, 0, opts)
  else a.push(opts)
  return a
}

/**
 * Carry the shim into a Node child by argv. NODE_OPTIONS reaches most
 * descendants, but dsh's subprocess runner (Glob/Grep, the Win32 Job
 * launcher) drops every NODE_* variable from its own environment; that
 * runner is a GUI-subsystem Electron binary, so it starts without a
 * console and the ripgrep it creates through CreateProcessW opens a visible
 * one. With the shim on its argv the runner attaches to the parent's
 * invisible console first. Applies to children started with this process's
 * executable and an argv array (spawn/spawnSync/execFile/execFileSync);
 * `--require` is a Node option and leaves process.argv unchanged.
 */
const SHIM_PATH = __filename
function withPreload(args, execPath) {
  const a = Array.prototype.slice.call(args)
  // `--` first means a single-file (pkg) runtime that takes no Node options.
  if (a[0] !== execPath || !Array.isArray(a[1]) || a[1][0] === '--' || a[1].includes(SHIM_PATH)) return a
  a[1] = ['--require', SHIM_PATH, ...a[1]]
  return a
}

/**
 * Patch the spawn/exec family on a child_process-like object. Exported for
 * plain-node unit tests against a mock on any platform. exec/execFile call
 * the module-internal spawn, not the export; every public entry point is
 * wrapped individually.
 */
function patchChildProcess(cp, execPath = process.execPath) {
  const custom = require('util').promisify.custom
  const argvEntry = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync'])
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const orig = cp[name]
    if (typeof orig !== 'function') continue
    const wrapped = argvEntry.has(name)
      ? function (...args) { return orig.apply(this, withHide(withPreload(args, execPath))) }
      : function (...args) { return orig.apply(this, withHide(args)) }
    // Carry over own symbols/props; util.promisify.custom on exec/execFile
    // determines promisify(exec)'s resolved value.
    for (const key of Reflect.ownKeys(orig)) {
      if (key === 'length' || key === 'name' || key === 'prototype' || key === custom) continue
      try { Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(orig, key)) } catch { /* non-configurable */ }
    }
    // The original custom promisified closes over the original function and
    // bypasses the wrapper. Rebuilt on the wrapped one with Node's semantics:
    // resolves {stdout, stderr}; rejection carries stdout/stderr on the error.
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
 * Give this process an invisible console for the sandbox to share.
 *
 * dsh's Windows sandbox launches pwsh via CreateProcessAsUserW (koffi FFI),
 * bypassing child_process, with no console flag: a CREATE_NO_WINDOW child
 * dies with STATUS_DLL_INIT_FAILED under the restricted token, so the child
 * shares the host console. Under the GUI shell there is no console and
 * Windows allocates a visible one per pwsh call.
 *
 * AllocConsole shows a window (and may open a Windows Terminal tab). Instead:
 * spawn a cmd helper with CREATE_NO_WINDOW (its console has no window),
 * AttachConsole to it, then kill the helper; a console lives while any
 * process is attached. koffi resolves from the dsh runtime's own tree. Every
 * step is best-effort; on failure the process keeps the default behavior.
 * Gated on DSHDESKTOP_CONSOLE_HOST=1 (main.js sets it for the dsh server
 * only); skipped when a console already exists (CLI usage in a terminal).
 */
function setupHiddenConsole(deps = {}) {
  const env = deps.env || process.env
  const platform = deps.platform || process.platform
  if (platform !== 'win32' || env.DSHDESKTOP_CONSOLE_HOST !== '1') return false
  // Per-process trace appended to userData/console-debug.log (path from env,
  // set by main.js): pid, the step that attached, or the failing Win32 code.
  // Size-capped.
  const dbg = deps.dbg || ((msg) => {
    // Fallback path: the shim lives in userData next to the log file main.js
    // truncates, so a scrubbed child env still traces.
    const file = env.DSHDESKTOP_CONSOLE_DEBUG_FILE || require('path').join(__dirname, 'console-debug.log')
    if (!file) return
    try {
      const fs = require('fs')
      try { if (fs.statSync(file).size > 256 * 1024) return } catch { /* new file */ }
      const tag = require('path').basename(process.argv[1] || process.execPath)
      fs.appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} ${tag}: ${msg}\n`)
    } catch { /* best effort */ }
  })
  try {
    const loadKoffi = deps.loadKoffi || (() => {
      const path = require('path')
      const fs = require('fs')
      const entry = process.argv[1]
      const bases = entry ? [path.dirname(entry)] : []
      // npm-installed (bundled) runtimes have koffi at top level;
      // pnpm-installed (upgraded) ones keep it under .pnpm, resolved through
      // a package that depends on it.
      try {
        const acl = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/package.json', { paths: bases })
        bases.push(path.dirname(fs.realpathSync(acl)))
      } catch { /* not present in this runtime */ }
      for (const base of bases) {
        try { return require(require.resolve('koffi', { paths: [base] })) } catch { /* next */ }
      }
      return null
    })
    const koffi = loadKoffi()
    if (!koffi) { dbg('koffi unresolvable'); return false }
    const kernel32 = koffi.load('kernel32.dll')
    const GetConsoleCP = kernel32.func('uint32_t __stdcall GetConsoleCP()')
    const AttachConsole = kernel32.func('int __stdcall AttachConsole(uint32_t dwProcessId)')
    const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()')
    const GetStdHandle = kernel32.func('void* __stdcall GetStdHandle(uint32_t nStdHandle)')
    const SetStdHandle = kernel32.func('int __stdcall SetStdHandle(uint32_t nStdHandle, void* hHandle)')
    if (GetConsoleCP() !== 0) { dbg('already has a console; untouched'); return false }
    // Attaching rewrites the process's std-handle table to console handles.
    // The sandbox runner reads GetStdHandle at spawn time to pass the
    // caller's pipes to pwsh; the exact values are restored after attach.
    // Node's own stdio is unaffected: libuv cached its handles at startup.
    const STD = [0xFFFFFFF6, 0xFFFFFFF5, 0xFFFFFFF4] // -10 stdin, -11 stdout, -12 stderr
    const saved = STD.map((h) => { try { return GetStdHandle(h) } catch { return null } })
    const restoreStd = () => { STD.forEach((h, i) => { try { if (saved[i] !== null) SetStdHandle(h, saved[i]) } catch { /* keep rest */ } }) }
    // Step 1: synchronous parent attach. The sandbox launches pwsh from a
    // transient runner (node runner.js -- pwsh ...) that calls
    // CreateProcessAsUserW immediately after load; the attach must complete
    // synchronously. The runner's parent is the dsh server, which carries the
    // invisible console.
    try {
      if (AttachConsole(0xFFFFFFFF) !== 0) { // ATTACH_PARENT_PROCESS
        restoreStd()
        dbg('attached to parent console')
        return true
      }
      dbg(`parent attach failed (GetLastError=${GetLastError()})`)
    } catch (e) { dbg('parent attach threw: ' + e) }
    // Step 2: helper console, also synchronous. Spawn a CREATE_NO_WINDOW cmd
    // (its console has no window), then poll AttachConsole with a blocking
    // sleep. Everything after this shim, including the sandbox spawn, runs
    // only once the console exists. Worst case blocks load for ~2s, then
    // keeps the default behavior.
    const spawnHelper = deps.spawnHelper || (() => require('child_process').spawn(
      env.ComSpec || 'cmd.exe', ['/d', '/q', '/c', 'pause'],
      // stdin is an unwritten pipe: `pause` blocks and keeps the console
      // alive until the attach completes. CREATE_NO_WINDOW via windowsHide.
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
    ))
    const sleep = deps.sleep || ((ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* spin-free fallback: give up */ } })
    const helper = spawnHelper()
    if (!helper || !helper.pid) { dbg('helper spawn failed'); return false }
    if (helper.on) helper.on('error', () => { /* best effort */ })
    let attached = false
    let lastErr = 0
    for (let i = 0; i < 40 && !attached; i++) {
      try {
        attached = AttachConsole(helper.pid) !== 0 || GetConsoleCP() !== 0
        if (!attached) lastErr = GetLastError()
      } catch { /* retry */ }
      if (!attached) sleep(50)
    }
    try { helper.kill() } catch { /* already gone */ }
    if (attached) { restoreStd(); dbg('attached via helper') } else { dbg(`helper attach failed after 40 tries (GetLastError=${lastErr})`) }
    return attached
  } catch (e) { dbg('setup threw: ' + e); return false /* host process unaffected */ }
}

if (process.platform === 'win32') {
  try { patchChildProcess(require('child_process')) } catch { /* host process unaffected */ }
  // Attach first, then set the spawn policy for the rest of the process.
  // DSHDESKTOP_INHERIT_CONSOLE=0 restores CREATE_NO_WINDOW.
  if (setupHiddenConsole() && process.env.DSHDESKTOP_INHERIT_CONSOLE !== '0') hostConsole = true
}

module.exports = { patchChildProcess, withHide, withPreload, setupHiddenConsole, _setHostConsole: (v) => { hostConsole = !!v } }
