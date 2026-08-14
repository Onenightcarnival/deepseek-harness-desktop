/**
 * Runtime selection and version logic for the desktop shell — plain CJS with
 * no Electron imports so it is unit-testable under any Node.
 *
 * A "runtime" is a directory holding node_modules/@deepseek-ai/dsh (the
 * bundled one lives in resources/dsh; upgraded ones live under
 * userData/runtimes/<version>). The active runtime is the highest-version
 * non-broken one, falling back to the bundled runtime.
 */
'use strict'
const fs = require('fs')
const path = require('path')

/** Relative path from a runtime dir to the dsh CLI entry. */
const ENTRY_REL = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** Compare dotted versions; returns >0 when a is newer than b. */
function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s))
  const pa = parse(a), pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    if (x === y) continue
    // exhausted side: prerelease on the other side is older, zero is equal
    if (x === undefined) { if (typeof y === 'string') return 1; if (y === 0) continue; return -1 }
    if (y === undefined) { if (typeof x === 'string') return -1; if (x === 0) continue; return 1 }
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return 1 // numeric beats prerelease tag
    if (typeof y === 'number') return -1
    return String(x) > String(y) ? 1 : -1
  }
  return 0
}

/** Read a runtime dir's dsh version, or null when invalid. */
function runtimeVersion(dir) {
  try {
    const manifest = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
    return fs.existsSync(path.join(dir, ENTRY_REL)) ? version : null
  } catch {
    return null
  }
}

/**
 * Pick the active runtime: the highest-version valid dir under runtimesDir
 * that is newer than the bundled version; otherwise the bundled runtime.
 * @returns {{dir: string, version: string|null, bundled: boolean}}
 */
function pickRuntime(runtimesDir, bundledDir) {
  const bundledVersion = runtimeVersion(bundledDir)
  let best = { dir: bundledDir, version: bundledVersion, bundled: true }
  let entries = []
  try { entries = fs.readdirSync(runtimesDir) } catch { /* no upgrades yet */ }
  for (const name of entries) {
    if (name.startsWith('.') || name.includes('broken')) continue
    const dir = path.join(runtimesDir, name)
    const version = runtimeVersion(dir)
    if (version === null) continue
    if (best.version === null || compareVersions(version, best.version) > 0) {
      best = { dir, version, bundled: false }
    }
  }
  return best
}

/**
 * Rough semver-range check for an engines.node expression like
 * "^22.19.0 || >=24.0.0" against a concrete version. Unknown syntax counts
 * as satisfied (the boot-failure fallback is the real safety net).
 */
function satisfiesNode(nodeVersion, enginesExpr) {
  if (!enginesExpr) return true
  const v = String(nodeVersion).replace(/^v/, '')
  const ranges = String(enginesExpr).split('||').map((s) => s.trim()).filter(Boolean)
  if (ranges.length === 0) return true
  for (const range of ranges) {
    let m
    if ((m = /^>=\s*([\d.]+)$/.exec(range))) {
      if (compareVersions(v, m[1]) >= 0) return true
    } else if ((m = /^\^\s*([\d.]+)$/.exec(range))) {
      const base = m[1]
      const major = base.split('.')[0]
      if (v.split('.')[0] === major && compareVersions(v, base) >= 0) return true
    } else {
      return true // unknown range syntax: don't block the upgrade
    }
  }
  return false
}

module.exports = { ENTRY_REL, compareVersions, runtimeVersion, pickRuntime, satisfiesNode }
