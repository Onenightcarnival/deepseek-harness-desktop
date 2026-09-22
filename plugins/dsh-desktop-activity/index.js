/**
 * Work-state reporter for the desktop shell. Every `intervalMs` (default
 * 2000) the plugin reads the host's `agents` and `jobs` services and sends
 * the shell one message whenever the busy state changes; the shell uses it
 * for 「运行任务时保持系统唤醒」. Busy means: an agent in the running phase,
 * an agent with queued input (next turn or next step), or a job that is
 * running or stopping (the same rule the upstream desktop app applies
 * before an update). Composed by the shell's patch overlay next to the
 * directory picker; a server started without the shell's IPC channel does
 * nothing.
 *
 * Wire (this process -> parent):
 *   { type: 'dsh-desktop:activity', busy: boolean }
 */
export const ACTIVITY = 'dsh-desktop:activity'

export const name = 'dsh-desktop-activity'

/**
 * Whether the host has running work.
 * @param {{ list(): any[] } | undefined} agents the `agents` service
 * @param {{ list(caller?: any): any[] } | undefined} jobs the `jobs` service
 */
export function isBusy(agents, jobs) {
  const live = agents && typeof agents.list === 'function' ? agents.list() : []
  for (const agent of live) {
    if (agent.status === 'running') return true
    const inbox = agent.inbox
    if (inbox && ((inbox.nextTurn && inbox.nextTurn.length > 0) || (inbox.nextStep && inbox.nextStep.length > 0))) return true
  }
  if (jobs && typeof jobs.list === 'function') {
    for (const owner of [undefined, ...live]) {
      let list = []
      try { list = jobs.list(owner) } catch { continue }
      if (list.some((job) => job.status === 'running' || job.status === 'stopping')) return true
    }
  }
  return false
}

export function apply(ctx, config = {}) {
  const channel = process
  if (typeof channel.send !== 'function' || !channel.connected) return
  const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs >= 250 ? config.intervalMs : 2000
  let last
  const tick = () => {
    let busy = false
    try { busy = isBusy(ctx.get('agents'), ctx.get('jobs')) } catch { busy = false }
    if (busy === last) return
    last = busy
    if (channel.connected) { try { channel.send({ type: ACTIVITY, busy }) } catch { /* shell gone */ } }
  }
  ctx.effect(() => {
    const timer = setInterval(tick, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    tick()
    return () => clearInterval(timer)
  })
}
