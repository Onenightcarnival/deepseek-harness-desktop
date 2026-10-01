/**
 * Pure helpers for the desktop shell: runtime selection and version logic,
 * general settings, launcher migration and proxy environments.
 * Plain CJS with no Electron imports.
 *
 * A runtime is a directory holding node_modules/@deepseek-ai/dsh: the bundled
 * one in resources/dsh, upgraded ones under userData/runtimes/<version>. The
 * active runtime is the highest-version valid one, else the bundled one.
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
    // exhausted side: a prerelease tag on the other side is older, a zero is equal
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
  try { entries = fs.readdirSync(runtimesDir) } catch { /* no runtimes dir */ }
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
 * Rough semver-range check of a concrete version against an engines.node
 * expression like "^22.19.0 || >=24.0.0". Unknown range syntax counts as
 * satisfied; the boot-failure fallback covers that case.
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
      return true // unknown range syntax counts as satisfied
    }
  }
  return false
}

/**
 * Release line of a dsh version: major.minor.patch without the prerelease
 * tag ("0.1.2-rc.1" -> "0.1.2"). The in-app core upgrade stays within the
 * bundled core's line.
 */
function releaseLine(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v))
  return m ? `${m[1]}.${m[2]}.${m[3]}` : String(v)
}

module.exports = { ENTRY_REL, compareVersions, runtimeVersion, pickRuntime, satisfiesNode, releaseLine }

/**
 * Prepend a directory to an env object's PATH using case-insensitive key matching.
 */
function prependEnvPath(env, dir, delimiter) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
  env[key] = env[key] ? `${dir}${delimiter}${env[key]}` : dir
  return env
}
module.exports.prependEnvPath = prependEnvPath

/**
 * Proxy env vars the app owns: inherited values are removed before the app's
 * own setting is applied, and "不使用代理" yields a child environment with
 * no proxy vars. TLS vars (NODE_EXTRA_CA_CERTS) are not in this list.
 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NOPROXY',
  'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY',
]
module.exports.PROXY_ENV_KEYS = PROXY_ENV_KEYS

/**
 * Delete every proxy var from a plain env object, matching keys
 * case-insensitively (a Windows spread often carries `Http_Proxy`).
 */
function scrubProxyEnv(env) {
  for (const key of Object.keys(env)) {
    if (PROXY_ENV_KEYS.includes(key.toUpperCase())) delete env[key]
  }
  return env
}
module.exports.scrubProxyEnv = scrubProxyEnv

const LOOPBACK = ['127.0.0.1', 'localhost', '::1']
module.exports.LOOPBACK = LOOPBACK

/** Bypass patterns for a config; loopback is always included. */
function bypassPatterns(config) {
  const out = [...LOOPBACK]
  for (const part of String((config && config.bypass) || '').split(/[,;\s]+/)) {
    if (part.trim()) out.push(part.trim())
  }
  return out
}
module.exports.bypassPatterns = bypassPatterns

/**
 * Whether `host` matches one of the bypass patterns. Supported forms:
 *   corp.com (exact) | *.corp.com or .corp.com (suffix) | 10.* (prefix) |
 *   <local> (any name without a dot) | * (everything).
 * The app's one bypass semantics; NO_PROXY carries loopback only.
 */
function isBypassed(host, patterns) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  for (const raw of patterns || []) {
    const p = String(raw).toLowerCase().trim()
    if (!p) continue
    if (p === '*') return true
    if (p === '<local>') { if (!h.includes('.')) return true; continue }
    if (p.startsWith('*.') || p.startsWith('.')) {
      const suffix = p.startsWith('*') ? p.slice(1) : p
      if (h === suffix.slice(1) || h.endsWith(suffix)) return true
      continue
    }
    if (p.endsWith('*')) { if (h.startsWith(p.slice(0, -1))) return true; continue }
    if (h === p) return true
  }
  return false
}
module.exports.isBypassed = isBypassed

/**
 * Point a child env at the in-process forwarding proxy (proxy-forward.js)
 * after scrubbing inherited proxy vars. `port` 0 means no forwarder; the env
 * is then scrubbed only (direct). The child gets the same static endpoint in
 * every mode; routing (direct / upstream / per-URL PAC) is decided inside the
 * forwarder, and a config change does not rebuild the env.
 */
function applyProxyEnv(env, port, config) {
  scrubProxyEnv(env)
  const c = config || {}
  if (port) {
    const url = `http://127.0.0.1:${port}`
    const noProxy = LOOPBACK.join(',')
    Object.assign(env, {
      HTTP_PROXY: url, http_proxy: url,
      HTTPS_PROXY: url, https_proxy: url,
      NO_PROXY: noProxy, no_proxy: noProxy,
      // npm/pnpm also read proxy= from ~/.npmrc; these env entries override it.
      npm_config_proxy: url, npm_config_https_proxy: url, npm_config_noproxy: noProxy,
      NODE_USE_ENV_PROXY: '1',
    })
  }
  if (c.mode !== 'none') {
    // OS trust store: TLS-intercepting proxies re-sign traffic with their
    // own CA.
    env.NODE_USE_SYSTEM_CA = '1'
    if (typeof c.caPath === 'string' && c.caPath.trim()) env.NODE_EXTRA_CA_CERTS = c.caPath.trim()
    if (c.insecure) env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }
  return env
}
module.exports.applyProxyEnv = applyProxyEnv

/**
 * Shell behaviour settings (config center 通用配置): tray icon, close/start
 * to tray, login item, keep-awake while the server has running work. All
 * default to off; unknown keys are dropped, non-boolean values read as off.
 */
const GENERAL_KEYS = ['openAtLogin', 'startMinimized', 'trayIcon', 'closeToTray', 'keepAwake']
function normalizeGeneralSettings(raw) {
  const out = {}
  for (const k of GENERAL_KEYS) out[k] = raw && typeof raw === 'object' && raw[k] === true
  return out
}
/**
 * Effective hide-to-tray setting: requires a tray on Windows/Linux;
 * macOS supports restoring through the Dock.
 */
function hideToTrayEffective(settings, platform) {
  return settings.closeToTray && (settings.trayIcon || platform === 'darwin')
}
module.exports.GENERAL_KEYS = GENERAL_KEYS
module.exports.normalizeGeneralSettings = normalizeGeneralSettings
module.exports.hideToTrayEffective = hideToTrayEffective

/** Remove only desktop-generated uv launchers that point at the retired bundled tools. */
function removeLegacyUvLaunchers(binDir) {
  const fs = require('node:fs')
  const path = require('node:path')
  for (const name of ['uv', 'uvx', 'uv.cmd', 'uvx.cmd']) {
    const file = path.join(binDir, name)
    try {
      if (!fs.lstatSync(file).isFile()) continue
      const text = fs.readFileSync(file, 'utf8')
      if (text.includes('UV_CACHE_DIR') && text.includes('UV_PYTHON_INSTALL_DIR') && /[\\/]tools[\\/]uv[\\/]uvx?(?:\.exe)?[" ]/.test(text)) fs.unlinkSync(file)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
module.exports.removeLegacyUvLaunchers = removeLegacyUvLaunchers
