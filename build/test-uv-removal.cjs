'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { removeLegacyUvLaunchers } = require('../runtime')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uv-launchers-'))
try {
  const windows = '@echo off\r\nset UV_CACHE_DIR=C:\\data\\cache\r\nset UV_PYTHON_INSTALL_DIR=C:\\data\\python\r\n"C:\\App\\resources\\dsh\\tools\\uv\\uvx.exe" %*\r\n'
  const mac = '#!/bin/sh\nexport UV_CACHE_DIR=/tmp/cache\nexport UV_PYTHON_INSTALL_DIR=/tmp/python\nexec "/Applications/DSH.app/Contents/Resources/dsh/tools/uv/uv" "$@"\n'
  fs.writeFileSync(path.join(temporary, 'uvx.cmd'), windows)
  fs.writeFileSync(path.join(temporary, 'uv'), mac)
  fs.writeFileSync(path.join(temporary, 'uv.cmd'), '@echo off\r\n"C:\\custom\\uv.exe" %*\r\n')
  fs.writeFileSync(path.join(temporary, 'uvx'), '#!/bin/sh\nexec /custom/uvx "$@"\n')
  fs.writeFileSync(path.join(temporary, 'node.cmd'), 'keep')
  removeLegacyUvLaunchers(temporary)
  assert.equal(fs.existsSync(path.join(temporary, 'uvx.cmd')), false)
  assert.equal(fs.existsSync(path.join(temporary, 'uv')), false)
  for (const file of ['uv.cmd', 'uvx', 'node.cmd']) assert.equal(fs.existsSync(path.join(temporary, file)), true)
  removeLegacyUvLaunchers(temporary)
  console.log('PASS: Windows/macOS legacy uv launchers removed; custom launchers and Node preserved')
} finally {
  if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('invalid test directory')
  fs.rmSync(temporary, { recursive: true, force: true })
}
