'use strict'
const { createRequire } = require('node:module')
const path = require('node:path')
let runtimeRequire

/** Resolve official keyboard dependencies from the active, version-matched dsh runtime. */
function configure(runtimeDir) {
  runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'))
}
function load(name) {
  if (!runtimeRequire) throw new Error('Desktop browser runtime is not configured')
  return runtimeRequire(name)
}
module.exports = { configure, load }
