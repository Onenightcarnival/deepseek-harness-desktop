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

if (process.platform === 'win32') {
  try { patchChildProcess(require('child_process')) } catch { /* never break the host process */ }
}

module.exports = { patchChildProcess, withHide }
