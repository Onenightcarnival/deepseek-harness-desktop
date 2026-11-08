'use strict'
/**
 * Featured plugins: the dsh-toolkit release catalog without Electron
 * dependencies. Resolves which GitHub Release of the toolkit matches the
 * bundled kernel, names its assets and verifies their checksums.
 *
 * Compatibility rule: every toolkit tag pins exactly one kernel version in
 * the repository root package.json (`dependencies["@deepseek-ai/dsh"]`); a
 * release is compatible when that pin equals the bundled kernel version.
 */

/** GitHub repository ("owner/name") whose releases carry the toolkit packages. */
const FEATURED_REPO = 'Onenightcarnival/dsh-toolkit'
/** Profile whose plugins the configuration center manages. */
const FEATURED_PROFILE = 'web'
/** The all-in-one package; mutually exclusive with every `module` package. */
const TOOLKIT_ID = 'toolkit'

/**
 * Catalog entries. `asset` is the release file stem (`<asset>-<version>.tgz`);
 * `kind` is `bundle` (all-in-one), `module` (standalone plugin) or `file`
 * (downloaded only, never installed as a plugin).
 */
const FEATURED_PACKAGES = Object.freeze([
  { id: TOOLKIT_ID, kind: 'bundle', name: '@onenightcarnival/dsh-toolkit', asset: 'onenightcarnival-dsh-toolkit', ext: 'tgz' },
  { id: 'rdb', kind: 'module', name: '@onenightcarnival/dsh-rdb', asset: 'onenightcarnival-dsh-rdb', ext: 'tgz' },
  { id: 's3', kind: 'module', name: '@onenightcarnival/dsh-s3', asset: 'onenightcarnival-dsh-s3', ext: 'tgz' },
  { id: 'otel', kind: 'module', name: '@onenightcarnival/dsh-otel', asset: 'onenightcarnival-dsh-otel', ext: 'tgz' },
  { id: 'browser', kind: 'module', name: '@onenightcarnival/dsh-bridge-browser', asset: 'onenightcarnival-dsh-bridge-browser', ext: 'tgz' },
  { id: 'subscriptions', kind: 'module', name: '@onenightcarnival/dsh-subscriptions', asset: 'onenightcarnival-dsh-subscriptions', ext: 'tgz' },
  { id: 'config-center', kind: 'module', name: '@onenightcarnival/dsh-config-center', asset: 'onenightcarnival-dsh-config-center', ext: 'tgz' },
  { id: 'memory', kind: 'module', name: '@onenightcarnival/dsh-memory', asset: 'onenightcarnival-dsh-memory', ext: 'tgz' },
  { id: 'gateway', kind: 'module', name: '@onenightcarnival/dsh-gateway', asset: 'onenightcarnival-dsh-gateway', ext: 'tgz' },
  { id: 'extension', kind: 'file', name: 'dsh-browser-extension', asset: 'dsh-browser-extension-chrome', ext: 'zip' },
])

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** `v1.2.3` → `1.2.3`; other tags return null. */
function releaseVersion(tag) {
  const version = String(tag || '').replace(/^v/, '')
  return EXACT_VERSION.test(version) ? version : null
}

/**
 * The kernel version a toolkit tag pins, read from its root package.json.
 * @returns the exact version, or null when absent or not an exact pin.
 */
function pinnedKernel(packageJson) {
  const spec = packageJson && packageJson.dependencies && packageJson.dependencies['@deepseek-ai/dsh']
  return typeof spec === 'string' && EXACT_VERSION.test(spec) ? spec : null
}

/** Release asset file name of a catalog entry at a toolkit version. */
function assetName(entry, version) {
  return `${entry.asset}-${version}.${entry.ext}`
}

/** `SHA256SUMS.txt` → { [fileName]: hexDigest }. */
function parseSha256Sums(text) {
  const sums = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim())
    if (m) sums[m[2].trim()] = m[1].toLowerCase()
  }
  return sums
}

/**
 * Reduce a GitHub releases listing to the fields the catalog uses, newest
 * first; drafts and tags that are not versions are dropped.
 */
function normalizeReleases(list) {
  const releases = []
  for (const rel of Array.isArray(list) ? list : []) {
    if (!rel || rel.draft) continue
    const version = releaseVersion(rel.tag_name)
    if (!version) continue
    releases.push({
      tag: String(rel.tag_name),
      version,
      prerelease: Boolean(rel.prerelease),
      htmlUrl: typeof rel.html_url === 'string' ? rel.html_url : `https://github.com/${FEATURED_REPO}/releases/tag/${rel.tag_name}`,
      publishedAt: typeof rel.published_at === 'string' ? rel.published_at : null,
      assets: (Array.isArray(rel.assets) ? rel.assets : [])
        .filter(a => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
        .map(a => ({ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 })),
    })
  }
  return releases.sort((a, b) => compareVersionsDesc(a.version, b.version))
}

function compareVersionsDesc(a, b) {
  const { compareVersions } = require('./runtime.js')
  return compareVersions(b, a)
}

/**
 * First release whose pinned kernel equals the bundled kernel version.
 * @param releases - normalized releases, newest first, each with `kernel` (exact version, null, or undefined when unresolved).
 */
function pickCompatibleRelease(releases, kernelVersion) {
  if (!kernelVersion) return null
  return releases.find(rel => rel.kernel === kernelVersion) || null
}

/**
 * Catalog rows for the UI: install state of every entry against the
 * compatible release and the installed package versions.
 * @param installed - { [packageName]: version } read from the profile.
 */
function catalogRows(compatible, installed) {
  const sums = compatible && compatible.sums ? compatible.sums : {}
  return FEATURED_PACKAGES.map(entry => {
    const installedVersion = installed[entry.name] || null
    let asset = null
    if (compatible) {
      const name = assetName(entry, compatible.version)
      const found = compatible.assets.find(a => a.name === name)
      if (found) asset = { ...found, sha256: sums[name] || null }
    }
    let state
    if (entry.kind === 'file') state = asset ? 'download' : 'unavailable'
    else if (!asset) state = installedVersion ? 'installed' : 'unavailable'
    else if (!installedVersion) state = 'install'
    else if (installedVersion === compatible.version) state = 'installed'
    else state = 'update'
    return { ...entry, installedVersion, asset, state }
  })
}

/**
 * Packages that must be removed before `entry` is installed: the bundle
 * replaces installed modules; a module cannot join an installed bundle.
 * @returns { remove: string[] } or { blocked: 'bundle-installed' }.
 */
function installPlan(entry, installed) {
  if (entry.kind === 'bundle') {
    const remove = FEATURED_PACKAGES.filter(e => e.kind === 'module' && installed[e.name]).map(e => e.name)
    return { remove }
  }
  if (entry.kind === 'module') {
    const bundle = FEATURED_PACKAGES.find(e => e.kind === 'bundle')
    if (installed[bundle.name]) return { blocked: 'bundle-installed' }
    return { remove: [] }
  }
  return { remove: [] }
}

module.exports = {
  FEATURED_REPO, FEATURED_PROFILE, FEATURED_PACKAGES, TOOLKIT_ID,
  releaseVersion, pinnedKernel, assetName, parseSha256Sums, normalizeReleases,
  pickCompatibleRelease, catalogRows, installPlan,
}
