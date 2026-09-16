/**
 * `ctx.directoryPicker` backend for the desktop shell. Serves the `native`
 * capability: a pick request goes over the Node IPC channel the shell opened
 * when it spawned the dsh server, the shell shows the OS folder dialog
 * (Electron `dialog.showOpenDialog`, modal to the app window) and answers
 * with the chosen path. Composed by the shell's picker patch overlay in place
 * of directory-picker-auto, paired with the stock native client surface.
 *
 * Wire (parent <-> this process):
 *   -> { type: 'dsh-desktop:pick-directory', id }
 *   <- { type: 'dsh-desktop:pick-directory-result', id, path: string | null, error?: string }
 *   -> { type: 'dsh-desktop:pick-directory-cancel', id }   (caller aborted; the answer is dropped)
 */
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'

export const PICK_REQUEST = 'dsh-desktop:pick-directory'
export const PICK_RESULT = 'dsh-desktop:pick-directory-result'
export const PICK_CANCEL = 'dsh-desktop:pick-directory-cancel'

let sequence = 0

/**
 * Ask the shell for one folder choice.
 * @param {AbortSignal} signal caller lifetime; abort rejects and tells the shell to drop the answer.
 * @param {{ send?: Function, on?: Function, off?: Function }} channel process-like IPC surface (tests inject a fake).
 * @returns {Promise<string | null>} the chosen absolute path, or null when the dialog was cancelled.
 */
export function pickThroughShell(signal, channel = process) {
  return new Promise((resolve, reject) => {
    if (typeof channel.send !== 'function' || !channel.connected) {
      reject(new Error('desktop directory picker: no IPC channel to the shell (the server was not started by DeepSeek Harness Desktop)'))
      return
    }
    if (signal.aborted) { reject(new Error('directory picker aborted')); return }
    const id = `${process.pid}-${++sequence}`
    const cleanup = () => {
      channel.off('message', onMessage)
      signal.removeEventListener('abort', onAbort)
    }
    const onMessage = (message) => {
      if (message === null || typeof message !== 'object' || message.type !== PICK_RESULT || message.id !== id) return
      cleanup()
      if (typeof message.error === 'string' && message.error !== '') reject(new Error(message.error))
      else resolve(typeof message.path === 'string' && message.path !== '' ? message.path : null)
    }
    const onAbort = () => {
      cleanup()
      try { channel.send({ type: PICK_CANCEL, id }) } catch { /* shell gone; nothing to cancel */ }
      reject(new Error('directory picker aborted'))
    }
    channel.on('message', onMessage)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      channel.send({ type: PICK_REQUEST, id })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

export default class DesktopDirectoryPicker extends DirectoryPicker {
  nativeCapability = {
    kind: 'native',
    pick: (signal) => pickThroughShell(signal),
  }

  capability() {
    return this.nativeCapability
  }
}
