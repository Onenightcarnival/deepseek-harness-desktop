'use strict'
/**
 * Every local `require('./x')` of a packaged script must itself match
 * package.json build.files, so the asar never misses a module.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const patterns = require(process.env.PKG_JSON || path.join(root, 'package.json')).build.files
const SKIP = new Set(['node_modules', 'staging', 'dist', '.git', 'locks'])

/** electron-builder glob → RegExp: `**` spans directories, `*` stays inside one. */
const toRegExp = (pattern) => new RegExp('^' + pattern.replace(/^\.\//, '')
  .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '$')
const matchers = patterns.filter(p => !p.startsWith('!')).map(toRegExp)
// electron-builder always includes the app manifest.
const packaged = (rel) => rel === 'package.json' || matchers.some(re => re.test(rel))

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(abs)
    else yield path.relative(root, abs).split(path.sep).join('/')
  }
}
const scripts = [...walk(root)].filter(rel => /\.(cjs|js)$/.test(rel) && packaged(rel))
assert.ok(scripts.includes('main.js'), 'main.js must be packaged')
const missing = []
for (const file of scripts) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  for (const m of source.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
    let rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]))
    if (!path.posix.extname(rel)) rel += '.js'
    if (!packaged(rel)) missing.push(`${file} → ${m[2]}`)
  }
}
assert.deepEqual(missing, [], `build.files lacks required modules:\n${missing.join('\n')}`)
console.log(`PASS: ${scripts.length} packaged scripts, every local require is packaged`)
