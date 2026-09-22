/**
 * Regenerate locks/ for a new dsh release without a live npm resolution.
 *
 * Transplants the previous full lock: bumps every lockstep @deepseek-ai/*
 * entry and the preset plugins to the target versions, refreshes
 * resolved/integrity from the registry, adds entries newly referenced by the
 * bumped packages (deps and required peers, recursively), and widens peer
 * ranges `npm ci` would reject. Dependency-shape drift is reported, never
 * absorbed. Both locks are rewritten in place.
 *
 * Usage:
 *   node update-locks.mjs 0.1.1-rc.2 \
 *     "@linxin666/dsh-client-ui-task-board@0.2.8" \
 *     "dsh-better-sidebar@0.15.0" \
 *     "@linxin666/dsh-ssh@0.2.8"
 *
 * Verify with `DSH_FLAVOR=full node stage-dsh.mjs` and a headless app boot
 * (AGENTS.md).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [target, ...pluginSpecs] = process.argv.slice(2)
if (!target || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) {
  console.error('用法：node update-locks.mjs <dsh版本> ["插件@版本"...]')
  process.exit(1)
}
const pluginBumps = {}
for (const spec of pluginSpecs) {
  const at = spec.lastIndexOf('@')
  pluginBumps[spec.slice(0, at)] = spec.slice(at + 1)
}

const fullPath = path.join(here, 'locks', 'full.package-lock.json')
const lock = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
const prevDsh = lock.packages['node_modules/@deepseek-ai/dsh'].version

const metaCache = new Map()
async function reg(name) {
  if (!metaCache.has(name)) {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`)
    if (!res.ok) throw new Error(`registry ${name}: ${res.status}`)
    metaCache.set(name, await res.json())
  }
  return metaCache.get(name)
}

// Pass 1: bump lockstep + plugin entries, refresh dist metadata.
const drift = []
let bumped = 0
for (const [key, entry] of Object.entries(lock.packages)) {
  if (!key) continue
  const name = key.replace(/^.*node_modules\//, '')
  let want = null
  if (name.startsWith('@deepseek-ai/') && entry.version === prevDsh) want = target
  else if (pluginBumps[name] && entry.version !== pluginBumps[name]) want = pluginBumps[name]
  if (!want) continue
  const v = (await reg(name)).versions[want]
  if (!v) { drift.push(`${name}: ${want} 不在 registry`); continue }
  const oldDeps = new Set(Object.keys(entry.dependencies ?? {}))
  for (const d of Object.keys(v.dependencies ?? {})) if (!oldDeps.has(d)) drift.push(`${name}: 新增依赖 ${d}`)
  for (const d of oldDeps) if (!(d in (v.dependencies ?? {}))) drift.push(`${name}: 移除依赖 ${d}`)
  Object.assign(entry, {
    version: want, resolved: v.dist.tarball, integrity: v.dist.integrity,
  })
  if (v.dependencies) entry.dependencies = v.dependencies; else delete entry.dependencies
  if (v.optionalDependencies) entry.optionalDependencies = v.optionalDependencies; else delete entry.optionalDependencies
  if (v.peerDependencies) entry.peerDependencies = v.peerDependencies; else delete entry.peerDependencies
  if (v.peerDependenciesMeta) entry.peerDependenciesMeta = v.peerDependenciesMeta; else delete entry.peerDependenciesMeta
  if (v.engines) entry.engines = v.engines
  bumped++
}

// Pass 2: every referenced name (dep or required peer) gets a tree entry.
// A preset plugin newly added to the set has no referrer; the explicit seed
// below creates its entry. Optional peers are not followed (npm does not
// auto-install them); optional deps are (npm installs them by default).
const have = new Set(Object.keys(lock.packages).map((k) => k.replace(/^.*node_modules\//, '')))
const added = []
// npm's own semver, from the npm installation next to the running node. A
// new entry is picked by the referrer's range, not latest.
const { createRequire } = await import('node:module')
const npmDir = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm')
const semver = createRequire(path.join(npmDir, 'index.js'))('semver')
const requiredRefs = (v) => Object.entries({
  ...v.dependencies,
  ...v.optionalDependencies,
  ...Object.fromEntries(Object.entries(v.peerDependencies ?? {}).filter(([n]) => !v.peerDependenciesMeta?.[n]?.optional)),
})
async function ensure(name, range) {
  if (!name || have.has(name)) return
  const doc = await reg(name)
  const version = doc.versions[range] ? range // exact pin (plugin seeds)
    : range && semver.satisfies(target, range) ? target // lockstep names first
    : (range && semver.maxSatisfying(Object.keys(doc.versions), range)) ?? doc['dist-tags'].latest
  const v = doc.versions[version]
  if (!v) throw new Error(`${name}@${version} 不在 registry`)
  lock.packages[`node_modules/${name}`] = {
    version, resolved: v.dist.tarball, integrity: v.dist.integrity,
    ...(v.dependencies ? { dependencies: v.dependencies } : {}),
    ...(v.optionalDependencies ? { optionalDependencies: v.optionalDependencies } : {}),
    ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
    ...(v.peerDependenciesMeta ? { peerDependenciesMeta: v.peerDependenciesMeta } : {}),
    ...(v.engines ? { engines: v.engines } : {}),
  }
  have.add(name)
  added.push(`${name}@${version}`)
  for (const [d, r] of requiredRefs(v)) await ensure(d, r)
}
for (const [n, v] of Object.entries(pluginBumps)) await ensure(n, v)
for (const [k, v] of [...Object.entries(lock.packages)]) {
  if (!k) continue
  for (const [d, r] of requiredRefs(v)) await ensure(d, r)
}

// Root ranges, then prune entries unreachable from the root (subtrees of
// removed or swapped preset plugins). The walk mirrors Node/npm resolution
// over the lock's flat keys (`${key}/node_modules/${dep}`, then up) and
// follows the pass 2 edge set (optional peers excluded). Runs here and again
// at the end. Not `npm install --package-lock-only`: that rewrites peer
// ranges from registry metadata and undoes pass 3's widening.
lock.packages[''].dependencies = {
  '@deepseek-ai/dsh': `^${target}`,
  ...Object.fromEntries(Object.entries(pluginBumps).map(([n, v]) => [n, `^${v}`])),
}
const resolveKey = (fromKey, dep) => {
  let base = fromKey
  for (;;) {
    const cand = base === '' ? `node_modules/${dep}` : `${base}/node_modules/${dep}`
    if (cand in lock.packages) return cand
    if (base === '') return undefined
    const cut = base.lastIndexOf('/node_modules/')
    base = cut === -1 ? '' : base.slice(0, cut)
  }
}
function prune() {
  const reached = new Set([''])
  const queue = ['']
  while (queue.length > 0) {
    const key = queue.pop()
    for (const [dep] of requiredRefs(lock.packages[key])) {
      const found = resolveKey(key, dep)
      if (found !== undefined && !reached.has(found)) { reached.add(found); queue.push(found) }
    }
  }
  const gone = Object.keys(lock.packages).filter((k) => !reached.has(k))
  for (const k of gone) delete lock.packages[k]
  return gone
}
const prunedEarly = prune()

// Pass 2b: re-resolve non-lockstep entries that some referrer's range no
// longer accepts, to a published version satisfying every referrer (a core
// release raising the floor on a support package: cordis ^4.0.2 over a
// locked 4.0.1). Iterates: a bump can add references or ranges.
const refreshed = []
const isLockstep = (name, entry) => name.startsWith('@deepseek-ai/') && entry.version === target
for (let round = 0; round < 3; round++) {
  const ranges = new Map()
  for (const [k, e] of Object.entries(lock.packages)) {
    if (!k) continue
    for (const [n, r] of Object.entries({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies })) {
      if (!ranges.has(n)) ranges.set(n, [])
      ranges.get(n).push(r)
    }
  }
  let changed = 0
  for (const [k, e] of Object.entries(lock.packages)) {
    if (!k) continue
    const name = k.replace(/^.*node_modules\//, '')
    if (isLockstep(name, e) || pluginBumps[name]) continue
    const wanted = ranges.get(name) ?? []
    if (wanted.every((r) => semver.satisfies(e.version, r))) continue
    const doc = await reg(name)
    const fits = Object.keys(doc.versions).filter((v) => wanted.every((r) => semver.satisfies(v, r)))
    if (fits.length === 0) continue // unsatisfiable; pass 3 widens the range
    const pick = semver.rsort(fits)[0]
    if (pick === e.version) continue
    const v = doc.versions[pick]
    refreshed.push(`${name} ${e.version} -> ${pick}`)
    Object.assign(e, { version: pick, resolved: v.dist.tarball, integrity: v.dist.integrity })
    if (v.dependencies) e.dependencies = v.dependencies; else delete e.dependencies
    if (v.optionalDependencies) e.optionalDependencies = v.optionalDependencies; else delete e.optionalDependencies
    if (v.peerDependencies) e.peerDependencies = v.peerDependencies; else delete e.peerDependencies
    if (v.peerDependenciesMeta) e.peerDependenciesMeta = v.peerDependenciesMeta; else delete e.peerDependenciesMeta
    if (v.engines) e.engines = v.engines
    for (const [d, r] of requiredRefs(v)) await ensure(d, r)
    changed++
  }
  if (changed === 0) break
}

// Pass 2c: nest a private copy where a referrer's range and the hoisted
// entry are irreconcilable (compression@1.8 wants debug ^2.6 over a hoisted
// debug 4.x), as npm's installer does. Optional peers excluded. Iterates: a
// nested copy brings its own edges.
const nested = []
for (let round = 0; round < 4; round++) {
  let changed = 0
  for (const [k, e] of [...Object.entries(lock.packages)]) {
    if (!k) continue
    for (const [d, r] of requiredRefs(e)) {
      const hit = resolveKey(k, d)
      if (hit !== undefined && semver.satisfies(lock.packages[hit].version, r)) continue
      if (hit === undefined) continue // pass 2 guarantees an entry; defensive
      const doc = await reg(d)
      const pick = semver.maxSatisfying(Object.keys(doc.versions), r)
      if (pick === null) continue // unsatisfiable; pass 3 widens the range
      const v = doc.versions[pick]
      const key = `${k}/node_modules/${d}`
      lock.packages[key] = {
        version: pick, resolved: v.dist.tarball, integrity: v.dist.integrity,
        ...(v.dependencies ? { dependencies: v.dependencies } : {}),
        ...(v.optionalDependencies ? { optionalDependencies: v.optionalDependencies } : {}),
        ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
        ...(v.peerDependenciesMeta ? { peerDependenciesMeta: v.peerDependenciesMeta } : {}),
        ...(v.engines ? { engines: v.engines } : {}),
      }
      nested.push(`${key.replace(/^node_modules\//, '')}@${pick}`)
      for (const [dd, rr] of requiredRefs(v)) await ensure(dd, rr)
      changed++
    }
  }
  if (changed === 0) break
}

// Pass 3: widen unsatisfied peers, optional ones included whenever the name
// is present in the tree (npm ci validates those too). The widened range is
// the lock's decision record; the staging smoke run verifies compatibility.
let widened = 0
for (const entry of Object.values(lock.packages)) {
  for (const [n, r] of Object.entries(entry?.peerDependencies ?? {})) {
    const resolved = lock.packages[`node_modules/${n}`]
    if (resolved !== undefined && !semver.satisfies(resolved.version, r, { includePrerelease: false })) {
      entry.peerDependencies[n] = `${r} || ${resolved.version}`
      widened++
    }
  }
}

// Pass 4: prune entries unreachable from the root (prune()).
const pruned = prune()
fs.writeFileSync(fullPath, JSON.stringify(lock, null, 2))

// Minimal lock: prune the full lock with npm. All versions are pinned (no
// backtracking) and the core-only tree has no lagging peers.
const tmp = fs.mkdtempSync('/tmp/lockmin-')
const minimal = structuredClone(lock)
minimal.packages[''].dependencies = { '@deepseek-ai/dsh': `^${target}` }
fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify(minimal, null, 2))
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: { '@deepseek-ai/dsh': `^${target}` } }, null, 2))
execSync('npm install --package-lock-only --force --ignore-scripts --no-audit --no-fund', { cwd: tmp, stdio: 'pipe' })
fs.copyFileSync(path.join(tmp, 'package-lock.json'), path.join(here, 'locks', 'minimal.package-lock.json'))

console.log(`bumped ${bumped} (from ${prevDsh} to ${target}); added ${added.length}: ${added.join(', ') || '-'}`)
console.log(`re-resolved by referrer ranges: ${refreshed.length}${refreshed.length > 0 ? ' (' + refreshed.join(', ') + ')' : ''}`)
console.log(`nested private copies: ${nested.length}${nested.length > 0 ? ' (' + nested.join(', ') + ')' : ''}`)
console.log(`widened lagging plugin peers: ${widened}; pruned unreachable: ${prunedEarly.length + pruned.length}${[...prunedEarly, ...pruned].length > 0 ? ' (' + [...prunedEarly, ...pruned].map((k) => k.replace(/^.*node_modules\//, '')).join(', ') + ')' : ''}`)
console.log(drift.length ? `依赖形状变化 ${drift.length} 条，需人工确认：\n  ` + drift.join('\n  ') : '依赖形状无变化')
console.log('locks/ 已重写。下一步：DSH_FLAVOR=full node stage-dsh.mjs，再做无头冒烟验证')
