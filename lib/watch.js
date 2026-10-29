/**
 * Keeping the cache in step with the disk.
 *
 * Two folders per memory directory are watched: the directory itself and its
 * `log` subfolder. Watch events arrive in bursts (a temp file plus a rename, an
 * editor writing twice), so each path is debounced before the file is re-read.
 *
 * A reload only notifies listeners when the content hash actually changed —
 * touching a file must not wake every session with a "memory changed" notice.
 *
 * @module dsh-memory/watch
 */

import { existsSync, watch } from 'node:fs'
import { extname, join } from 'node:path'

import { FILE_EXTENSION } from './cache.js'
import { LOG_DIR_NAME } from './log.js'

/** Debounce for filesystem watch bursts. */
const WATCH_DEBOUNCE_MS = 200

export class MemoryWatcher {
  /**
   * @param {object} options - watcher configuration.
   * @param {import('./cache.js').MemoryCache} options.cache - the cache to reload into.
   * @param {(message: string) => void} [options.warn] - diagnostic sink.
   */
  constructor(options) {
    this.cache = options.cache
    this.warn = options.warn ?? (() => {})
    /** @type {Map<string, import('node:fs').FSWatcher>} folder → watcher. */
    this.watchers = new Map()
    /** @type {Set<(changed: {directory: string, fileName: string}) => void>} */
    this.listeners = new Set()
    /** @type {Map<string, NodeJS.Timeout>} pending debounce timers. */
    this.debounces = new Map()
    this.disposed = false
  }

  /**
   * Subscribe to external filesystem changes.
   * @param {(changed: {directory: string, fileName: string}) => void} listener - called after a reload.
   * @returns {() => void} the disposer.
   */
  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Watch every folder one memory directory owns.
   *
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @returns {void}
   */
  watchDirectory(directory, scope) {
    this.watchPath(directory, scope, '')
    this.watchPath(join(directory, LOG_DIR_NAME), scope, `${LOG_DIR_NAME}/`, directory)
  }

  /**
   * Watch one folder for external edits.
   * @param {string} folder - the folder to watch.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @param {string} prefix - path prefix for the notifying relative key.
   * @param {string} [directory] - the memory directory the folder belongs to; defaults to the folder itself.
   * @returns {void}
   */
  watchPath(folder, scope, prefix, directory = folder) {
    if (this.disposed || this.watchers.has(folder)) return
    let watcher
    try {
      watcher = watch(folder, { persistent: false }, (_event, fileName) => {
        if (fileName === null) return
        const relative = `${prefix}${String(fileName)}`
        if (extname(relative) !== FILE_EXTENSION) return
        this.scheduleReload(directory, scope, relative)
      })
    } catch (error) {
      this.warn(`监听记忆目录失败 ${folder}: ${error.message}`)
      return
    }
    watcher.on('error', (error) => this.warn(`记忆目录监听出错 ${folder}: ${error.message}`))
    this.watchers.set(folder, watcher)
  }

  /**
   * Debounce a reload triggered by a watch event.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @param {string} relative - the file that changed, relative to the memory directory.
   * @returns {void}
   */
  scheduleReload(directory, scope, relative) {
    const key = join(directory, relative)
    clearTimeout(this.debounces.get(key))
    const timer = setTimeout(() => {
      this.debounces.delete(key)
      void this.reloadFile(directory, scope, relative)
    }, WATCH_DEBOUNCE_MS)
    this.debounces.set(key, timer)
  }

  /**
   * Reload one file after an external change and notify listeners.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @param {string} relative - the file that changed, relative to the memory directory.
   * @returns {Promise<void>} completion of the reload and notification.
   */
  async reloadFile(directory, scope, relative) {
    const files = this.cache.files(directory)
    if (files === undefined) return
    const path = join(directory, relative)
    if (!existsSync(path)) {
      if (!files.delete(relative)) return
      this.emit(directory, relative)
      return
    }
    const loaded = await this.cache.loadFile(path, scope, relative)
    const previous = files.get(relative)
    this.cache.put(directory, relative, loaded)
    if (previous?.hash === loaded.hash) return
    this.emit(directory, relative)
  }

  /**
   * Notify subscribers about one changed file.
   * @param {string} directory - absolute memory directory.
   * @param {string} fileName - the file that changed, relative to the memory directory.
   * @returns {void}
   */
  emit(directory, fileName) {
    for (const listener of this.listeners) {
      try {
        listener({ directory, fileName })
      } catch (error) {
        this.warn(`记忆变更回调失败: ${error.message}`)
      }
    }
  }

  /**
   * Stop watching and drop pending debounces.
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    for (const timer of this.debounces.values()) clearTimeout(timer)
    this.debounces.clear()
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close()
      } catch {
        // A closed watcher is already settled.
      }
    }
    this.watchers.clear()
    this.listeners.clear()
  }
}
