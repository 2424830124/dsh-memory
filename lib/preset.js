/**
 * Presets: model-facing prompt openers kept as plain Markdown files.
 *
 * A preset replaces the host's harness identity line for one session. Unlike
 * the memory block it is deliberately *not* frozen: switching a preset is an
 * explicit act, and the whole point is that the next assembly already sees it,
 * even though that moves the provider's prefix boundary.
 *
 * ```
 * <dataDir>/preset/*.md                      preset texts, file name is the preset name
 * <stateDir>/preset/<sessionId>.json         which preset one session selected
 * ```
 *
 * The directory is watched: editing the active file, or dropping a new one in,
 * takes effect without a restart. The selection is per session and survives a
 * restart; a selection whose file disappeared simply renders nothing, and the
 * native harness identity comes back until the file returns.
 *
 * Presets are not memory files: no YAML, no headings, no tools. They exist only
 * to fill the one prompt slot in front of everything else.
 *
 * @module dsh-memory/preset
 */

import { watch } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeAtomic } from './atomic.js'
import { DocumentError } from './errors.js'

/** Directory name for preset files, under the plugin data directory. */
export const PRESET_DIR_NAME = 'preset'

/** Preset files are Markdown; the extension is stripped from the preset name. */
const PRESET_EXTENSION = '.md'

/** Debounce for filesystem watch bursts, same order as the memory watcher. */
const WATCH_DEBOUNCE_MS = 200

/** Directory name for per-session preset selections, under the state directory. */
const SELECTION_DIR_NAME = 'preset'

/** Longest accepted preset name; also keeps the file name a sane length. */
const MAX_NAME_LENGTH = 64

/** Characters a preset name cannot contain: they cannot be used in a file name. */
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/**
 * Validate and normalise one preset name.
 *
 * The name is the file name, so it has to survive a round trip through disk on
 * every platform this plugin runs on. Calling it out as a {@link DocumentError}
 * lets the settings route turn it into a readable 400.
 *
 * @param {unknown} name - what the caller supplied.
 * @returns {string} the trimmed name.
 * @throws {DocumentError} when the name cannot be used as a file name.
 */
export function normalizePresetName(name) {
  const wanted = typeof name === 'string' ? name.trim() : ''
  if (wanted === '') throw new DocumentError('预设名字不能为空')
  if (wanted.length > MAX_NAME_LENGTH) {
    throw new DocumentError(`预设名字最多 ${MAX_NAME_LENGTH} 个字符`)
  }
  if (INVALID_NAME_CHARS.test(wanted)) {
    throw new DocumentError('预设名字里不能包含 \\ / : * ? " < > | 或控制字符')
  }
  if (wanted === '.' || wanted === '..' || wanted.startsWith('.')) {
    throw new DocumentError('预设名字不能以句点开头')
  }
  if (/[. ]$/.test(wanted)) {
    throw new DocumentError('预设名字不能以空格或句点结尾')
  }
  return wanted
}

/**
 * Path of one session's preset selection.
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {string} the absolute file path.
 */
function selectionPath(stateDir, sessionId) {
  return join(stateDir, SELECTION_DIR_NAME, `${sessionId}.json`)
}

/**
 * Read one session's selected preset name.
 *
 * A missing or corrupt file means "no selection": the session keeps the native
 * harness identity rather than failing assembly over a stale preference.
 *
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {Promise<string|undefined>} the selected name, or `undefined`.
 */
export async function readPresetSelection(stateDir, sessionId) {
  try {
    const parsed = JSON.parse(await readFile(selectionPath(stateDir, sessionId), 'utf8'))
    return typeof parsed?.name === 'string' && parsed.name !== '' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist one session's selected preset name.
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @param {string} name - the preset name.
 * @returns {Promise<void>} completion.
 */
export async function writePresetSelection(stateDir, sessionId, name) {
  const path = selectionPath(stateDir, sessionId)
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, JSON.stringify({ version: 1, name }, null, 2))
}

/**
 * Forget one session's selected preset.
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {Promise<void>} completion.
 */
export async function clearPresetSelection(stateDir, sessionId) {
  await rm(selectionPath(stateDir, sessionId), { force: true })
}

/**
 * The preset texts available on disk, reloaded on demand.
 */
export class PresetStore {
  /**
   * @param {object} options - store configuration.
   * @param {string} options.dir - the preset directory.
   * @param {(message: string) => void} [options.warn] - diagnostic sink.
   */
  constructor(options) {
    this.dir = options.dir
    this.warn = options.warn ?? (() => {})
    /** @type {Map<string, string>} preset name → text. */
    this.entries = new Map()
    /** @type {string[]} preset names, in file-name order. */
    this.list = []
    /** @type {import('node:fs').FSWatcher|undefined} */
    this.watcher = undefined
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined
    /** Serialises reloads so a slow read cannot overwrite a newer one. */
    this.queue = Promise.resolve()
    this.disposed = false
  }

  /**
   * Create the directory if needed, load every preset, then watch it.
   * @returns {Promise<void>} completion.
   */
  async start() {
    try {
      await mkdir(this.dir, { recursive: true })
    } catch (error) {
      this.warn(`memory: 创建预设目录失败 ${this.dir}: ${error.message}`)
    }
    await this.reload()
    this.open()
  }

  /**
   * The preset names on disk, in file-name order.
   * @returns {string[]} the names, without the `.md` extension.
   */
  names() {
    return [...this.list]
  }

  /**
   * Whether one preset file is currently loaded.
   * @param {string} name - the preset name.
   * @returns {boolean} whether it exists.
   */
  has(name) {
    return this.entries.has(name)
  }

  /**
   * The text of one preset, or `''` when it is absent.
   * @param {string} name - the preset name.
   * @returns {string} the text.
   */
  text(name) {
    if (typeof name !== 'string' || name === '') return ''
    return this.entries.get(name) ?? ''
  }

  /**
   * Re-read every preset file.
   *
   * Reloads are chained: a watch burst can schedule several, and the last one
   * to finish must be the one whose view of the disk wins.
   *
   * @returns {Promise<void>} completion.
   */
  async reload() {
    if (this.disposed) return
    this.queue = this.queue.then(() => this.readAll()).catch((error) => {
      this.warn(`memory: 读取预设目录失败 ${this.dir}: ${error.message}`)
    })
    await this.queue
  }

  /**
   * Read the directory once into the cache.
   *
   * A file that fails to read keeps its previous text: an editor writing through
   * a temp file and rename can make one read fail, and dropping the preset for
   * a single assembly would flip the prompt back to the native identity.
   *
   * @returns {Promise<void>} completion.
   */
  async readAll() {
    let fileNames
    try {
      fileNames = await readdir(this.dir)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`memory: 读取预设目录失败 ${this.dir}: ${error.message}`)
      this.entries = new Map()
      this.list = []
      return
    }
    const files = fileNames
      .filter((name) => name.length > PRESET_EXTENSION.length && name.toLowerCase().endsWith(PRESET_EXTENSION))
      .sort((left, right) => left.localeCompare(right, 'zh'))
    const entries = new Map()
    for (const file of files) {
      const name = file.slice(0, -PRESET_EXTENSION.length)
      try {
        entries.set(name, await readFile(join(this.dir, file), 'utf8'))
      } catch (error) {
        const previous = this.entries.get(name)
        if (previous !== undefined) entries.set(name, previous)
        else this.warn(`memory: 读取预设失败 ${file}: ${error.message}`)
      }
    }
    this.entries = entries
    this.list = [...entries.keys()]
  }

  /**
   * Create one empty preset.
   *
   * A name that already exists is refused rather than overwritten: the panel's
   * "new" box is easy to hit twice, and silently replacing a preset the user
   * cannot see would look like data loss.
   *
   * @param {unknown} name - the preset name.
   * @returns {Promise<string>} the name that was created.
   * @throws {DocumentError} when the name is unusable or already taken.
   */
  async create(name) {
    const wanted = normalizePresetName(name)
    if (this.list.some((existing) => existing.toLowerCase() === wanted.toLowerCase())) {
      throw new DocumentError(`已经有名为「${wanted}」的预设`)
    }
    await this.write(wanted, '')
    return wanted
  }

  /**
   * Save one preset's text.
   *
   * This is the editor's save, not "new": an absent file is written anyway so a
   * preset deleted in another window can still be saved back from an open tab.
   *
   * @param {unknown} name - the preset name.
   * @param {unknown} text - the whole file contents.
   * @returns {Promise<string>} the name that was saved.
   * @throws {DocumentError} when the name is unusable.
   */
  async save(name, text) {
    const wanted = normalizePresetName(name)
    await this.write(wanted, typeof text === 'string' ? text : '')
    return wanted
  }

  /**
   * Delete one preset.
   * @param {unknown} name - the preset name.
   * @returns {Promise<string>} the name that was removed.
   * @throws {DocumentError} when the name is unusable or there is no such preset.
   */
  async remove(name) {
    const wanted = normalizePresetName(name)
    if (!this.has(wanted)) throw new DocumentError(`没有名为「${wanted}」的预设`)
    await rm(join(this.dir, `${wanted}${PRESET_EXTENSION}`), { force: true })
    await this.reload()
    return wanted
  }

  /**
   * Write one preset file and refresh the cache.
   * @param {string} name - a validated name.
   * @param {string} text - the whole file contents.
   * @returns {Promise<void>} completion.
   */
  async write(name, text) {
    await mkdir(this.dir, { recursive: true })
    await writeAtomic(join(this.dir, `${name}${PRESET_EXTENSION}`), text)
    await this.reload()
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
   * Watch the preset directory for edits, additions, and removals.
   * @returns {void}
   */
  open() {
    if (this.disposed || this.watcher !== undefined) return
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => this.scheduleReload())
    } catch (error) {
      this.warn(`memory: 监听预设目录失败 ${this.dir}: ${error.message}`)
      return
    }
    this.watcher.on('error', (error) => this.warn(`memory: 预设目录监听出错 ${this.dir}: ${error.message}`))
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
