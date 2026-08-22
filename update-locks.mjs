/**
 * Regenerate locks/ for a new dsh release WITHOUT a live npm resolution.
 *
 * Live resolution of the dsh graph explodes in npm's peer backtracker
 * (observed repeatedly: 16min+ or OOM), so this script transplants the
 * known-good previous full lock instead: bump every lockstep @deepseek-ai/*
 * entry to the target version, bump the preset plugins, refresh
 * resolved/integrity from the registry, add entries newly referenced by the
 * bumped packages (deps AND peers, recursively), and widen preset-plugin
 * peer ranges that lag the target by one release so `npm ci` accepts the
 * tree. Dependency-shape drift is REPORTED, never silently absorbed.
 *
 * Usage:
 *   node update-locks.mjs 0.1.1-rc.2 \
 *     "@linxin666/dsh-client-ui-task-board@0.2.8" \
 *     "dsh-better-sidebar@0.15.0" \
 *     "@linxin666/dsh-ssh@0.2.8"
 *
 * Then verify: DSH_FLAVOR=full node stage-dsh.mjs (npm ci --force installs
 * the lock; the staging smoke run is the real compatibility check) and boot
 * the app headlessly per AGENTS.md. Both locks are rewritten in place.
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
  if (v.peerDependencies) entry.peerDependencies = v.peerDependencies; else delete entry.peerDependencies
  if (v.engines) entry.engines = v.engines
  bumped++
}

// Pass 2: ensure every referenced name (dep or peer) has a tree entry.
const have = new Set(Object.keys(lock.packages).map((k) => k.replace(/^.*node_modules\//, '')))
const added = []
async function ensure(name) {
  if (!name || have.has(name)) return
  const doc = await reg(name)
  const version = doc.versions[target] ? target : doc['dist-tags'].latest
  const v = doc.versions[version]
  lock.packages[`node_modules/${name}`] = {
    version, resolved: v.dist.tarball, integrity: v.dist.integrity,
    ...(v.dependencies ? { dependencies: v.dependencies } : {}),
    ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
    ...(v.engines ? { engines: v.engines } : {}),
  }
  have.add(name)
  added.push(`${name}@${version}`)
  for (const d of Object.keys({ ...v.dependencies, ...v.peerDependencies })) await ensure(d)
}
for (const [k, v] of [...Object.entries(lock.packages)]) {
  if (!k) continue
  for (const d of Object.keys({ ...v.dependencies, ...v.peerDependencies })) await ensure(d)
}

// Pass 3: widen preset-plugin peers still pinned to the PREVIOUS release so
// the lock is self-consistent (npm ci validates peers even with a lock).
let widened = 0
for (const name of Object.keys(pluginBumps)) {
  const entry = lock.packages[`node_modules/${name}`]
  for (const [n, r] of Object.entries(entry?.peerDependencies ?? {})) {
    if (r === `^${prevDsh}`) { entry.peerDependencies[n] = `^${prevDsh} || ^${target}`; widened++ }
  }
}

// Root ranges + write full, then derive minimal by pruning with npm (all
// versions pre-pinned: seconds, no backtracking).
lock.packages[''].dependencies = {
  '@deepseek-ai/dsh': `^${target}`,
  ...Object.fromEntries(Object.entries(pluginBumps).map(([n, v]) => [n, `^${v}`])),
}
fs.writeFileSync(fullPath, JSON.stringify(lock, null, 2))

const tmp = fs.mkdtempSync('/tmp/lockmin-')
const minimal = structuredClone(lock)
minimal.packages[''].dependencies = { '@deepseek-ai/dsh': `^${target}` }
fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify(minimal, null, 2))
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: { '@deepseek-ai/dsh': `^${target}` } }, null, 2))
execSync('npm install --package-lock-only --force --ignore-scripts --no-audit --no-fund', { cwd: tmp, stdio: 'pipe' })
fs.copyFileSync(path.join(tmp, 'package-lock.json'), path.join(here, 'locks', 'minimal.package-lock.json'))

console.log(`bumped ${bumped} (from ${prevDsh} to ${target}); added ${added.length}: ${added.join(', ') || '-'}`)
console.log(`widened lagging plugin peers: ${widened}`)
console.log(drift.length ? `依赖形状变化 ${drift.length} 条（人工确认）：\n  ` + drift.join('\n  ') : '依赖形状零漂移')
console.log('locks/ 已重写；接着跑 DSH_FLAVOR=full node stage-dsh.mjs + 无头冒烟验证')
