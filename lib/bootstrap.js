/**
 * Bootstrap: the first-session checklist that ships with the plugin.
 *
 * A fresh installation has memory files full of `（暂无）`. `BOOTSTRAP.md` is the
 * list of questions that fills them in, and it lives next to the memory it
 * talks about:
 *
 * ```
 * <dataDir>/BOOTSTRAP.md        the checklist itself, plain Markdown
 * ```
 *
 * It is injected at the very front of the prompt while it exists, and it
 * disappears on its own once the checklist is done: the frontmatter says
 * `status: pending`, the model changes it to `status: complete` when the last
 * item is written back, and the next reload deletes the file. Nothing else
 * triggers the deletion — the file *is* the state.
 *
 * Unlike memory and presets this text is read live on every assembly. It is one
 * static file that every session sees the same way, so it does not move the
 * provider's prefix boundary while it is pending; when it goes away the prefix
 * changes once, which is exactly the moment the first-session prompt is no
 * longer needed.
 *
 * @module dsh-memory/bootstrap
 */

import { readFileSync, watch } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** File name of the checklist, directly under the plugin data directory. */
export const BOOTSTRAP_FILE_NAME = 'BOOTSTRAP.md'

/** The `status` value that means "done, delete me". */
export const BOOTSTRAP_COMPLETE = 'complete'

/** Debounce for filesystem watch bursts, same order as the other watchers. */
const WATCH_DEBOUNCE_MS = 200

/** A leading YAML frontmatter block: `---`, lines, `---`. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Read the `status` field out of a leading frontmatter block.
 *
 * Anything unreadable — no frontmatter, no such key, an empty value — is
 * `pending`, because the safe reading of "not clearly finished" is "keep
 * showing the checklist". A checklist that stays one turn too long costs a few
 * tokens; one that vanishes early loses the whole point of the file.
 *
 * @param {string} source - the whole file.
 * @returns {string} the status value, `pending` when absent.
 */
export function parseBootstrapStatus(source) {
  const match = FRONTMATTER.exec(typeof source === 'string' ? source : '')
  if (match === null) return 'pending'
  const line = match[1].split(/\r?\n/).find((entry) => /^status\s*:/.test(entry))
  if (line === undefined) return 'pending'
  const value = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
  return value === '' ? 'pending' : value
}

/**
 * The prompt text of a checklist file: frontmatter stripped, edges trimmed.
 *
 * The frontmatter is state for the plugin, not something the model needs to
 * read back; the body is the part that asks questions.
 *
 * @param {string} source - the whole file.
 * @returns {string} the body.
 */
export function bootstrapBody(source) {
  const text = typeof source === 'string' ? source : ''
  return text.replace(FRONTMATTER, '').trim()
}

/**
 * The checklist file, kept in memory and reloaded as it changes.
 */
export class BootstrapStore {
  /**
   * @param {object} options - store configuration.
   * @param {string} options.dir - the plugin data directory.
   * @param {(message: string) => void} [options.warn] - diagnostic sink.
   */
  constructor(options) {
    this.dir = options.dir
    this.warn = options.warn ?? (() => {})
    /** @type {string} the text to inject, or `''` when there is no checklist. */
    this.text = ''
    /** @type {import('node:fs').FSWatcher|undefined} */
    this.watcher = undefined
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined
    /** Serialises reloads so a slow read cannot overwrite a newer one. */
    this.queue = Promise.resolve()
    this.disposed = false
  }

  /** @returns {string} absolute path of the checklist file. */
  get path() {
    return join(this.dir, BOOTSTRAP_FILE_NAME)
  }

  /**
   * Load the checklist synchronously, then watch it.
   *
   * The first read is synchronous on purpose: the plugin loads before the first
   * assembly, and an async read would let the very first (and most important)
   * prompt go out without the checklist.
   *
   * @returns {Promise<void>} completion of the directory and watcher setup.
   */
  async start() {
    try {
      await mkdir(this.dir, { recursive: true })
    } catch (error) {
      this.warn(`memory: 创建数据目录失败 ${this.dir}: ${error.message}`)
    }
    this.loadSync()
    this.open()
  }

  /**
   * Read the checklist once, synchronously.
   * @returns {void}
   */
  loadSync() {
    let source
    try {
      source = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`memory: 读取 BOOTSTRAP 失败 ${this.path}: ${error.message}`)
      this.text = ''
      return
    }
    if (this.apply(source)) void this.removeFinished()
  }

  /**
   * Re-read the checklist, and delete it when it says it is done.
   * @returns {Promise<void>} completion.
   */
  async reload() {
    if (this.disposed) return
    this.queue = this.queue.then(async () => {
      let source
      try {
        source = await readFile(this.path, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') this.warn(`memory: 读取 BOOTSTRAP 失败 ${this.path}: ${error.message}`)
        this.text = ''
        return
      }
      if (this.apply(source)) await this.removeFinished()
    }).catch((error) => {
      this.warn(`memory: 刷新 BOOTSTRAP 失败 ${this.path}: ${error?.message ?? error}`)
    })
    await this.queue
  }

  /**
   * Take one file read as the current state.
   *
   * A completed checklist is removed by the plugin, not by the model: the file
   * marks itself done, and the store acts on it. The text is dropped the moment
   * the status reads complete, so a file that cannot be deleted still leaves
   * the prompt — a failed removal is only a warning.
   *
   * @param {string} source - the whole file.
   * @returns {boolean} whether the file says it is done and should be removed.
   */
  apply(source) {
    if (parseBootstrapStatus(source).toLowerCase() === BOOTSTRAP_COMPLETE) {
      this.text = ''
      return true
    }
    this.text = bootstrapBody(source)
    return false
  }

  /**
   * Delete a finished checklist.
   * @returns {Promise<void>} completion.
   */
  async removeFinished() {
    try {
      await rm(this.path, { force: true })
    } catch (error) {
      this.warn(`memory: 删除已完成的 BOOTSTRAP 失败 ${this.path}: ${error?.message ?? error}`)
    }
  }

  /**
   * Debounce a reload triggered by a watch event.
   * @returns {void}
   */
  scheduleReload() {
    if (this.disposed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.reload()
    }, WATCH_DEBOUNCE_MS)
  }

  /**
   * Watch the data directory for the checklist appearing, changing, or leaving.
   *
   * Watching the directory rather than the file: a deleted file cannot be
   * watched, and the checklist is expected to be deleted exactly once.
   *
   * @returns {void}
   */
  open() {
    if (this.disposed || this.watcher !== undefined) return
    try {
      this.watcher = watch(this.dir, { persistent: false }, (_event, fileName) => {
        // Only the checklist matters here; the data directory also holds the
        // memory files, the snapshots and the presets, and every one of those
        // writes is another event.
        if (typeof fileName === 'string' && fileName !== BOOTSTRAP_FILE_NAME) return
        this.scheduleReload()
      })
    } catch (error) {
      this.warn(`memory: 监听 BOOTSTRAP 失败 ${this.dir}: ${error.message}`)
      return
    }
    this.watcher.on('error', (error) => this.warn(`memory: BOOTSTRAP 监听出错 ${this.dir}: ${error.message}`))
  }

  /**
   * Stop watching and drop pending debounces.
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.watcher !== undefined) {
      try {
        this.watcher.close()
      } catch {
        // A closed watcher is already settled.
      }
      this.watcher = undefined
    }
  }
}
