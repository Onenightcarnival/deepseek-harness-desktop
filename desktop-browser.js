'use strict'
const { ipcMain, session } = require('electron')
const { DesktopBrowserGuests } = require('./vendor/deepseek-desktop/browser-guests.js')
const ipc = require('./desktop-browser-ipc.js')

/** Install official browser ownership and keyboard routing for the current local dsh runtime. */
function createDesktopBrowser({ getWindow, getUrl, runtimeDir, userData, updateMenu, configureSession = async () => {} }) {
  ipc.configure(getWindow, getUrl)
  require('./desktop-browser-runtime.js').configure(runtimeDir)
  const { installDesktopShortcuts } = require('./vendor/deepseek-desktop/keyboard.js')
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  const shortcuts = installDesktopShortcuts(() => getWindow() || undefined, userData, platform, updateMenu,
    () => ({ revision: 0, blocked: false }))
  const guests = new DesktopBrowserGuests(getUrl)
  const configured = new Map()
  ipcMain.handle(ipc.DESKTOP_IPC.browserAcquire, async (event, workspace) => {
    ipc.assertDesktopSender(event)
    const reservation = guests.acquire(event.sender, workspace)
    if (!configured.has(reservation.partition)) configured.set(reservation.partition,
      Promise.resolve().then(() => configureSession(session.fromPartition(reservation.partition))))
    try {
      await configured.get(reservation.partition)
      ipc.assertDesktopSender(event)
      return reservation
    } catch (error) {
      await guests.release(event.sender, reservation.lease)
      throw error
    }
  })
  ipcMain.handle(ipc.DESKTOP_IPC.browserRelease, (event, lease) => {
    ipc.assertDesktopSender(event)
    return guests.release(event.sender, lease)
  })
  return {
    shortcuts,
    attach(window) {
      guests.bind(window, (guest, lease) => shortcuts.attachGuest(window, guest, lease))
      shortcuts.attach(window)
    },
    dispose() {
      shortcuts.dispose()
      ipcMain.removeHandler(ipc.DESKTOP_IPC.browserAcquire)
      ipcMain.removeHandler(ipc.DESKTOP_IPC.browserRelease)
    },
  }
}
module.exports = { createDesktopBrowser }
