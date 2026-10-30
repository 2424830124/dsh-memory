/**
 * Activity-aware scheduler for cross-session memory notifications.
 *
 * Changes are versioned by visible directory. Idle sessions compare snapshots
 * only at a genuine user-message boundary; running sessions poll on a fixed
 * interval. The interval alone bounds how often a notice can arrive — one check
 * produces at most one notice — so there is no second per-change delay: a change
 * is checked by the very next tick, never skipped because it is too new. This
 * module owns cadence, not snapshot diffing or inbox delivery.
 *
 * @module dsh-memory/notification-scheduler
 */

export const NOTIFICATION_POLL_MS = 5_000

/**
 * @param {{directoriesOf: (agent: object) => string[], check: (agent: object) => Promise<unknown>|unknown, onError?: (error: unknown, agent?: object) => void, pollMs?: number}} options - collaborators.
 */
export class MemoryNotificationScheduler {
  constructor(options) {
    this.directoriesOf = options.directoriesOf
    this.check = options.check
    this.onError = options.onError ?? (() => {})
    this.pollMs = options.pollMs ?? NOTIFICATION_POLL_MS
    this.revision = 0
    /** @type {Map<string, {revision: number}>} latest change per directory. */
    this.pending = new Map()
    /** @type {Map<string, object>} agents with a running model loop. */
    this.running = new Map()
    /** @type {Map<string, Map<string, number>>} checked revision per agent/directory. */
    this.checked = new Map()
    /** @type {Map<string, Map<string, {revision: number}>>} resumed-session baseline revisions. */
    this.forced = new Map()
    /** @type {Map<string, Promise<boolean>>} one in-flight check per agent. */
    this.checking = new Map()
    /** @type {Set<string>} user boundaries received during a check. */
    this.again = new Set()
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined
  }

  /** Record one change; several writes coalesce to the newest directory revision. */
  markChanged(directory, alreadyCurrent) {
    const revision = ++this.revision
    this.pending.set(directory, { revision })
    if (alreadyCurrent !== undefined) {
      const id = String(alreadyCurrent.id)
      const checked = this.checked.get(id) ?? new Map()
      checked.set(directory, revision)
      this.checked.set(id, checked)
    }
    return revision
  }

  /** Queue selected directories for a future snapshot check without changing global revisions. */
  markPending(agent, directories = this.directoriesOf(agent)) {
    const id = String(agent.id)
    const pending = this.forced.get(id) ?? new Map()
    for (const directory of directories) pending.set(directory, { revision: ++this.revision })
    this.forced.set(id, pending)
  }

  /** Capture current visible revisions before an asynchronous baseline read. */
  capture(agent) {
    const id = String(agent.id)
    const forced = this.forced.get(id)
    const revisions = new Map()
    for (const directory of this.directoriesOf(agent)) {
      revisions.set(directory, Math.max(this.pending.get(directory)?.revision ?? 0, forced?.get(directory)?.revision ?? 0))
    }
    return revisions
  }

  /** Treat captured directory revisions as part of an established baseline. */
  markChecked(agent, revisions = this.capture(agent)) {
    const id = String(agent.id)
    const checked = this.checked.get(id) ?? new Map()
    for (const [directory, revision] of revisions) {
      if (revision > 0) checked.set(directory, Math.max(checked.get(directory) ?? 0, revision))
    }
    this.checked.set(id, checked)
    this.forced.delete(id)
  }

  /** Track running state and maintain one shared poll timer. */
  setRunning(agent, running) {
    const id = String(agent.id)
    if (running === true) {
      this.running.set(id, agent)
      this.ensurePoll()
      return
    }
    this.running.delete(id)
    if (this.running.size === 0) this.stopPoll()
  }

  /** Only real user messages can trigger an idle-session check. */
  onUserMessage(agent, message) {
    if (message?.role !== 'user' || message?.source?.kind !== 'user') return Promise.resolve(false)
    const id = String(agent.id)
    if (this.running.has(id)) return Promise.resolve(false)
    if (this.checking.has(id)) {
      this.again.add(id)
      return this.checking.get(id)
    }
    return this.checkAgent(agent)
  }

  /** One shared interval invokes this for currently running agents. */
  async poll() {
    await Promise.all([...this.running.values()].map((agent) => this.checkAgent(agent)))
  }

  /** After an inbox discard, make its queued changes eligible again. */
  retry(agent) {
    const id = String(agent.id)
    const checked = this.checked.get(id)
    if (checked === undefined) return
    for (const directory of this.directoriesOf(agent)) {
      if (this.pending.has(directory) || this.forced.get(id)?.has(directory)) checked.delete(directory)
    }
  }

  /** Remove all per-agent scheduling state at disposal. */
  forget(agent) {
    const id = String(agent.id)
    this.running.delete(id)
    this.checked.delete(id)
    this.forced.delete(id)
    this.again.delete(id)
    if (this.running.size === 0) this.stopPoll()
  }

  /** Stop timers when the plugin is disposed. */
  stop() {
    this.running.clear()
    this.stopPoll()
  }

  ensurePoll() {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => this.poll().catch((error) => this.onError(error)), this.pollMs)
    this.timer.unref?.()
  }

  stopPoll() {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  latestFor(agent) {
    const id = String(agent.id)
    const latest = new Map()
    const forced = this.forced.get(id)
    for (const directory of this.directoriesOf(agent)) {
      const ordinary = this.pending.get(directory)
      const resumed = forced?.get(directory)
      const change = !ordinary ? resumed : !resumed ? ordinary : ordinary.revision >= resumed.revision ? ordinary : resumed
      if (change === undefined) continue
      latest.set(directory, change.revision)
    }
    return latest
  }

  hasPending(agent) {
    const checked = this.checked.get(String(agent.id))
    for (const [directory, revision] of this.latestFor(agent)) {
      if (revision > (checked?.get(directory) ?? 0)) return true
    }
    return false
  }

  async checkAgent(agent) {
    const id = String(agent.id)
    const existing = this.checking.get(id)
    if (existing !== undefined) return existing
    if (!this.hasPending(agent)) return false

    const operation = (async () => {
      let checkedAny = false
      do {
        this.again.delete(id)
        // Snapshot the revision boundary before the async diff; writes racing
        // this callback remain pending for the next poll/user-message boundary.
        const latest = this.latestFor(agent)
        if (latest.size === 0) return checkedAny
        const completed = await this.check(agent)
        if (completed === false) return false
        const checked = this.checked.get(id) ?? new Map()
        for (const [directory, revision] of latest) {
          checked.set(directory, Math.max(checked.get(directory) ?? 0, revision))
        }
        this.checked.set(id, checked)
        const forced = this.forced.get(id)
        for (const [directory, revision] of latest) {
          if ((forced?.get(directory)?.revision ?? Infinity) <= revision) forced?.delete(directory)
        }
        if (forced?.size === 0) this.forced.delete(id)
        checkedAny = true
      } while (this.again.has(id) && this.hasPending(agent))
      return checkedAny
    })()

    this.checking.set(id, operation)
    try {
      return await operation
    } finally {
      if (this.checking.get(id) === operation) this.checking.delete(id)
      const rerun = this.again.delete(id) && this.hasPending(agent)
      if (rerun) queueMicrotask(() => this.checkAgent(agent).catch((error) => this.onError(error, agent)))
    }
  }
}
