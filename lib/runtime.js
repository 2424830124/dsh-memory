/**
 * Runtime coordinator: memory views, delivery snapshots, and cross-session
 * notices.
 *
 * This module owns everything that is not a pure document operation: which files
 * a session sees, what it has already been told about, and how a change in one
 * session reaches the others.
 *
 * The notification design rests on one rule: *a session hears about a change
 * only if it has not already been told about it*. Every path that can surface a
 * change - a write here, a write in another session, a session resuming, an
 * external editor touching a file - funnels through
 * {@link MemoryRuntime.notifyAgent}, so that rule lives in exactly one place.
 *
 * @module dsh-memory/runtime
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { sameFileOnDisk } from './atomic.js'
import { defaultSettings } from './config-schema.js'
import { applyEdit } from './edit.js'
import { DocumentError } from './errors.js'
import { hashText } from './hash.js'
import {
  formatLogDate,
  inTimeRange,
  isLogDate,
  logDateValue,
  logEntries,
  parseLogDateQuery,
  parseLogTimeQuery,
} from './log.js'
import { selectLogInjection } from './log-injection.js'
import { assertUsableFileName, cloneDocument, createDocument, readInjectIgnore } from './model.js'
import { NOTICE_SOURCE_KIND, renderBrokenNotice, renderNotice } from './notice.js'
import { MemoryPanelService } from './panel-service.js'
import { MemoryNotificationScheduler } from './notification-scheduler.js'
import { renderFileList, renderInjection, renderLogRange, renderRead } from './render.js'
import {
  copySnapshot,
  diffEntries,
  isStale,
  pruneSnapshots,
  readSnapshot,
  removeSnapshot,
  snapshotEntry,
  writeSnapshot,
} from './snapshot.js'
import { localTimestamp, normalizeMetaLine } from './text.js'
import { findNode } from './tree.js'
import { orderByConfig } from './file-order.js'

/**
 * Marks one memory file across every cache in this process.
 *
 * The key carries the directory, because a Global file and a Workspace file may
 * share a `file_name` and both would otherwise collide.
 *
 * @param {string} directory - the memory directory.
 * @param {string} fileName - `meta_data.file_name`.
 * @returns {string} the cache key.
 */
function fileKey(directory, fileName) {
  return `${directory}\u0000${fileName}`
}

/**
 * The scope one memory directory serves.
 *
 * Everything that needs a scope for a directory it already holds goes through
 * here, so "Global is the global directory, everything else is a workspace" is
 * decided in one place instead of being re-derived at each call site.
 *
 * @param {string} globalDir - the Global memory directory.
 * @param {string} directory - the memory directory.
 * @returns {'Global'|'Workspace'} the scope that directory serves.
 */
function scopeOfDirectory(globalDir, directory) {
  return directory === globalDir ? 'Global' : 'Workspace'
}

/**
 * Changes reported for one file.
 * @typedef {object} FileUpdate
 * @property {string} fileName - `meta_data.file_name`.
 * @property {string} scope - `Global` or `Workspace`.
 * @property {import('./notice.js').SectionChange[]} changes - what changed.
 */

/**
 * Coordinate memory files with the agents that read and write them.
 */
export class MemoryRuntime {
  /**
   * @param {object} options - runtime configuration.
   * @param {import('./store.js').MemoryStore} options.store - the file store.
   * @param {object} options.config - resolved plugin configuration.
   * @param {object} options.logger - diagnostic sink.
   */
  constructor(options) {
    this.store = options.store
    // 默认值在这里补齐一次：下面每个读配置的地方就不必再写一遍 `?? 默认值`，
    // 也免得某个调用方少传一个键时静默拿到 undefined。
    this.config = { ...defaultSettings(), ...(options.config ?? {}) }
    this.logger = options.logger

    /** @type {WeakMap<object, string>} agent -> workspace root. */
    this.agentRoots = new WeakMap()
    /** @type {Map<string, string>} session id -> workspace root, for the browser panel. */
    this.sessionRoots = new Map()
    /**
     * The last workspace root any session resolved.
     *
     * `agentRoots` is a WeakMap — it cannot be iterated, so the "most recent"
     * answer has to be remembered here instead.
     *
     * @type {string|undefined}
     */
    this.lastWorkspaceRoot = undefined
    /** @type {Map<string, Record<string, object>>} session id -> delivered snapshot. */
    this.delivered = new Map()
    /** @type {Map<string, Record<string, object>>} session id -> snapshot already in flight. */
    this.inFlight = new Map()
    /** @type {Map<string, Record<string, object>>} session id -> baseline before the queued notice. */
    this.pendingBaseline = new Map()
    /** @type {Map<string, Map<string, string>>} session id -> file key -> hash the model last read. */
    this.reads = new Map()
    /** @type {Map<string, string>} session id -> signature of the broken-file notice it already got. */
    this.brokenNoticed = new Map()
    /**
     * Frozen prompt text, one per session.
     *
     * The memory block sits near the front of the request, so re-rendering it
     * whenever a file changes would invalidate the provider's prefix cache on
     * every edit. A session therefore keeps the exact text it opened with, and
     * later changes reach it as notices instead.
     *
     * @type {Map<string, {text: string, logKeys: string[]}>}
     */
    this.frozen = new Map()
    /**
     * Frozen `memory_edit` description, one per session.
     *
     * Same reason as {@link MemoryRuntime#frozen}: the description lists every
     * file's format, so it used to change whenever a file appeared.
     *
     * @type {Map<string, string>}
     */
    this.toolText = new Map()
    /**
     * When the model last finished a message, one per session.
     *
     * Snapshot retention is measured from here — not from the last snapshot
     * write — because a notice delivered to an idle session must not keep a
     * prefix cache alive that the provider has long since dropped.
     *
     * @type {Map<string, string>}
     */
    this.touched = new Map()
    /**
     * In-flight snapshot write, one per session.
     *
     * Snapshot writes are temp-file + rename, and on Windows a rename onto the
     * destination that another rename is already replacing fails with EPERM.
     * Two writers race whenever the freeze path and a delivery both persist, so
     * each session's writes are chained.
     *
     * @type {Map<string, Promise<void>>}
     */
    this.writing = new Map()
    this.notificationScheduler = new MemoryNotificationScheduler({
      directoriesOf: (agent) => this.dirsOf(agent),
      check: async (agent) => {
        if (!this.delivered.has(String(agent?.id))) return false
        const brokenOk = await this.notifyBroken(agent)
        const changesOk = this.notifyAgent(agent)
        return brokenOk !== false && changesOk !== false
      },
      onError: (error, agent) => this.logger.warn(`memory: 检查会话 ${String(agent?.id)} 的通知失败 ${error?.message ?? error}`),
      pollMs: options.notificationPollMs,
    })
    /** @type {NodeJS.Timeout|undefined} timer that rolls the daily log at midnight. */
    this.midnight = undefined
    /** @type {NodeJS.Timeout|undefined} timer that sweeps expired snapshots. */
    this.sweeper = undefined
    this.panel = new MemoryPanelService({
      store: this.store,
      config: this.config,
      resolveDirectory: (scope, sessionId) => this.panelDirectory(scope, sessionId),
      broadcast: (directory, except) => this.broadcast(directory, except),
    })
  }

  setAgentRunning(agent, running) {
    this.notificationScheduler.setRunning(agent, running)
  }

  /** Check pending changes at the idle session's user-message boundary. */
  onUserMessage(agent, message) {
    return this.notificationScheduler.onUserMessage(agent, message)
  }

  /**
   * Apply settings changed while the plugin is running.
   *
   * Only the fields passed are touched; everything else keeps its resolved
   * value. Edits made after this call see the new limits immediately.
   *
   * @param {object} patch - the settings to replace.
   * @returns {object} the settings in effect afterwards.
   */
  updateSettings(patch) {
    Object.assign(this.config, patch ?? {})
    return this.config
  }

  /**
   * Load the Global directory, prune old snapshots, and open today's log.
   *
   * The daily roll happens here and again at every midnight, so a session that
   * runs for days keeps finding a file to write into.
   *
   * @returns {Promise<void>} completion.
   */
  async start() {
    await this.store.ensureDirectory(this.store.globalDir, 'Global')
    await pruneSnapshots(this.store.stateDir, this.config.snapshotTtlMinutes)
    await this.ensureTodayLog()
    this.scheduleMidnight()
    this.schedulePrune()
  }

  /**
   * Stop the daily timer and the snapshot sweeper.
   * @returns {void}
   */
  stop() {
    this.notificationScheduler.stop()
    if (this.midnight !== undefined) {
      clearTimeout(this.midnight)
      this.midnight = undefined
    }
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
  }

  /**
   * Sweep expired snapshots on a fixed interval.
   *
   * Pruning at startup alone would only ever clean up after a restart, and a
   * harness process can easily run for days. The interval is half the retention
   * window (clamped to a sane range) so a snapshot never survives much longer
   * than it should, without waking up more often than needed.
   *
   * @returns {void}
   */
  schedulePrune() {
    if (this.sweeper !== undefined) clearInterval(this.sweeper)
    const minutes = this.config.snapshotTtlMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) {
      this.sweeper = undefined
      return
    }
    const every = Math.min(Math.max(Math.trunc((minutes * 60 * 1000) / 2), 60 * 1000), 30 * 60 * 1000)
    this.sweeper = setInterval(() => {
      pruneSnapshots(this.store.stateDir, this.config.snapshotTtlMinutes).catch((error) => {
        this.logger.warn(`memory: 清理会话快照失败 ${error?.message ?? error}`)
      })
    }, every)
    this.sweeper.unref?.()
  }

  // ------------------------------------------------------------------- logs

  /**
   * Every log one agent can see, one entry per date, ascending.
   *
   * The file is paired with the directory it was loaded from rather than looked
   * up again later: the same date may exist as a Global and as a Workspace file,
   * and the read guard has to key on the one the model actually saw.
   *
   * The Workspace copy wins a collision because `logDirectoryOf` is where new
   * entries are appended: what an agent reads and what it writes must agree.
   *
   * @param {object} agent - the live agent.
   * @returns {{directory: string, document: import('./model.js').MemoryDocument}[]} the files.
   */
  logFilesOf(agent, scope) {
    const byDate = new Map()
    for (const directory of this.directoriesFor(agent, scope)) {
      for (const document of this.store.logDocuments(directory)) byDate.set(document.fileName, { directory, document })
    }
    return [...byDate.values()].sort((a, b) => logDateValue(a.document.fileName) - logDateValue(b.document.fileName))
  }

  /**
   * Directory holding the log one agent should write, Workspace preferred.
   * @param {object} agent - the live agent.
   * @param {string|undefined} [scope] - the requested scope; omit for the default.
   * @returns {string} the absolute memory directory.
   * @throws {DocumentError} when the scope is unknown or unusable in this session.
   */
  logDirectoryOf(agent, scope) {
    if (scope !== undefined) return this.directoriesFor(agent, scope)[0]
    const workspace = this.workspaceDirOf(agent)
    return workspace ?? this.store.globalDir
  }

  /**
   * Create today's log file wherever it is missing.
   * @returns {Promise<void>} completion.
   */
  async ensureTodayLog() {
    const date = formatLogDate()
    for (const directory of this.store.directories()) {
      const scope = scopeOfDirectory(this.store.globalDir, directory)
      try {
        await this.store.ensureDirectory(directory, scope)
        if (this.store.logFile(directory, date) !== undefined) continue
        await this.createLog(directory, date, scope)
      } catch (error) {
        this.logger.warn(`memory: 创建 ${date} 的日志失败 ${directory}: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Write one empty log file.
   * @param {string} directory - the memory directory to write into.
   * @param {string} date - `YYYY-MM-DD`.
   * @param {'Global'|'Workspace'} scope - the scope that directory serves.
   * @returns {Promise<unknown>} the written file.
   */
  createLog(directory, date, scope) {
    return this.store.write(directory, scope, createDocument({ fileName: date, kind: 'log', scope }))
  }

  /**
   * Roll the log forward at the next local midnight.
   * @returns {void}
   */
  scheduleMidnight() {
    this.stop()
    const now = new Date()
    // Five seconds past midnight: the timer is not exact, and a roll that fires
    // a few milliseconds early would create the file under the old date.
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
    this.midnight = setTimeout(() => {
      this.ensureTodayLog()
        .catch((error) => this.logger.warn(`memory: 零点切换日志失败 ${error?.message ?? error}`))
        .finally(() => this.scheduleMidnight())
    }, Math.max(next.getTime() - now.getTime(), 1000))
    this.midnight.unref?.()
  }

  // ---------------------------------------------------------------- agents

  /**
   * Attach one agent: load its workspace directory and replay missed changes.
   * @param {object} agent - the live agent.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<void>} completion.
   */
  async attach(agent, signal) {
    const root = await this.workspaceRootOf(agent, signal).catch((error) => {
      this.logger.warn(`memory: 无法确定会话工作目录: ${error?.message ?? error}`)
      return undefined
    })
    if (root !== undefined) {
      this.agentRoots.set(agent, root)
      this.lastWorkspaceRoot = root
      // 浏览器面板没有 agent，只能凭会话 id 找回工作区，所以这里同时登记一份。
      this.sessionRoots.set(String(agent.id), root)
      await this.store.ensureDirectory(this.store.workspaceDir(root), 'Workspace')
      await this.ensureTodayLog()
    }

    const id = String(agent.id)
    const stored = await this.openSnapshot(agent)
    this.delivered.set(id, stored?.files ?? {})

    if (stored === undefined) {
      // Capture before rendering/writing the baseline so concurrent changes remain
      // newer than this fresh session's known state.
      const baselineRevisions = this.notificationScheduler.capture(agent)
      // A brand-new session has no history to replay, and the prompt injection
      // it is about to receive is exactly what is on disk right now. Adopting
      // that state as its baseline is what keeps a fresh session from opening
      // with an update notice listing every file the model already sees.
      await this.advance(agent, this.currentSnapshot(agent))
      this.notificationScheduler.markChecked(agent, baselineRevisions)
      const brokenDirectories = this.dirsOf(agent).filter((directory) => this.store.broken(directory).length > 0)
      if (brokenDirectories.length > 0) this.notificationScheduler.markPending(agent, brokenDirectories)
      return
    }
    this.notificationScheduler.markPending(agent)
  }

  /**
   * Load the snapshot one agent should continue from.
   *
   * Two things happen here that a plain read would miss:
   *
   * - An expired snapshot is deleted and treated as absent. Its frozen prompt
   *   text may name files that changed while the session sat idle, and the
   *   provider's prefix cache is gone by then anyway, so rebuilding is both
   *   correct and free.
   * - A fork copies its parent's snapshot. The fork was created from the parent's
   *   conversation, so it must start from the same frozen prefix; rendering a
   *   fresh one would stop the two from sharing a cache. A parent whose snapshot
   *   is already gone is not an error — the fork simply starts clean.
   *
   * @param {object} agent - the live agent.
   * @returns {Promise<import('./snapshot.js').SessionSnapshot|undefined>} the snapshot to continue from.
   */
  async openSnapshot(agent) {
    const id = String(agent.id)
    const ttl = this.config.snapshotTtlMinutes
    const stored = await readSnapshot(this.store.stateDir, id)
    if (stored !== undefined) {
      if (!isStale(stored, ttl)) {
        this.remember(agent, stored)
        return stored
      }
      await removeSnapshot(this.store.stateDir, id).catch((error) => {
        this.logger.warn(`memory: 删除过期会话快照失败 ${id}: ${error?.message ?? error}`)
      })
    }

    const parent = this.parentOf(agent)
    if (parent === undefined) return undefined
    const copied = await copySnapshot(this.store.stateDir, parent, id).catch((error) => {
      this.logger.warn(`memory: 复制父会话快照失败 ${parent} -> ${id}: ${error?.message ?? error}`)
      return false
    })
    if (copied !== true) return undefined
    const inherited = await readSnapshot(this.store.stateDir, id)
    if (inherited === undefined) return undefined
    // A fork may only continue a prefix that is still live. If the parent sat
    // idle past the window its own cache is gone and it will rebuild on its next
    // assembly, so inheriting that text would just make the fork diverge from the
    // parent it was supposed to share a prefix with.
    if (isStale(inherited, ttl)) {
      await removeSnapshot(this.store.stateDir, id).catch(() => {})
      return undefined
    }
    this.remember(agent, inherited)
    return inherited
  }

  /**
   * The session one agent forked from, if any.
   * @param {object} agent - the live agent.
   * @returns {string|undefined} the parent session identity.
   */
  parentOf(agent) {
    const parent = agent?.session?.header?.parentSession
    return typeof parent === 'string' && parent !== '' ? parent : undefined
  }

  /**
   * Hold one loaded snapshot's frozen parts in memory.
   * @param {object} agent - the live agent.
   * @param {import('./snapshot.js').SessionSnapshot} stored - the loaded snapshot.
   * @returns {void}
   */
  remember(agent, stored) {
    const id = String(agent.id)
    if (stored.injected !== undefined) this.frozen.set(id, { ...stored.injected, at: stored.updatedAt })
    if (typeof stored.tools === 'string') this.toolText.set(id, stored.tools)
    if (typeof stored.updatedAt === 'string') this.touched.set(id, stored.updatedAt)
  }

  /**
   * Resolve one agent's workspace root.
   * @param {object} agent - the live agent.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string|undefined>} the absolute directory.
   */
  async workspaceRootOf(agent, signal) {
    // 插件可能比 workingDirectory 服务先加载，所以这里接受“取服务的函数”，每次现取。
    const source = this.config.workingDirectory
    const service = typeof source === 'function' ? source() : source
    if (service === undefined) return undefined
    return service.ensure(agent, signal)
  }

  /**
   * Directory holding one agent's workspace memory files.
   * @param {object} agent - the live agent.
   * @returns {string|undefined} the absolute directory.
   */
  workspaceDirOf(agent) {
    const root = this.agentRoots.get(agent)
    return root === undefined ? undefined : this.store.workspaceDir(root)
  }

  /**
   * One workspace root to show in the panel.
   *
   * The settings route has no agent, so it cannot ask "which workspace is this
   * session in". The last root any session resolved is a good enough answer for
   * a browser view, and it is explicitly absent when no session has needed one.
   *
   * @returns {string|undefined} the most recently seen workspace root.
   */
  get knownWorkspaceRoot() {
    return this.lastWorkspaceRoot
  }

  /**
   * The directory one scope stands for, as the browser panel sees it.
   *
   * Global is fixed. Workspace follows the session on screen: its root is
   * looked up by session id first, and only then by "the last root any session
   * resolved" — never by guessing a path.
   *
   * @param {'Global'|'Workspace'} scope - the scope to resolve.
   * @param {string} [sessionId] - the session the panel belongs to.
   * @returns {string|undefined} the absolute directory, or undefined when no workspace is known.
   */
  panelDirectory(scope, sessionId) {
    if (scope === 'Global') return this.store.globalDir
    const root = (sessionId === undefined ? undefined : this.sessionRoots.get(sessionId)) ?? this.lastWorkspaceRoot
    return root === undefined ? undefined : this.store.workspaceDir(root)
  }

  /**
   * What each scope currently holds, for the browser panel.
   *
   * `files` and `logs` are kept apart because they are two different shelves:
   * a notebook is addressed by name, a day is addressed by date. The rail shows
   * them under two tabs and never mixes them into one list.
   *
   * @param {string} [sessionId] - the session whose workspace to show.
   * @returns {Promise<{scope: 'Global'|'Workspace', directory?: string, files: object[], logs: object[]}[]>} both scopes, Global first.
   */
  async overview(sessionId) {
    return this.panel.overview(sessionId)
  }

  /**
   * 「面板说的是哪个 scope、哪个货架、哪一份文件」——这一套解析三处都要用。
   *
   * 名字在不同货架上可以重名，所以先按 kind 选货架、再按名字找；目录不在时
   * `directory` 为 undefined，由调用方决定是报错还是当作「没有」。
   *
   * @param {{scope?: string, sessionId?: string, fileName: string, kind?: string}} request - which file the panel means.
   * @returns {Promise<{scope: string, kind: string, directory: string|undefined, pool: object[], document: object|undefined}>} the resolved parts.
   */
  async panelTarget(request) {
    return this.panel.panelTarget(request)
  }

  /**
   * One file rendered the way `memory_read` renders it.
   *
   * The panel shows three views of the same file side by side: the bytes on
   * disk (`source`), what `memory_read` returns (`text`), and what the model
   * gets for free in its prompt (`injected`). Rendering them here, from the
   * same functions the tools use, is the point - a second formatting path in
   * the UI would drift and start lying about what the model sees.
   *
   * @param {{scope?: string, sessionId?: string, fileName: string, kind?: string}} request - which file to render.
   * @returns {Promise<{fileName: string, scope: string, kind: string, source: string, text: string, injected: string}|undefined>} the rendered file, or undefined when it is gone.
   */
  async fileText(request) {
    return this.panel.fileText(request)
  }

  /**
   * Apply the edits the browser panel makes in place.
   *
   * Only the fields the panel shows as inputs are accepted: the file's
   * description and format, which values stay out of the prompt, and each
   * heading's body and keywords. `update_at` is deliberately not writable - it
   * records when the content last changed, and a hand-typed timestamp would be
   * a lie the next reader has no way to catch.
   *
   * The hash of the loaded file guards the write, so a file that changed on
   * disk between the panel rendering and the save is rejected instead of
   * silently overwritten by a stale tab.
   *
   * @param {{scope?: string, sessionId?: string, fileName: string, kind?: string, desc?: string, format?: string, injectIgnore?: string[], nodes?: {path: string[], title?: string, desc?: string, keyword?: string[]}[], removed?: string[][]} request - the patch.
   * @returns {Promise<object|undefined>} the file as it now reads.
   * @throws {DocumentError} when the file or one of its headings is gone, or the write is stale.
   */
  async patchFile(request) {
    return this.panel.patchFile(request)
  }

  /**
   * Create an empty memory file from the panel.
   *
   * Only memory files: a log day is created by writing to it, so an empty one
   * would just be a blank day in the log shelf.
   *
   * @param {{scope?: string, sessionId?: string, fileName: string}} request - the name to create.
   * @returns {Promise<object|undefined>} the new file as it now reads.
   * @throws {DocumentError} when the name is unusable or already taken.
   */
  async createFile(request) {
    return this.panel.createFile(request)
  }

  /**
   * Delete a whole file from the panel.
   *
   * Memory and log days both go through here: the caller names the shelf with
   * `kind`, and a missing file is reported as a `DocumentError` rather than
   * silently succeeding.
   *
   * @param {{scope?: string, sessionId?: string, fileName: string, kind?: string}} request - which file to drop.
   * @returns {Promise<{fileName: string, scope: string, kind: string}|undefined>} what was removed, or undefined when the session has no directory.
   * @throws {DocumentError} when the file is not there.
   */
  async deleteFile(request) {
    return this.panel.deleteFile(request)
  }

  /**
   * Every directory one agent draws memory from, Global first.
   * @param {object} agent - the live agent.
   * @returns {string[]} absolute directories.
   */
  dirsOf(agent) {
    const workspace = this.workspaceDirOf(agent)
    return workspace === undefined ? [this.store.globalDir] : [this.store.globalDir, workspace]
  }

  /**
   * The directories one request may address, narrowed by an explicit scope.
   *
   * An omitted scope keeps the default search order, so a request that does not
   * care which copy it gets still works; a given scope pins the lookup to that
   * one directory, which is how a file shadowed by a same-named one in the other
   * scope stays reachable.
   *
   * @param {object} agent - the live agent.
   * @param {string|undefined} scope - `Global`, `Workspace`, or undefined for all of them.
   * @returns {string[]} absolute directories.
   * @throws {DocumentError} when the scope is unknown or unusable in this session.
   */
  directoriesFor(agent, scope) {
    if (scope === undefined) return this.dirsOf(agent)
    if (scope === 'Global') return [this.store.globalDir]
    if (scope !== 'Workspace') throw new DocumentError('scope 必须是 Global 或 Workspace')
    const workspace = this.workspaceDirOf(agent)
    if (workspace === undefined) throw new DocumentError('当前会话没有工作目录，没有 Workspace 记忆')
    return [workspace]
  }

  /**
   * Every document one agent sees, optionally only one scope's.
   * @param {object} agent - the live agent.
   * @param {string|undefined} [scope] - narrows the list to one scope.
   * @returns {import('./model.js').MemoryDocument[]} documents.
   */
  documentsOf(agent, scope) {
    return this.directoriesFor(agent, scope).flatMap((directory) => this.store.documents(directory))
  }

  /**
   * Every file one agent can see that failed to parse.
   *
   * A broken file still belongs to the session, so the file list has to name it:
   * hiding it made a hand-edited YAML file look deleted, and the parse error only
   * surfaced when the model happened to read that exact file by name.
   *
   * @param {object} agent - the live agent.
   * @param {string|undefined} [scope] - narrows the list to one scope.
   * @returns {import('./cache.js').LoadedFile[]} broken files, in file-name order.
   */
  brokenFilesOf(agent, scope) {
    return this.directoriesFor(agent, scope)
      .flatMap((directory) => this.store.broken(directory))
      .sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh'))
  }

  /**
   * Every document this process knows about, across all directories.
   *
   * Used for the edit tool's `format` block, which is deliberately not per-agent:
   * the model should learn a file's rules before it tries to edit it.
   *
   * @returns {import('./model.js').MemoryDocument[]} documents.
   */
  allDocuments() {
    return this.store.directories().flatMap((directory) => this.store.documents(directory))
  }

  /**
   * Whether one agent can see one directory.
   * @param {object} agent - the live agent.
   * @param {string} directory - the memory directory.
   * @returns {boolean} whether it is one of that agent's directories.
   */
  sees(agent, directory) {
    return this.dirsOf(agent).includes(directory)
  }

  /**
   * Every file one agent is shown, paired with the key that identifies it.
   * @param {object} agent - the live agent.
   * @returns {{key: string, directory: string, document: import('./model.js').MemoryDocument}[]} visible files.
   */
  visibleFiles(agent) {
    const files = []
    for (const directory of this.dirsOf(agent)) {
      for (const document of this.store.documents(directory)) {
        files.push({ key: fileKey(directory, document.fileName), directory, document })
      }
    }
    return files
  }

  // ------------------------------------------------------------- snapshot

  /**
   * Prompt section text for one assembly.
   *
   * The text is frozen the first time a session asks for it and reused verbatim
   * afterwards. It sits near the front of the request, so re-rendering it on
   * every file change would move the provider's prefix boundary and throw away
   * the cache on each edit — for a session that is already looking at a copy of
   * the same files. Changes reach a running session as notices instead.
   *
   * @param {{agent?: object}} context - the assembly context.
   * @returns {string} the injected memory block, or `''`.
   */
  sectionText(context) {
    const agent = context?.agent
    if (agent === undefined) return ''
    const id = String(agent.id)
    const frozen = this.frozen.get(id)
    // A session that sat idle past the retention window starts a new cache epoch:
    // the provider has dropped the prefix, so freezing no longer buys anything,
    // and re-rendering is how a file that changed while it was away finally
    // reaches the prompt.
    //
    // The clock is the end of the model's last message, not when the text was
    // frozen: a session that keeps talking keeps its cache alive however long it
    // has been running, and must keep the same prefix the whole time. `at` counts
    // as activity too, or a session that just rebuilt would rebuild again on the
    // second assembly of the same turn.
    if (frozen !== undefined && !isStale({ updatedAt: this.lastActiveAt(id, frozen) }, this.config.snapshotTtlMinutes)) {
      return frozen.text
    }
    if (frozen !== undefined) this.dropFrozen(agent)

    const { text, logKeys } = this.renderInjectionText(agent)
    const at = new Date().toISOString()
    this.frozen.set(id, { text, logKeys, at })
    // The rebuild starts a new cache epoch, so the retention window restarts here
    // too. Leaving the old timestamp would let the sweeper delete the snapshot we
    // just wrote, and the session would rebuild on every restart.
    this.touched.set(id, at)
    // The session now sees everything on disk, so its delivery baseline moves up
    // with it; otherwise the next notice would repeat changes already in view.
    const current = this.currentSnapshot(agent, logKeys)
    this.delivered.set(id, current)
    // Fire and forget: the section hook is synchronous, and a lost write only
    // costs a re-render on the next process start.
    void this.persist(id, current)
    return text
  }

  /**
   * When a session was last active, for the retention window.
   *
   * The later of the model's last message and the moment the frozen text was
   * built. Taking the maximum matters: a session that just rebuilt its text would
   * otherwise look stale to the very next assembly of the same turn and rebuild
   * again, so a file change mid-turn would still tear the prefix.
   *
   * @param {string} id - the session identity.
   * @param {{at?: string}} frozen - the session's frozen record.
   * @returns {string|undefined} an ISO timestamp, or `undefined` when unknown.
   */
  lastActiveAt(id, frozen) {
    const touched = Date.parse(this.touched.get(id) ?? '')
    const built = Date.parse(frozen?.at ?? '')
    if (Number.isFinite(touched) && Number.isFinite(built)) return touched >= built ? this.touched.get(id) : frozen.at
    if (Number.isFinite(touched)) return this.touched.get(id)
    return frozen?.at
  }

  /**
   * Discard one session's frozen text and tool description.
   *
   * Only the in-memory copies are dropped. The next persist rewrites the file
   * with the new frozen parts, and deleting it here would race that write.
   *
   * @param {object} agent - the live agent.
   * @returns {void}
   */
  dropFrozen(agent) {
    const id = String(agent.id)
    this.frozen.delete(id)
    this.toolText.delete(id)
  }

  /**
   * Render the memory block for one agent, from disk, right now.
   *
   * Also reports which log files went in, so the frozen record can name them:
   * the delivery baseline has to include those days, or entries appended to them
   * by another session would never be reported — the frozen text will not show
   * them, so a notice is the only way the model learns about them.
   *
   * @param {object} agent - the live agent.
   * @returns {{text: string, logKeys: string[]}} the block and the log keys it used.
   */
  renderInjectionText(agent) {
    // Logs are handed to the renderer even though it may drop them: the decision
    // about what a day's entries contribute to the prompt belongs in one place,
    // not in a filter here.
    const plan = this.logInjection
    const logs = this.injectedLogs(agent, plan)
    const detail = new Map(logs.map(({ document, detail }) => [document, detail]))
    const text = renderInjection([...this.injectedDocuments(agent), ...logs.map(({ document }) => document)], {
      enabled: plan.enabled,
      maxEntries: plan.maxEntries,
      hasDetail: (document) => detail.get(document) === true,
    })
    return { text, logKeys: logs.map(({ key }) => key) }
  }

  /**
   * The log days the prompt should carry, oldest first.
   *
   * Each scope contributes its newest days, sorted by the date each file records
   * rather than by its name. Within a scope the newest entries keep their body
   * and the older ones are summary lines only, which is what makes a few days of
   * log affordable in the prompt at all.
   *
   * @param {object} agent - the live agent.
   * @param {ReturnType<MemoryRuntime['logInjection']>} plan - the configured plan.
   * @returns {{document: import('./model.js').MemoryDocument, detail: boolean, key: string|undefined}[]} the days to inject.
   */
  injectedLogs(agent, plan) {
    if (plan.enabled !== true) return []
    const picked = []
    for (const rule of plan.scopes) {
      let files
      try {
        files = this.logFilesOf(agent, rule.scope)
      } catch {
        // No workspace directory in this session: that scope has nothing to add.
        continue
      }
      picked.push(...selectLogInjection(files, rule).map(({ directory, document, detail }) => ({
        document,
        detail,
        key: fileKey(directory, document.fileName),
      })))
    }
    return picked
  }

  /**
   * Memory documents in prompt order.
   *
   * Only the prompt uses this: `memory_read` and the file list keep the stable
   * directory order, so `fileOrder` never reshuffles what a tool addresses.
   *
   * @param {object} agent - the live agent.
   * @returns {import('./model.js').MemoryDocument[]} documents.
   */
  injectedDocuments(agent) {
    return orderByConfig(this.documentsOf(agent), this.config?.fileOrder)
  }

  /**
   * What the prompt shows of the log, scope by scope.
   *
   * Kept as a getter so log injection is configured in exactly one place: turn
   * `injectLog` off in the config and the renderer stops seeing logs, with no
   * other change.
   *
   * @returns {{enabled: boolean, maxEntries: number,
   *   scopes: {scope: 'Global'|'Workspace', days: number, detailDays: number}[]}}
   */
  get logInjection() {
    const config = this.config
    return {
      enabled: config.injectLog === true,
      maxEntries: config.logInjectEntries,
      scopes: [
        {
          scope: 'Global',
          days: config.logInjectGlobalDays,
          detailDays: config.logInjectGlobalDetailDays,
        },
        {
          scope: 'Workspace',
          days: config.logInjectWorkspaceDays,
          detailDays: config.logInjectWorkspaceDetailDays,
        },
      ],
    }
  }

  /**
   * Current snapshot of every file one agent is shown.
   *
   * `extraKeys` widens it to files that are not memory documents at all — the
   * log days that went into the frozen prompt text. They have to be tracked, or
   * another session appending to a day the model saw would produce no notice:
   * the frozen text will never show the new entries by itself.
   *
   * @param {object} agent - the live agent.
   * @param {string[]} [extraKeys] - additional snapshot keys to include.
   * @returns {Record<string, object>} file key -> snapshot entry.
   */
  currentSnapshot(agent, extraKeys) {
    const snapshot = {}
    for (const { key, document } of this.visibleFiles(agent)) snapshot[key] = snapshotEntry(document)
    for (const key of extraKeys ?? []) {
      if (snapshot[key] !== undefined) continue
      const [directory, fileName] = key.split('\u0000')
      if (directory === undefined || fileName === undefined) continue
      const document = this.store.logFile(directory, fileName)?.document
      if (document === undefined) continue
      snapshot[key] = snapshotEntry(document)
    }
    return snapshot
  }

  /**
   * The log keys frozen into one session's prompt text.
   * @param {object} agent - the live agent.
   * @returns {string[]} snapshot keys.
   */
  frozenLogKeys(agent) {
    return this.frozen.get(String(agent.id))?.logKeys ?? []
  }

  /**
   * Record that one session is up to date with `snapshot`, in memory and on disk.
   *
   * Only the delivery baseline moves here. The frozen prompt text and tool
   * description are written once, when the session opens, and never touched
   * again: advancing them on every delivery is precisely what used to invalidate
   * the prefix cache on each file change.
   *
   * @param {object} agent - the live agent.
   * @param {Record<string, object>} snapshot - the state the session has reached.
   * @returns {Promise<void>} completion of the durable write.
   */
  async advance(agent, snapshot) {
    const id = String(agent.id)
    this.delivered.set(id, snapshot)
    this.inFlight.delete(id)
    this.pendingBaseline.delete(id)
    await this.persist(id, snapshot)
  }

  /**
   * Record that one agent has actually seen a notice.
   * @param {object} agent - the live agent.
   * @param {Record<string, object>|undefined} snapshot - the snapshot the notice reported.
   * @returns {Promise<void>} completion of the durable write.
   */
  async claim(agent, snapshot) {
    if (snapshot === undefined) {
      this.inFlight.delete(String(agent.id))
      return
    }
    await this.advance(agent, snapshot)
  }

  /**
   * Undo a notice that the agent loop dropped before the model saw it.
   * @param {object} agent - the live agent.
   * @returns {Promise<void>} completion of the durable write.
   */
  async release(agent) {
    const id = String(agent.id)
    this.inFlight.delete(id)
    // Release the schedule first: even when the notice carried no baseline to
    // roll back, the revision it covered must become checkable again, otherwise
    // a dropped notice would never be re-sent.
    this.notificationScheduler.retry(agent)
    const baseline = this.pendingBaseline.get(id)
    if (baseline === undefined) return
    await this.advance(agent, baseline)
  }

  /**
   * Forget everything held for one session.
   * @param {object} agent - the disposed agent.
   * @returns {void}
   */
  forget(agent) {
    const id = String(agent.id)
    this.notificationScheduler.forget(agent)
    this.delivered.delete(id)
    this.inFlight.delete(id)
    this.pendingBaseline.delete(id)
    this.reads.delete(id)
    this.brokenNoticed.delete(id)
    this.sessionRoots.delete(id)
    this.frozen.delete(id)
    this.toolText.delete(id)
    this.touched.delete(id)
  }

  /**
   * Wait for the in-flight snapshot writes of every session to settle.
   *
   * Snapshot persistence is fire-and-forget on the delivery path, so a caller
   * that is about to remove the state directory (tests, an uninstall) can find a
   * write recreating `sessions/` right after it deleted the tree. Nothing in the
   * plugin's own lifecycle needs this: a lost write costs one re-render.
   *
   * @returns {Promise<void>} completion of every pending write.
   */
  async flush() {
    await Promise.all([...this.writing.values()])
  }

  /**
   * Write one snapshot, downgrading a failure to a warning.
   *
   * The frozen members are read back off disk and merged in: they are written
   * once when the session opens, and a delivery that overwrote the file without
   * them would quietly restore the per-change re-render this whole scheme
   * exists to avoid.
   *
   * Writes are chained per session: two renames onto the same destination, or a
   * rename onto a file another writer is replacing, fails with EPERM on Windows.
   *
   * @param {string} id - the session identity.
   * @param {Record<string, object>} snapshot - the delivery baseline to persist.
   * @returns {Promise<void>} completion.
   */
  async persist(id, snapshot) {
    const previous = this.writing.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      try {
        const injected = this.frozen.get(id)
        const tools = this.toolText.get(id)
        const stored = await readSnapshot(this.store.stateDir, id)
        await writeSnapshot(this.store.stateDir, id, {
          files: snapshot,
          injected: injected ?? stored?.injected,
          tools: tools ?? stored?.tools,
          // Retention is measured from the model's last message, not from this
          // write: a notice pushed to an idle session must not refresh the clock.
          updatedAt: this.touched.get(id) ?? stored?.updatedAt,
        })
      } catch (error) {
        this.logger.warn(`memory: 写入会话快照失败 ${id}: ${error?.message ?? error}`)
      }
    })
    this.writing.set(id, next)
    try {
      await next
    } finally {
      // Only the last writer clears the slot; an earlier one must not drop a
      // chain a later write is already waiting on.
      if (this.writing.get(id) === next) this.writing.delete(id)
    }
  }

  /**
   * Persist the frozen parts of one session's snapshot.
   *
   * Called from the synchronous section hook, so the baseline is read from the
   * in-memory copy rather than recomputed from disk mid-assembly.
   *
   * @param {object} agent - the live agent.
   * @returns {Promise<void>} completion.
   */
  async persistFrozen(agent) {
    const id = String(agent.id)
    await this.persist(id, this.delivered.get(id) ?? {})
  }

  /**
   * The `memory_edit` description this session should see.
   *
   * The description embeds every file's format, so it changes whenever a file
   * appears — at the very front of the request, where a single character
   * invalidates the entire cached prefix. Freezing it means a session sees the
   * formats that existed when it first assembled, and learns about later files
   * the same way it learns about later content: by reading them.
   *
   * `render` is a thunk so a read failure degrades to a message rather than
   * failing the assembly it is part of.
   *
   * @param {object} agent - the live agent.
   * @param {() => string} render - renders the description from disk right now.
   * @returns {string} the text to use for this session.
   */
  sessionToolText(agent, render) {
    const id = String(agent.id)
    const frozen = this.toolText.get(id)
    if (frozen !== undefined) return frozen
    let text
    try {
      text = render()
    } catch (error) {
      return `（读取 format 失败：${error?.message ?? error}）`
    }
    this.toolText.set(id, text)
    void this.persistFrozen(agent)
    return text
  }

  /**
   * Note that the model just finished a message.
   *
   * Retention counts from here, so an idle session's snapshot expires on the
   * provider's schedule rather than on the plugin's.
   *
   * @param {object} agent - the live agent.
   * @returns {Promise<void>} completion of the timestamp write.
   */
  async touch(agent) {
    const id = String(agent.id)
    this.touched.set(id, new Date().toISOString())
    await this.persist(id, this.delivered.get(id) ?? {})
  }

  // --------------------------------------------------------- notification

  /**
   * Compare one baseline with the current state.
   *
   * Both directions matter. Walking only the files that exist right now would
   * miss the loudest change of all — a whole file that was deleted — because a
   * deleted file is exactly the one that no longer turns up in the walk.
   *
   * @param {object} agent - the live agent.
   * @param {Record<string, object>} baseline - the snapshot to compare against.
   * @param {Record<string, object>} current - the current snapshot.
   * @returns {FileUpdate[]} non-empty differences.
   */
  describeChanges(agent, baseline, current) {
    const updates = []
    const seen = new Set()
    for (const { key, directory, document } of this.visibleFiles(agent)) {
      const entry = current[key]
      if (entry === undefined) continue
      seen.add(key)
      const changes = diffEntries(baseline[key], entry)
      if (changes.length === 0) continue
      updates.push({ fileName: document.fileName, scope: scopeOfDirectory(this.store.globalDir, directory), changes })
    }
    // Keys that came from the frozen log set rather than the memory directories.
    // They are compared exactly like a memory file, because as far as the prompt
    // is concerned they are part of it.
    for (const [key, entry] of Object.entries(current)) {
      if (seen.has(key)) continue
      const changes = diffEntries(baseline[key], entry)
      if (changes.length === 0) continue
      const [directory, fileName] = key.split('\u0000')
      if (fileName === undefined || !this.sees(agent, directory)) continue
      updates.push({ fileName, scope: scopeOfDirectory(this.store.globalDir, directory), changes })
    }
    for (const [key, entry] of Object.entries(baseline)) {
      if (seen.has(key) || entry === undefined) continue
      // A log day the frozen text named but which is no longer injected is not a
      // deletion the model cares about: it was never part of the tree.
      if (current[key] !== undefined) continue
      const [directory, fileName] = key.split('\u0000')
      if (fileName === undefined || !this.sees(agent, directory)) continue
      // A file that still exists but no longer parses is announced by
      // notifyBroken instead; calling it deleted as well would say the content is
      // gone when it is really unreadable.
      if (this.store.broken(directory).some((file) => file.fileName === fileName)) continue
      updates.push({
        fileName,
        scope: scopeOfDirectory(this.store.globalDir, directory),
        changes: [{ path: [], kind: 'deleted' }],
      })
    }
    return updates
  }

  /**
   * Report whatever one agent has not been told about yet.
   * @param {object} agent - the target agent.
   * @returns {boolean} whether the notice was queued (or no notice was needed).
   */
  notifyAgent(agent) {
    const id = String(agent.id)
    const baseline = this.inFlight.get(id) ?? this.delivered.get(id) ?? {}
    // The frozen prompt text will never re-render, so the log days it was built
    // from are part of what the session "has seen": without them here, another
    // session appending to one of those days would produce no notice at all.
    const current = this.currentSnapshot(agent, this.frozenLogKeys(agent))
    const updates = this.describeChanges(agent, baseline, current)
    if (updates.length === 0) return true
    const text = renderNotice(updates)
    if (text === undefined) return true
    return this.send(agent, text, current)
  }

  /**
   * Queue one notice on an agent without waking it.
   *
   * The snapshot advances as soon as the notice is queued, so a session that has
   * already been told about a change is never told again - even if it stays idle
   * for a long time and the same files keep changing around it. {@link release}
   * restores the previous baseline if the loop drops the message unread.
   *
   * @param {object} agent - the target agent.
   * @param {string} text - the rendered notice body.
   * @param {Record<string, object>|undefined} snapshot - the snapshot the notice reports.
   * @returns {boolean} whether the notice was accepted by the inbox.
   */
  send(agent, text, snapshot) {
    const id = String(agent.id)
    if (!this.injectNotice(agent, text, snapshot)) return false
    if (snapshot === undefined) return true
    const previous = this.delivered.get(id)
    if (previous !== undefined) this.pendingBaseline.set(id, previous)
    this.inFlight.set(id, snapshot)
    this.delivered.set(id, snapshot)
    void this.persist(id, snapshot)
    return true
  }

  /**
   * Hand one notice to an agent, downgrading a delivery failure to a warning.
   *
   * An agent that just went away refuses `inject`, and that must never surface
   * as an error in the event that triggered the notice.
   *
   * @param {object} agent - the target agent.
   * @param {string} text - the rendered notice body.
   * @param {Record<string, object>|undefined} snapshot - the version the notice reports.
   * @returns {boolean} whether the agent accepted it.
   */
  injectNotice(agent, text, snapshot) {
    try {
      agent.inject(noticeMessage(text, snapshot))
      return true
    } catch (error) {
      this.logger.warn(`memory: 无法向会话 ${String(agent.id)} 投递记忆通知: ${error?.message ?? error}`)
      return false
    }
  }

  /** Queue one changed directory for activity-aware checks. */
  broadcast(directory, except) {
    this.notificationScheduler.markChanged(directory, except)
  }

  /**
   * React to an external file change: refresh everyone who can see it.
   * @param {string} directory - the changed directory.
   * @returns {Promise<void>} completion.
   */
  async handleExternalChange(directory) {
    this.notificationScheduler.markChanged(directory)
  }

  /**
   * Announce files that failed to parse, once per distinct failure.
   * @param {object} agent - the target agent.
   * @returns {Promise<boolean>} whether the warning was accepted or unnecessary.
   */
  async notifyBroken(agent) {
    const broken = this.dirsOf(agent).flatMap((directory) => this.store.broken(directory))
    if (broken.length === 0) return true
    const signature = hashText(broken.map((file) => `${file.path}\u0000${file.error}`).sort().join('\n'))
    const id = String(agent.id)
    if (this.brokenNoticed.get(id) === signature) return true
    const text = renderBrokenNotice(broken)
    if (text === undefined) return true
    if (!this.injectNotice(agent, text, undefined)) return false
    this.brokenNoticed.set(id, signature)
    return true
  }

  // ------------------------------------------------------------ data access

  /**
   * Locate one file and the document the agent should edit.
   * @param {object} agent - the live agent.
   * @param {string} fileName - `meta_data.file_name`.
   * @param {string|undefined} scope - the scope to search; omit for every visible one.
   * @returns {{directory: string, document: import('./model.js').MemoryDocument}} the located file.
   * @throws {DocumentError} when the agent cannot see that file.
   */
  requireFile(agent, fileName, scope) {
    for (const directory of this.directoriesFor(agent, scope)) {
      const file = this.store.locateIn(directory, fileName)
      // A log carries a date as its name and is reached through the date query,
      // never by name; letting it through here would make `manage` and `edit`
      // treat a day's entries as a notebook.
      if (file === undefined || file.document?.kind === 'log') continue
      if (file.document === undefined) {
        throw new DocumentError(`记忆文件 ${fileName} 解析失败，无法读写: ${file.error}`)
      }
      return { directory, document: file.document }
    }
    throw new DocumentError(`找不到记忆文件 "${fileName}"。先调用 memory_read（省略 file_name）查看现有的文件清单`)
  }

  /**
   * Read one file, one heading subtree, or one slice of the log.
   *
   * A date in `file_name` switches to the log: `2026-10-27` is one day and
   * `2026-10-26..2026-10-27` is a range. `heading_path` then narrows by time.
   *
   * @param {object} agent - the live agent.
   * @param {{scope?: string, fileName?: string, headingPath?: string[]}} request - the read request.
   * @returns {Promise<string>} the rendered text.
   */
  async read(agent, request) {
    const dates = parseLogDateQuery(request.fileName)
    if (dates !== undefined) return this.readLog(agent, dates, request.headingPath, request.scope)
    if (request.fileName === undefined) {
      return renderFileList(this.documentsOf(agent, request.scope), this.brokenFilesOf(agent, request.scope))
    }
    const { directory, document } = this.requireFile(agent, request.fileName, request.scope)
    const path = request.headingPath ?? []
    if (path.length > 0 && findNode(document, path) === undefined) {
      throw new DocumentError(`找不到标题 ${JSON.stringify(path)}`, path.join(' > '))
    }
    this.rememberRead(agent, fileKey(directory, document.fileName), hashText(document.source))
    return renderRead(document, path.length === 0 ? undefined : path)
  }

  /**
   * Read a date range of logs, optionally narrowed to a time range.
   * @param {object} agent - the live agent.
   * @param {{from: string, to: string}} dates - the date range, inclusive.
   * @param {string[]|undefined} headingPath - a time range or an exact entry path.
   * @param {string|undefined} scope - the scope to read; omit for every visible one.
   * @returns {string} the rendered text.
   * @throws {DocumentError} when an exact entry path does not exist.
   */
  readLog(agent, dates, headingPath, scope) {
    const days = this.logFilesOf(agent, scope).filter(
      ({ document }) =>
        logDateValue(document.fileName) >= logDateValue(dates.from) &&
        logDateValue(document.fileName) <= logDateValue(dates.to),
    )
    if (days.length === 0) {
      throw new DocumentError(`没有 ${describeDates(dates)} 的日志文件。日志会在当天的零点自动创建`)
    }

    const times = parseLogTimeQuery(headingPath)
    if (times === undefined && headingPath !== undefined && headingPath.length > 0) {
      const day = days.find(({ document }) => findNode(document, headingPath) !== undefined)
      if (day === undefined) throw new DocumentError(`找不到日志标题 ${JSON.stringify(headingPath)}`)
      this.rememberRead(agent, fileKey(day.directory, day.document.fileName), hashText(day.document.source))
      return renderRead(day.document, headingPath)
    }

    const rendered = []
    for (const { directory, document } of days) {
      // Remember every day that was queried, including an empty one: reading an
      // empty log is how a session gets permission to write its first entry.
      this.rememberRead(agent, fileKey(directory, document.fileName), hashText(document.source))
      const filtered = filterLog(document, times)
      if (logEntries(filtered).length === 0) continue
      rendered.push(filtered)
    }
    if (rendered.length > 0) return renderLogRange(rendered)
    return days.some(({ document }) => logEntries(document).length > 0)
      ? `（${describeDates(dates)} 没有落在 ${describeRange(times)} 的日志）`
      : `（${describeDates(dates)} 还没有写日志）`
  }

  /**
   * Remember which version of one file a session has read.
   * @param {object} agent - the live agent.
   * @param {string} key - the file key.
   * @param {string} hash - the content hash the model was shown.
   * @returns {void}
   */
  rememberRead(agent, key, hash) {
    const id = String(agent.id)
    const reads = this.reads.get(id) ?? new Map()
    reads.set(key, hash)
    this.reads.set(id, reads)
  }

  /**
   * Apply one edit and persist it.
   *
   * A date in `file_name` selects that day's log instead of a memory file. Both
   * kinds share this entry point, so the read guard, the version check, and the
   * post-write notification cannot drift apart between them.
   *
   * @param {object} agent - the live agent.
   * @param {object} request - the edit request.
   * @returns {Promise<{outcome: import('./edit.js').EditOutcome, scope: string}>} what the edit did, and where.
   * @throws {DocumentError} when the file was not read, changed underneath, or the log day is missing.
   */
  async edit(agent, request) {
    const target = isLogDate(request.fileName)
      ? await this.logTarget(agent, request.fileName, request.scope)
      : this.requireFile(agent, request.fileName, request.scope)
    return this.writeEdit(agent, target, request)
  }

  /**
   * Resolve the log of one date in the directory this agent appends to.
   *
   * A log is created for the current day only, so an edit can never invent a
   * day: writing yesterday's summary at 00:05 should fail loudly rather than
   * silently create a file nobody will look at.
   *
   * @param {object} agent - the live agent.
   * @param {string} date - `YYYY-MM-DD`.
   * @param {string|undefined} scope - the scope to write; omit for the default directory.
   * @returns {Promise<{directory: string, document: import('./model.js').MemoryDocument}>} the log.
   * @throws {DocumentError} when that day's log does not exist.
   */
  async logTarget(agent, date, scope) {
    const directory = this.logDirectoryOf(agent, scope)
    const directoryScope = scopeOfDirectory(this.store.globalDir, directory)
    await this.store.ensureDirectory(directory, directoryScope)
    let file = this.store.logFile(directory, date)
    if (file?.document === undefined && date === formatLogDate()) {
      // 当天这一份被外部删掉了（清空目录、手工删除）：补建一份空的，
      // 否则到零点之前都写不进日志。
      await this.createLog(directory, date, directoryScope)
      file = this.store.logFile(directory, date)
    }
    if (file?.document === undefined) {
      throw new DocumentError(`没有 ${date} 的日志文件。日志只有当天这一份，会在零点自动切换`)
    }
    return { directory, document: file.document }
  }

  /**
   * Apply one edit to one document and persist it.
   * @param {object} agent - the live agent.
   * @param {{directory: string, document: import('./model.js').MemoryDocument}} target - the file to edit.
   * @param {object} request - the edit request.
   * @returns {Promise<{outcome: import('./edit.js').EditOutcome, scope: string}>} what the edit did, and where.
   * @throws {DocumentError} when the file was not read, or the written file cannot be re-read.
   */
  async writeEdit(agent, target, request) {
    const { directory, document } = target
    const known = this.requireRead(agent, directory, document)
    const working = cloneDocument(document)
    const options = document.kind === 'log' ? { summaryMaxChars: this.config.logSummaryMaxChars } : {}
    const outcome = applyEdit(working, request, localTimestamp(), options)
    const loaded = await this.store.write(directory, document.scope, working, { expectedHash: known })
    if (loaded.document === undefined) {
      throw new DocumentError(`写入后无法重新解析该文件: ${loaded.error ?? '未知错误'}`)
    }
    this.rememberRead(agent, fileKey(directory, document.fileName), loaded.hash)
    await this.afterWrite(agent, directory)
    return { outcome, scope: document.scope }
  }

  /**
   * The hash a session was last shown for one file.
   * @param {object} agent - the live agent.
   * @param {string} directory - the file's memory directory.
   * @param {import('./model.js').MemoryDocument} document - the file.
   * @returns {string} the hash the edit guard must compare against.
   * @throws {DocumentError} when the session never read the file, or it changed since.
   */
  requireRead(agent, directory, document) {
    const known = this.reads.get(String(agent.id))?.get(fileKey(directory, document.fileName))
    if (known === undefined) {
      throw new DocumentError('调用 memory_edit 之前必须先用 memory_read 读取要修改的位置')
    }
    if (known !== hashText(document.source)) {
      throw new DocumentError('这个文件在你读取之后被改过了，请重新 memory_read 再修改')
    }
    return known
  }

  async afterWrite(agent, directory) {
    await this.advance(agent, this.currentSnapshot(agent))
    this.notificationScheduler.markChanged(directory, agent)
  }

  /**
   * Create a memory file, update one file's metadata, rename it, or delete it.
   *
   * `new_file_name` carries three meanings, because the tool surface only has
   * this one parameter: omitted means "metadata only", a different name means
   * "rename", and an empty string means "delete the whole file". Deleting by
   * clearing the name keeps a single mental model - the file is named by this
   * parameter - instead of adding a second tool for one destructive action.
   *
   * @param {object} agent - the live agent.
   * @param {object} request - the manage request.
   * @returns {Promise<{fileName: string, scope: string, renamedFrom?: string, deleted?: boolean}>} what changed.
   * @throws {DocumentError} when the scope, name, or file is not usable.
   */
  async manage(agent, request) {
    const directory = await this.managedDirectory(agent, request.scope)
    const requested = typeof request.newFileName === 'string' ? request.newFileName.trim() : undefined

    if (request.fileName === undefined) {
      if (requested === undefined || requested === '') throw new DocumentError('新建记忆文件时 file_name 不能为空')
      if (isLogDate(requested)) {
        throw new DocumentError(`${requested} 是日期形式，日志文件的名字由插件自己管理，请换一个文件名`)
      }
      const document = createDocument({
        fileName: requested,
        desc: request.desc,
        format: request.format,
        scope: request.scope,
      })
      await this.store.create(directory, request.scope, document)
      return { fileName: document.fileName, scope: document.scope }
    }

    // A log's name is a date and its metadata belongs to the plugin, so it is
    // rejected before anything is looked up: `requireFile` skips log documents,
    // which would otherwise surface as a confusing "找不到记忆文件".
    if (isLogDate(request.fileName)) {
      throw new DocumentError('日志文件的元数据由插件管理，不能用 memory_manage 修改')
    }
    const found = this.requireFile(agent, request.fileName, request.scope)
    const document = cloneDocument(found.document)
    const known = this.store.requireFile(found.directory, document.fileName)

    if (requested === '') {
      await rm(join(found.directory, known.relative), { force: true })
      this.store.forget(found.directory, known.relative)
      await this.afterWrite(agent, found.directory)
      return { fileName: document.fileName, scope: document.scope, deleted: true }
    }
    if (requested !== undefined && requested !== document.fileName) {
      assertUsableFileName(requested)
      if (isLogDate(requested)) {
        throw new DocumentError(`${requested} 是日期形式，日志文件的名字由插件自己管理，请换一个文件名`)
      }
      // The new name has to be free wherever this session would look it up: two
      // files with one `file_name` would make `requireFile` pick one at random.
      // `locateIn` counts broken files too (they carry a fallback name), so a
      // hand-broken YAML file is spared instead of being silently overwritten.
      const occupied =
        this.store.locateIn(found.directory, requested) ?? this.store.locateIn(this.store.globalDir, requested)
      if (occupied !== undefined) {
        throw new DocumentError(`已经有一个叫 ${requested} 的记忆文件了`)
      }
      document.fileName = requested
    }
    if (request.desc !== undefined) document.desc = normalizeMetaLine(request.desc)
    if (request.format !== undefined) {
      document.format = String(request.format).trim() === '' ? '' : String(request.format)
    }
    if (request.injectIgnore !== undefined) {
      document.injectIgnore = readInjectIgnore(request.injectIgnore, document.fileName)
    }
    // The store's cached copy is the version on disk, so its hash is what the
    // write guard has to compare against. A rename writes a new path, so the
    // guard is pointed at the old one: the new path does not exist yet, and
    // hashing it would return undefined and skip the lock.
    await this.store.write(found.directory, document.scope, document, {
      expectedHash: known.hash,
      baseRelative: known.relative,
    })
    if (document.fileName !== found.document.fileName) {
      const oldPath = join(found.directory, known.relative)
      const newPath = join(found.directory, this.store.cache.relativeFor(found.directory, document.fileName))
      try {
        // A case-only rename (`abc` → `ABC`) is one file on a case-insensitive
        // filesystem: the write already replaced it, so deleting the old path
        // would delete the new file too.
        if (!(await sameFileOnDisk(oldPath, newPath))) await rm(oldPath, { force: true })
      } catch (error) {
        throw new DocumentError(
          `已改名为「${document.fileName}」，但旧文件 ${known.relative} 没能删除（${error?.message ?? error}）。请手动删掉它，否则会同时存在两份。`,
        )
      }
      this.store.forget(found.directory, known.relative)
    }
    await this.afterWrite(agent, found.directory)
    return {
      fileName: document.fileName,
      scope: document.scope,
      renamedFrom: document.fileName === found.document.fileName ? undefined : found.document.fileName,
    }
  }

  /**
   * Resolve (and load) the directory one manage request targets.
   * @param {object} agent - the live agent.
   * @param {unknown} scope - the requested scope.
   * @returns {Promise<string>} the absolute directory.
   * @throws {DocumentError} when the scope is unknown or unusable in this session.
   */
  async managedDirectory(agent, scope) {
    if (scope !== 'Global' && scope !== 'Workspace') throw new DocumentError('scope 必须是 Global 或 Workspace')
    const root = this.agentRoots.get(agent)
    if (scope === 'Workspace' && root === undefined) {
      throw new DocumentError('当前会话没有工作目录，无法创建 Workspace 记忆')
    }
    const directory = this.store.directoryFor(scope, root ?? '')
    await this.store.ensureDirectory(directory, scope)
    return directory
  }
}

/**
 * Copy a log with only the entries inside a time range kept.
 * @param {import('./model.js').MemoryDocument} document - the log to filter.
 * @param {{from: string, to: string}|undefined} times - the range; omit to keep everything.
 * @returns {import('./model.js').MemoryDocument} the filtered copy.
 */
function filterLog(document, times) {
  const filtered = cloneDocument(document)
  if (times === undefined) return filtered
  for (const day of filtered.roots.values()) {
    const entries = new Map()
    for (const [title, node] of day.children) {
      if (inTimeRange(title, times)) entries.set(title, node)
    }
    day.children = entries
  }
  return filtered
}

/**
 * Spell a date range for a tool result, collapsing a single day.
 * @param {{from: string, to: string}} dates - the range.
 * @returns {string} a human-readable description.
 */
function describeDates(dates) {
  return dates.from === dates.to ? dates.to : `${dates.from} 到 ${dates.to}`
}

/**
 * Spell a time range for a tool result.
 * @param {{from: string, to: string}|undefined} times - the range.
 * @returns {string} a human-readable description.
 */
function describeRange(times) {
  return times === undefined ? '任何时间' : `${times.from} 到 ${times.to}`
}

/**
 * Build one memory notice message.
 * @param {string} text - the rendered body.
 * @param {Record<string, object>|undefined} snapshot - the version this notice reports.
 * @returns {object} a user-role message carrying its own snapshot.
 */
function noticeMessage(text, snapshot) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_SOURCE_KIND, snapshot },
  }
}
