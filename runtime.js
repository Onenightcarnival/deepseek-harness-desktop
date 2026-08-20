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

/**
 * Upsert a marker-fenced managed block inside a cordis patch YAML document
 * (a top-level list). `content` is the block body (top-level list entries,
 * already YAML-formatted); empty content removes the block. The rest of the
 * user's file is preserved byte-for-byte, except a standalone empty flow
 * list `[]` which must give way when block entries are present (mixing `[]`
 * with block-list entries is invalid YAML) and is restored when the
 * document would otherwise contain no entries at all.
 */
function upsertManagedBlock(text, name, content) {
  const begin = `# >>> dsh-desktop ${name} >>>`
  const end = `# <<< dsh-desktop ${name} <<<`
  let lines = String(text ?? '').split('\n')
  // drop an existing block (idempotent re-save)
  const from = lines.findIndex((l) => l.trim() === begin)
  if (from !== -1) {
    const to = lines.findIndex((l, i) => i > from && l.trim() === end)
    lines.splice(from, to === -1 ? lines.length - from : to - from + 1)
  }
  const hasEntries = (ls) => ls.some((l) => /^\s*-\s/.test(l))
  const blockLines = content.trim() === '' ? [] : [begin, ...content.replace(/\n+$/, '').split('\n'), end]
  if (blockLines.length > 0) {
    // block entries make the document a block list: an empty flow list `[]`
    // line cannot coexist with them
    lines = lines.filter((l) => l.trim() !== '[]')
  } else if (!hasEntries(lines) && !lines.some((l) => l.trim() === '[]')) {
    lines.push('[]')
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  const out = [...lines, ...blockLines].join('\n')
  return out.endsWith('\n') ? out : out + '\n'
}

/** Render GUI-managed MCP servers as cordis patch list entries. */
function buildMcpBlock(servers) {
  if (!servers || servers.length === 0) return ''
  const q = (s) => JSON.stringify(String(s))
  const lines = ['- insert:']
  for (const s of servers) {
    lines.push(`    - id: mcp-${s.serverName}`)
    lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`)
    if (s.enabled === false) lines.push('      disabled: true')
    lines.push('      config:')
    lines.push(`        serverName: ${q(s.serverName)}`)
    lines.push(`        transport: ${q(s.transport)}`)
    if (s.transport === 'stdio') {
      lines.push(`        command: ${q(s.command)}`)
      if (Array.isArray(s.args) && s.args.length) {
        lines.push('        args:')
        for (const a of s.args) lines.push(`          - ${q(a)}`)
      }
      if (s.env && Object.keys(s.env).length) {
        lines.push('        env:')
        for (const [k, v] of Object.entries(s.env)) lines.push(`          ${q(k)}: ${q(v)}`)
      }
    } else {
      lines.push(`        url: ${q(s.url)}`)
      if (s.headers && Object.keys(s.headers).length) {
        lines.push('        headers:')
        for (const [k, v] of Object.entries(s.headers)) lines.push(`          ${q(k)}: ${q(v)}`)
      }
    }
  }
  return lines.join('\n')
}

module.exports.upsertManagedBlock = upsertManagedBlock
module.exports.buildMcpBlock = buildMcpBlock

/**
 * Curated "common settings" the config center exposes over built-in plugin
 * config. Each option maps one GUI field onto one config key of one composed
 * entry (`- id: <entryId>` + `config:` merges per-key in the user patch
 * layer). Declarative on purpose: the GUI page renders from this registry,
 * validation and YAML generation read it too — adding a setting is one line.
 * `def` mirrors the upstream default purely for display; an empty value in
 * the GUI removes the override so upstream defaults keep applying.
 */
const COMMON_SETTINGS = [
  {
    key: 'goalMaxRounds', entryId: 'goal', configKey: 'defaultMaxGoalRounds',
    type: 'posInt', def: 256, label: 'goal 目标模式：轮数上限',
    hint: '单个目标最多自动续跑的轮数（上游默认 256）。预算耗尽后目标停住不再续跑；创建目标时也可单独指定。留空恢复默认。',
  },
]
module.exports.COMMON_SETTINGS = COMMON_SETTINGS

/** Validate a {key: value} map against the registry; error string or null. */
function validateCommonSettings(values) {
  if (!values || typeof values !== 'object') return '数据格式无效'
  const known = new Map(COMMON_SETTINGS.map((o) => [o.key, o]))
  for (const [k, v] of Object.entries(values)) {
    const opt = known.get(k)
    if (!opt) return `未知设置项 ${k}`
    if (v === undefined || v === null || v === '') continue // = no override
    if (opt.type === 'posInt' && !(Number.isSafeInteger(v) && v >= 1)) return `「${opt.label}」需为正整数`
  }
  return null
}
module.exports.validateCommonSettings = validateCommonSettings

/** Render overridden common settings as cordis patch entries (per entry id). */
function buildSettingsBlock(values) {
  const byEntry = new Map()
  for (const opt of COMMON_SETTINGS) {
    const v = values ? values[opt.key] : undefined
    if (v === undefined || v === null || v === '') continue
    if (!byEntry.has(opt.entryId)) byEntry.set(opt.entryId, [])
    byEntry.get(opt.entryId).push([opt.configKey, v])
  }
  const lines = []
  for (const [id, kvs] of byEntry) {
    lines.push(`- id: ${id}`)
    lines.push('  config:')
    for (const [k, v] of kvs) lines.push(`    ${k}: ${JSON.stringify(v)}`)
  }
  return lines.join('\n')
}
module.exports.buildSettingsBlock = buildSettingsBlock

/**
 * Locate skills inside an extracted archive directory. Recognized shapes:
 * the root itself is a skill (SKILL.md at top level, named by fallbackName);
 * top-level `<dir>/SKILL.md` bundles; top-level flat `<name>.md` files.
 * Returns [{ name, src, kind: 'bundle'|'flat' }] with names sanitized to
 * kebab-case (invalid names are skipped, reported via `rejected`).
 */
function collectSkills(fsLike, rootDir, fallbackName, pathLike) {
  const kebab = (s) => String(s).toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const valid = (n) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n) && n.length <= 64
  const found = []
  const rejected = []
  const push = (rawName, src, kind) => {
    const name = kebab(rawName)
    if (valid(name)) found.push({ name, src, kind })
    else rejected.push(rawName)
  }
  if (fsLike.existsSync(pathLike.join(rootDir, 'SKILL.md'))) {
    push(fallbackName, rootDir, 'bundle')
    return { found, rejected }
  }
  let entries = []
  try { entries = fsLike.readdirSync(rootDir, { withFileTypes: true }) } catch { return { found, rejected } }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '__MACOSX') continue
    if (e.isDirectory() && fsLike.existsSync(pathLike.join(rootDir, e.name, 'SKILL.md'))) {
      push(e.name, pathLike.join(rootDir, e.name), 'bundle')
    } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') {
      push(e.name, pathLike.join(rootDir, e.name), 'flat')
    }
  }
  return { found, rejected }
}

module.exports.collectSkills = collectSkills

/**
 * Prepend a directory to the PATH entry of a plain env object,
 * case-insensitively. On Windows the real key is usually "Path"; blindly
 * assigning "PATH" onto a spread of process.env creates a DUPLICATE key,
 * and the child process can end up with an effective PATH containing only
 * the prepended directory — every external tool (git!) silently vanishes
 * from plugins spawned under the dsh server. (The magic `process.env`
 * object is case-insensitive; a spread of it is NOT.)
 */
function prependEnvPath(env, dir, delimiter) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
  env[key] = env[key] ? `${dir}${delimiter}${env[key]}` : dir
  return env
}
module.exports.prependEnvPath = prependEnvPath

/**
 * Proxy env vars this app takes FULL ownership of. The app's own setting
 * decides a child's proxy environment completely: whatever the OS/IT put in
 * the user environment is removed first, so "不使用代理" really means
 * httpx's trust_env=False and not "inherit whatever happened to be there".
 * Corporate Windows images routinely ship a machine-wide HTTP_PROXY that
 * has no exception list — inheriting it is exactly what breaks intranet
 * access. TLS vars are deliberately NOT here: dropping a user's own
 * NODE_EXTRA_CA_CERTS would break their certificates.
 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NOPROXY',
  'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY',
]
module.exports.PROXY_ENV_KEYS = PROXY_ENV_KEYS

/**
 * Delete every proxy var from a plain env object, CASE-INSENSITIVELY: on
 * Windows the real key of a `{...process.env}` spread is often `Http_Proxy`,
 * and `delete env.HTTP_PROXY` would leave it in place (same trap as
 * prependEnvPath above).
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

/** Bypass patterns for a config: loopback is ALWAYS bypassed. */
function bypassPatterns(config) {
  const out = [...LOOPBACK]
  for (const part of String((config && config.bypass) || '').split(/[,;\s]+/)) {
    if (part.trim()) out.push(part.trim())
  }
  return out
}
module.exports.bypassPatterns = bypassPatterns

/**
 * Does `host` match one of the bypass patterns? Supported forms:
 *   corp.com (exact) | *.corp.com or .corp.com (suffix) | 10.* (prefix) |
 *   <local> (any name without a dot — Windows' "bypass proxy server for
 *   local addresses") | * (everything).
 * Matching happens in ONE place (the forwarder) instead of being handed to
 * NO_PROXY, whose wildcard semantics differ between undici, npm and git.
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
 * Point a child env at the in-process forwarding proxy (proxy-forward.js),
 * after scrubbing whatever proxy vars it inherited. `port` 0 means the
 * forwarder is unavailable — the env is then merely clean (= direct).
 * Note the child always gets the SAME static endpoint whatever the mode is;
 * routing (direct / upstream / per-URL PAC) is decided inside the forwarder,
 * which is why a config change does not need the env to be rebuilt.
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
      // npm/pnpm read ~/.npmrc too, where corporate images also write a
      // proxy=; an explicit env entry is the only way to override it.
      npm_config_proxy: url, npm_config_https_proxy: url, npm_config_noproxy: noProxy,
      NODE_USE_ENV_PROXY: '1',
    })
  }
  if (c.mode !== 'none') {
    // TLS-intercepting proxies (corporate MITM) re-sign traffic with their
    // own CA; Node's bundled CA store rejects it ("self signed certificate
    // in certificate chain"). The OS trust store usually has the corp CA.
    env.NODE_USE_SYSTEM_CA = '1'
    if (typeof c.caPath === 'string' && c.caPath.trim()) env.NODE_EXTRA_CA_CERTS = c.caPath.trim()
    if (c.insecure) env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }
  return env
}
module.exports.applyProxyEnv = applyProxyEnv
