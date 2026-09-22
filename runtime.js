/**
 * Pure helpers for the desktop shell: runtime selection and version logic,
 * managed config blocks, the common-settings registry, skill store, proxy
 * env. Plain CJS, no Electron imports.
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
 * Upsert a marker-fenced managed block in a cordis patch YAML document (a
 * top-level list). `content` is the block body: top-level list entries,
 * already YAML-formatted; empty content removes the block. The rest of the
 * file is preserved byte-for-byte. Exception: a standalone empty flow list
 * `[]` cannot coexist with block-list entries; it is dropped while entries
 * are present and restored when the document would otherwise be empty.
 */
function upsertManagedBlock(text, name, content) {
  const begin = `# >>> dsh-desktop ${name} >>>`
  const end = `# <<< dsh-desktop ${name} <<<`
  let lines = String(text ?? '').split('\n')
  // drop any existing block
  const from = lines.findIndex((l) => l.trim() === begin)
  if (from !== -1) {
    const to = lines.findIndex((l, i) => i > from && l.trim() === end)
    lines.splice(from, to === -1 ? lines.length - from : to - from + 1)
  }
  const hasEntries = (ls) => ls.some((l) => /^\s*-\s/.test(l))
  const blockLines = content.trim() === '' ? [] : [begin, ...content.replace(/\n+$/, '').split('\n'), end]
  if (blockLines.length > 0) {
    // an empty flow list `[]` line cannot coexist with block-list entries
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
      if (s.cwd) lines.push(`        cwd: ${q(s.cwd)}`)
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
 * Curated common settings the config center exposes over built-in plugin
 * config. Each option maps one GUI field onto config keys of composed
 * entries (`- id: <entryId>` + `config:` merges per-key in the user patch
 * layer): a single entryId/configKey pair, or `targets` when one value lands
 * on several entries. The GUI page, validation and YAML generation all read
 * this registry; adding a setting is one registry entry.
 * Types: posInt (integer >= 1), ratio (0 < x < 1), bool (三态: 默认/开/关).
 * `def` mirrors the upstream default for display only; an empty GUI value
 * removes the override and the upstream default applies.
 */
/**
 * Plugin groups the settings page renders as sections: one row per composed
 * entry id, in display order. An option's `entryId` (or its first target's)
 * picks the group; options whose entry has no row here land in a trailing
 * "其他" section.
 */
const SETTING_GROUPS = [
  { entryId: 'goal', label: 'goal 目标模式', hint: '内置插件：agent 围绕一个目标自动多轮续跑。' },
  { entryId: 'compaction-basic', label: '上下文自动压缩', hint: '内置插件：会话接近上下文上限时把较早内容压缩成摘要。' },
]
module.exports.SETTING_GROUPS = SETTING_GROUPS

const COMMON_SETTINGS = [
  {
    key: 'goalMaxRounds', entryId: 'goal', configKey: 'defaultMaxGoalRounds',
    type: 'posInt', def: 256, label: '轮数上限',
    hint: '单个目标自动续跑的轮数上限（上游默认 256）。达到上限后目标停止续跑；创建目标时可单独指定。留空恢复默认。',
  },
  {
    // the web profile ships this entry disabled; the switch writes the
    // entry's `disabled` field (kind: 'enable': value true = enabled)
    key: 'compactionEnabled', entryId: 'compaction-basic', kind: 'enable',
    type: 'bool', def: false, label: '启用自动压缩',
    hint: '会话接近上下文上限时把较早内容压缩成摘要（rc8 起可用；web 端默认关闭）。触发时机由下面的阈值决定。',
  },
  {
    key: 'compactionThreshold', entryId: 'compaction-basic', configKey: 'thresholdRatio',
    type: 'ratio', def: 0.8, label: '触发阈值（上下文占比）',
    hint: '上下文用量达到该比例时触发压缩（上游默认 0.8）。仅在开启自动压缩后生效。',
  },
]
module.exports.COMMON_SETTINGS = COMMON_SETTINGS

/** The entry/config pairs one option writes. */
function settingTargets(opt) {
  return Array.isArray(opt.targets) ? opt.targets : [{ entryId: opt.entryId, configKey: opt.configKey }]
}
module.exports.settingTargets = settingTargets

/** Group id of one option: its own entryId, else its first target's. */
function settingGroupId(opt) {
  return opt.entryId || settingTargets(opt)[0].entryId
}

/**
 * Options arranged for the settings page: SETTING_GROUPS order, each with
 * its options in registry order; entries without a declared group trail as
 * one "其他" section keyed by their entry id.
 */
function groupCommonSettings(options = COMMON_SETTINGS) {
  const groups = SETTING_GROUPS.map((g) => ({ ...g, options: [] }))
  const byId = new Map(groups.map((g) => [g.entryId, g]))
  for (const opt of options) {
    const id = settingGroupId(opt)
    let g = byId.get(id)
    if (!g) {
      g = { entryId: id, label: `其他（${id}）`, hint: '', options: [] }
      byId.set(id, g)
      groups.push(g)
    }
    g.options.push(opt)
  }
  return groups.filter((g) => g.options.length > 0)
}
module.exports.groupCommonSettings = groupCommonSettings

/** Validate a {key: value} map against the registry; error string or null. */
function validateCommonSettings(values) {
  if (!values || typeof values !== 'object') return '数据格式无效'
  const known = new Map(COMMON_SETTINGS.map((o) => [o.key, o]))
  for (const [k, v] of Object.entries(values)) {
    const opt = known.get(k)
    if (!opt) return `未知设置项 ${k}`
    if (v === undefined || v === null || v === '') continue // no override
    if (opt.type === 'posInt' && !(Number.isSafeInteger(v) && v >= 1)) return `「${opt.label}」请填正整数`
    if (opt.type === 'ratio' && !(typeof v === 'number' && v > 0 && v < 1)) return `「${opt.label}」请填 0 到 1 之间的小数`
    if (opt.type === 'bool' && typeof v !== 'boolean') return `「${opt.label}」取值无效，请重新选择`
  }
  return null
}
module.exports.validateCommonSettings = validateCommonSettings

/** Render overridden common settings as cordis patch entries (per entry id). */
function buildSettingsBlock(values) {
  const byEntry = new Map()
  const entryOf = (id) => {
    if (!byEntry.has(id)) byEntry.set(id, { disabled: undefined, kvs: [] })
    return byEntry.get(id)
  }
  for (const opt of COMMON_SETTINGS) {
    const v = values ? values[opt.key] : undefined
    if (v === undefined || v === null || v === '') continue
    if (opt.kind === 'enable') {
      // toggles the composed entry's `disabled` field: value true = enabled
      entryOf(opt.entryId).disabled = !v
      continue
    }
    for (const t of settingTargets(opt)) entryOf(t.entryId).kvs.push([t.configKey, v])
  }
  const lines = []
  for (const [id, e] of byEntry) {
    lines.push(`- id: ${id}`)
    if (e.disabled !== undefined) lines.push(`  disabled: ${e.disabled}`)
    if (e.kvs.length > 0) {
      lines.push('  config:')
      for (const [k, v] of e.kvs) lines.push(`    ${k}: ${JSON.stringify(v)}`)
    }
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

// ---- user skill store (~/.dsh/skills) with an enable/disable switch ----
//
// Disabled is a location: the skill is moved to `userData/disabled-skills/`
// (outside `~/.dsh` and every root dsh scans) and moved back to enable it.
// File contents are not touched; a reinstall lands enabled; dsh's root
// watcher picks the rename up without a restart.

const SKILL_DISABLED_DIR = 'disabled-skills'
module.exports.SKILL_DISABLED_DIR = SKILL_DISABLED_DIR

/** Default disabled folder when the caller gives none: `<parent of root>/disabled-skills`. */
function disabledSkillsDir(pathLike, root, disabledDir) {
  return disabledDir || pathLike.join(pathLike.dirname(root), SKILL_DISABLED_DIR)
}
module.exports.disabledSkillsDir = disabledSkillsDir

/**
 * One-time migration from earlier disabled locations (`<root>/.disabled/`,
 * `<parent of root>/disabled_skills/`): entries move to the current folder
 * (same-name entries stay behind); an emptied old folder is removed.
 */
function migrateLegacyDisabledSkills(fsLike, pathLike, root, disabledDir) {
  const target = disabledSkillsDir(pathLike, root, disabledDir)
  const legacyDirs = [pathLike.join(root, '.disabled'), pathLike.join(pathLike.dirname(root), 'disabled_skills')]
    .filter((d) => pathLike.resolve(d) !== pathLike.resolve(target))
  for (const legacy of legacyDirs) {
    let entries = []
    try { entries = fsLike.readdirSync(legacy) } catch { continue }
    fsLike.mkdirSync(target, { recursive: true })
    for (const name of entries) {
      const dest = pathLike.join(target, name)
      if (fsLike.existsSync(dest)) continue
      try { fsLike.renameSync(pathLike.join(legacy, name), dest) } catch { /* left in place */ }
    }
    try { if (fsLike.readdirSync(legacy).length === 0) fsLike.rmSync(legacy, { recursive: true }) } catch { /* keep */ }
  }
}
module.exports.migrateLegacyDisabledSkills = migrateLegacyDisabledSkills

/** kebab-case skill name (mirrors dsh's grammar). */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
module.exports.SKILL_NAME_RE = SKILL_NAME_RE

/**
 * Parse a SKILL.md's YAML frontmatter into a flat object. Exact for the
 * subset dsh's own parser reads: scalar `key: value` pairs, quoted or bare,
 * plus one level of indented scalars under `metadata:`. Block sequences and
 * multi-line scalars are kept as raw text for the detail view. Returns
 * undefined when the file has no leading `---` block.
 */
function parseSkillFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return undefined
  const out = { raw: m[1], fields: {}, metadata: {} }
  const unquote = (v) => {
    const t = v.trim()
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
    return t
  }
  const lines = m[1].split(/\r?\n/)
  let current = null // top-level key whose nested block is being collected
  let block = []
  const flush = () => {
    if (current === null) return
    if (current === 'metadata') {
      for (const l of block) {
        const mm = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(l)
        if (mm) out.metadata[mm[1]] = unquote(mm[2])
      }
    } else if (block.length) {
      out.fields[current] = block.map((l) => l.trim()).filter(Boolean).join('\n')
    }
    current = null; block = []
  }
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (top) {
      flush()
      const [, key, value] = top
      if (value.trim() === '' || value.trim() === '|' || value.trim() === '>') { current = key; continue }
      out.fields[key] = unquote(value)
      continue
    }
    if (current !== null) block.push(line)
  }
  flush()
  return out
}
module.exports.parseSkillFrontmatter = parseSkillFrontmatter

/** Frontmatter summary for one skill file: what the list and detail views show. */
function readSkillSummary(fsLike, mdPath) {
  let text = ''
  try { text = fsLike.readFileSync(mdPath, 'utf8') } catch { return { description: '' } }
  const fm = parseSkillFrontmatter(text)
  if (!fm) {
    const para = text.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
    return { description: (para || '').trim().slice(0, 200), frontmatter: null }
  }
  const f = fm.fields
  const version = f.version || fm.metadata.version || ''
  const flag = (v) => (typeof v === 'string' ? /^(true|yes|on|1)$/i.test(v) : false)
  return {
    description: f.description || '',
    version,
    whenToUse: f.whenToUse || f['when-to-use'] || '',
    modelInvocation: !flag(f['disable-model-invocation']),
    userInvocable: !(typeof f['user-invocable'] === 'string' && /^(false|no|off|0)$/i.test(f['user-invocable'])),
    frontmatter: { fields: f, metadata: fm.metadata, raw: fm.raw },
  }
}

/** First `description:` frontmatter value, else the first prose line (bounded). */
function describeSkillFile(fsLike, mdPath) {
  return readSkillSummary(fsLike, mdPath).description
}

/** Skills at the top level of one directory: {name, kind: 'bundle'|'flat', description}. */
function scanSkillDir(fsLike, pathLike, dir) {
  const out = []
  let entries = []
  try { entries = fsLike.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && fsLike.existsSync(pathLike.join(dir, e.name, 'SKILL.md'))) {
      const { frontmatter, ...summary } = readSkillSummary(fsLike, pathLike.join(dir, e.name, 'SKILL.md'))
      out.push({ name: e.name, kind: 'bundle', ...summary })
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const { frontmatter, ...summary } = readSkillSummary(fsLike, pathLike.join(dir, e.name))
      out.push({ name: e.name.slice(0, -3), kind: 'flat', ...summary })
    }
  }
  return out
}

/** Max entries a detail tree lists. */
const SKILL_TREE_MAX = 400
/** Largest file the detail viewer reads. */
const SKILL_FILE_MAX_BYTES = 256 * 1024

/** Recursive file tree of one skill directory: [{path, type: 'file'|'dir', size}], depth-first, capped. */
function skillTree(fsLike, pathLike, dir, max = SKILL_TREE_MAX) {
  const out = []
  let truncated = false
  const walk = (rel) => {
    let entries = []
    try { entries = fsLike.readdirSync(pathLike.join(dir, rel), { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const e of entries) {
      if (out.length >= max) { truncated = true; return }
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push({ path: p, type: 'dir' })
        if (e.name !== 'node_modules' && e.name !== '.git') walk(p)
      } else if (e.isFile()) {
        let size = 0
        try { size = fsLike.statSync(pathLike.join(dir, p)).size } catch { /* keep 0 */ }
        out.push({ path: p, type: 'file', size })
      }
    }
  }
  walk('')
  return { entries: out, truncated }
}
module.exports.skillTree = skillTree

/** Resolve a relative file path inside a skill directory, refusing escapes. */
function fencedSkillPath(pathLike, dir, rel) {
  const clean = String(rel || '').replace(/\\/g, '/')
  if (clean === '' || clean.startsWith('/') || clean.split('/').some((seg) => seg === '..' || seg === '')) return undefined
  const base = pathLike.resolve(dir)
  const target = pathLike.resolve(base, clean)
  if (target !== base && !target.startsWith(base + pathLike.sep)) return undefined
  return target
}

/** Read one text file from a skill directory: {text, size, truncated} or {error}. */
function readSkillFile(fsLike, pathLike, dir, rel, maxBytes = SKILL_FILE_MAX_BYTES) {
  const target = fencedSkillPath(pathLike, dir, rel)
  if (!target) return { error: '路径无效' }
  let stat
  try { stat = fsLike.statSync(target) } catch { return { error: '文件不存在' } }
  if (!stat.isFile()) return { error: '不是文件' }
  const fd = fsLike.openSync(target, 'r')
  try {
    const len = Math.min(stat.size, maxBytes)
    const buf = Buffer.alloc(len)
    fsLike.readSync(fd, buf, 0, len, 0)
    for (let i = 0; i < Math.min(len, 8192); i++) if (buf[i] === 0) return { error: '二进制文件，无法预览', size: stat.size }
    return { text: buf.toString('utf8'), size: stat.size, truncated: stat.size > maxBytes }
  } finally {
    fsLike.closeSync(fd)
  }
}
module.exports.readSkillFile = readSkillFile

/** Full detail for one user skill (enabled or disabled), or undefined. */
function skillDetail(fsLike, pathLike, root, name, disabledDir) {
  if (!SKILL_NAME_RE.test(name) || name.length > 64) return undefined
  for (const [dir, enabled] of [[root, true], [disabledSkillsDir(pathLike, root, disabledDir), false]]) {
    const hit = locateSkill(fsLike, pathLike, dir, name)
    if (!hit) continue
    const mdPath = hit.kind === 'bundle' ? pathLike.join(hit.path, 'SKILL.md') : hit.path
    const summary = readSkillSummary(fsLike, mdPath)
    const dirPath = hit.kind === 'bundle' ? hit.path : dir
    const tree = hit.kind === 'bundle' ? skillTree(fsLike, pathLike, hit.path) : { entries: [{ path: pathLike.basename(hit.path), type: 'file', size: 0 }], truncated: false }
    return { name, kind: hit.kind, enabled, path: hit.path, dir: dirPath, entryFile: hit.kind === 'bundle' ? 'SKILL.md' : pathLike.basename(hit.path), ...summary, tree }
  }
  return undefined
}
module.exports.skillDetail = skillDetail

/**
 * Enabled skills (root) followed by disabled ones (disabledDir), each row
 * carrying `enabled`. A name present in both places is reported once, as
 * enabled; dsh loads the root copy.
 */
function listSkillStore(fsLike, pathLike, root, disabledDir) {
  migrateLegacyDisabledSkills(fsLike, pathLike, root, disabledDir)
  const enabled = scanSkillDir(fsLike, pathLike, root).map((s) => ({ ...s, enabled: true }))
  const seen = new Set(enabled.map((s) => s.name))
  const disabled = scanSkillDir(fsLike, pathLike, disabledSkillsDir(pathLike, root, disabledDir))
    .filter((s) => !seen.has(s.name))
    .map((s) => ({ ...s, enabled: false }))
  return [...enabled, ...disabled]
}
module.exports.listSkillStore = listSkillStore

/** Where a named skill lives inside one directory, or undefined. */
function locateSkill(fsLike, pathLike, dir, name) {
  const bundle = pathLike.join(dir, name)
  if (fsLike.existsSync(pathLike.join(bundle, 'SKILL.md'))) return { kind: 'bundle', path: bundle }
  const flat = pathLike.join(dir, `${name}.md`)
  if (fsLike.existsSync(flat)) return { kind: 'flat', path: flat }
  return undefined
}

/** Whether a name is taken in the root or in the disabled folder. */
function skillExists(fsLike, pathLike, root, name, disabledDir) {
  return locateSkill(fsLike, pathLike, root, name) !== undefined
    || locateSkill(fsLike, pathLike, disabledSkillsDir(pathLike, root, disabledDir), name) !== undefined
}
module.exports.skillExists = skillExists

/** Remove a skill wherever it lives (enabled or disabled). */
function removeSkill(fsLike, pathLike, root, name, disabledDir) {
  let removed = false
  for (const dir of [root, disabledSkillsDir(pathLike, root, disabledDir)]) {
    const hit = locateSkill(fsLike, pathLike, dir, name)
    if (!hit) continue
    fsLike.rmSync(hit.path, { recursive: true, force: true })
    removed = true
  }
  return removed
}
module.exports.removeSkill = removeSkill

/**
 * Move a skill between the root and the disabled folder. Returns
 * {ok, error?, enabled}. A same-name skill at the destination refuses the
 * move; a skill already in place is a no-op success.
 */
function setSkillEnabled(fsLike, pathLike, root, name, enabled, disabledDir) {
  if (!SKILL_NAME_RE.test(name) || name.length > 64) return { ok: false, error: '技能名无效' }
  const off = disabledSkillsDir(pathLike, root, disabledDir)
  const from = enabled ? off : root
  const to = enabled ? root : off
  const src = locateSkill(fsLike, pathLike, from, name)
  if (!src) {
    if (locateSkill(fsLike, pathLike, to, name)) return { ok: true, enabled }
    return { ok: false, error: '技能不存在' }
  }
  if (locateSkill(fsLike, pathLike, to, name)) {
    return { ok: false, error: enabled ? `技能目录里已有同名的「${name}」，请先删除其中一个` : `已关闭的技能里有同名的「${name}」，请先删除其中一个` }
  }
  fsLike.mkdirSync(to, { recursive: true })
  const dest = pathLike.join(to, src.kind === 'bundle' ? name : `${name}.md`)
  fsLike.renameSync(src.path, dest)
  return { ok: true, enabled }
}
module.exports.setSkillEnabled = setSkillEnabled

/**
 * Prepend a directory to the PATH entry of a plain env object, matching the
 * key case-insensitively (a `{...process.env}` spread on Windows usually
 * carries "Path", and a spread is not case-insensitive).
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
 * Whether closing (or starting) hides the window instead of quitting: the
 * tray icon is the only way back on Windows and Linux; macOS keeps the Dock.
 */
function hideToTrayEffective(settings, platform) {
  return settings.closeToTray && (settings.trayIcon || platform === 'darwin')
}
module.exports.GENERAL_KEYS = GENERAL_KEYS
module.exports.normalizeGeneralSettings = normalizeGeneralSettings
module.exports.hideToTrayEffective = hideToTrayEffective
