'use strict'
/** featured.js: release normalization, kernel pinning, catalog rows and install plans. */
const assert = require('node:assert/strict')
const f = require('../featured.js')

// Tag and pin parsing
assert.equal(f.releaseVersion('v0.9.0'), '0.9.0')
assert.equal(f.releaseVersion('v0.10.0-rc.1'), '0.10.0-rc.1')
assert.equal(f.releaseVersion('nightly'), null)
assert.equal(f.pinnedKernel({ dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.1' } }), '0.2.2-rc.1')
assert.equal(f.pinnedKernel({ dependencies: { '@deepseek-ai/dsh': '^0.2.2' } }), null)
assert.equal(f.pinnedKernel({}), null)

// Asset names and checksums
const toolkit = f.FEATURED_PACKAGES.find(e => e.id === 'toolkit')
assert.equal(f.assetName(toolkit, '0.9.0'), 'onenightcarnival-dsh-toolkit-0.9.0.tgz')
const sums = f.parseSha256Sums(`${'a'.repeat(64)}  onenightcarnival-dsh-toolkit-0.9.0.tgz\n${'b'.repeat(64)} *dsh-browser-extension-chrome-0.9.0.zip\nbad line\n`)
assert.deepEqual(Object.keys(sums).sort(), ['dsh-browser-extension-chrome-0.9.0.zip', 'onenightcarnival-dsh-toolkit-0.9.0.tgz'])

// Listing normalization: drafts and non-version tags dropped, newest first
const releases = f.normalizeReleases([
  { tag_name: 'v0.8.2', html_url: 'u2', assets: [{ name: 'x', browser_download_url: 'd', size: 1 }] },
  { tag_name: 'v0.9.0', draft: true, assets: [] },
  { tag_name: 'v0.9.1', prerelease: true, assets: [{ name: 'onenightcarnival-dsh-toolkit-0.9.1.tgz', browser_download_url: 'd1', size: 10 }, { bogus: true }] },
  { tag_name: 'weekly' },
])
assert.deepEqual(releases.map(r => r.version), ['0.9.1', '0.8.2'])
assert.equal(releases[0].assets.length, 1)
assert.equal(releases[1].htmlUrl, 'u2')

// Compatibility: exact pin match, unresolved and null pins skipped
const list = [
  { version: '0.9.1', kernel: null },
  { version: '0.9.0', kernel: '0.2.2-rc.1' },
  { version: '0.8.2', kernel: '0.2.1-rc.5' },
]
assert.equal(f.pickCompatibleRelease(list, '0.2.2-rc.1').version, '0.9.0')
assert.equal(f.pickCompatibleRelease(list, '0.2.1-rc.5').version, '0.8.2')
assert.equal(f.pickCompatibleRelease(list, '0.2.3-rc.1'), null)
assert.equal(f.pickCompatibleRelease(list, null), null)

// Catalog rows
const compatible = {
  version: '0.9.0',
  assets: f.FEATURED_PACKAGES.map(e => ({ name: f.assetName(e, '0.9.0'), url: 'https://x/' + f.assetName(e, '0.9.0'), size: 5 })).filter(a => !a.name.includes('gateway')),
  sums: { 'onenightcarnival-dsh-toolkit-0.9.0.tgz': 'c'.repeat(64) },
}
const rows = f.catalogRows(compatible, { '@onenightcarnival/dsh-rdb': '0.8.2', '@onenightcarnival/dsh-s3': '0.9.0' })
const row = id => rows.find(r => r.id === id)
assert.equal(row('toolkit').state, 'install')
assert.equal(row('toolkit').asset.sha256, 'c'.repeat(64))
assert.equal(row('rdb').state, 'update')
assert.equal(row('s3').state, 'installed')
assert.equal(row('otel').asset.sha256, null)
assert.equal(row('gateway').state, 'unavailable') // not in this release
assert.equal(row('extension').state, 'download')
const noRelease = f.catalogRows(null, { '@onenightcarnival/dsh-s3': '0.9.0' })
assert.equal(noRelease.find(r => r.id === 's3').state, 'installed')
assert.equal(noRelease.find(r => r.id === 'toolkit').state, 'unavailable')
assert.equal(noRelease.find(r => r.id === 'extension').state, 'unavailable')

// Install plans: bundle replaces modules; modules blocked by an installed bundle
assert.deepEqual(f.installPlan(toolkit, { '@onenightcarnival/dsh-rdb': '0.8.2', '@onenightcarnival/dsh-memory': '0.9.0' }).remove,
  ['@onenightcarnival/dsh-rdb', '@onenightcarnival/dsh-memory'])
assert.deepEqual(f.installPlan(toolkit, {}).remove, [])
const rdb = f.FEATURED_PACKAGES.find(e => e.id === 'rdb')
assert.equal(f.installPlan(rdb, { '@onenightcarnival/dsh-toolkit': '0.9.0' }).blocked, 'bundle-installed')
assert.deepEqual(f.installPlan(rdb, { '@onenightcarnival/dsh-s3': '0.9.0' }).remove, [])

console.log('featured: ok')
