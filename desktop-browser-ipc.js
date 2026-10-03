'use strict'
const DESKTOP_IPC = require('./vendor/deepseek-desktop/channels.json')
let ownerWindow = () => undefined
let hostUrl = () => undefined

/** Bind official IPC to the shell's current window and authenticated loopback origin. */
function configure(getWindow, getUrl) {
  ownerWindow = getWindow
  hostUrl = getUrl
}
function isDesktopSender(contents, frame) {
  const window = ownerWindow()
  if (!window || window.isDestroyed() || contents !== window.webContents || !frame || frame !== contents.mainFrame) return false
  try { return !!hostUrl() && new URL(frame.url).origin === new URL(hostUrl()).origin } catch { return false }
}
function assertDesktopSender(event) {
  if (!isDesktopSender(event.sender, event.senderFrame)) throw new Error('Desktop browser: rejected IPC sender')
}
module.exports = { DESKTOP_IPC, configure, isDesktopSender, assertDesktopSender }
