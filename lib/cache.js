/**
 * The in-memory index of memory files, and the only place that reads them.
 *
 * The cache is keyed by directory first and by on-disk file name second, because
 * a memory file may be renamed on disk at any time and `meta_data.file_name` —
 * not the path — is the model-facing identity. Logs live in the same map under
 * their `log/...` relative key: one directory means one cache, and both kinds
 * share the file shape.
 *
 * This module owns reading and indexing only. Watching lives in `watch.js` and
 * writing in `writer.js`; both are handed this cache so there is exactly one
 * copy of the truth.
 *
 * @module dsh-memory/cache
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { parseDocument } from './document.js'
import { DocumentError } from './errors.js'
import { hashText } from './hash.js'
import { LOG_DIR_NAME } from './log.js'

/** Memory file extension. */
export const FILE_EXTENSION = '.yaml'

/**
 * Path of one log file inside its memory directory.
 * @param {string} fileName - the date the log covers.
 * @returns {string} the path relative to the memory directory.
 */
export function logRelative(fileName) {
  return `${LOG_DIR_NAME}/${fileName}${FILE_EXTENSION}`
}

/**
 * Whether a path relative to a memory directory points into the log folder.
 * @param {string} relative - the relative path.
 * @returns {boolean} whether it is a log file.
 */
export function isLogRelative(relative) {
  return relative.startsWith(`${LOG_DIR_NAME}/`)
}

/**
 * One loaded memory file, or one file that failed to load.
 * @typedef {object} LoadedFile
 * @property {string} path - absolute file path.
 * @property {string} relative - path inside the memory directory, e.g. `2026-10-27.yaml`.
 * @property {string} scope - `Global` or `Workspace`.
 * @property {string} hash - content hash of the source text.
 * @property {import('./document.js').MemoryDocument} [document] - the parsed document.
 * @property {string} [error] - why the file could not be loaded.
 * @property {string} [fileName] - the declared name, when the metadata parsed far enough.
 */

export class MemoryCache {
  /**
   * @param {import('./paths.js').MemoryLayout} layout - the resolved directory layout.
   * @param {(message: string) => void} [warn] - diagnostic sink.
   */
  constructor(layout, warn = () => {}) {
    this.layout = layout
    this.warn = warn
    /** @type {Map<string, Map<string, LoadedFile>>} directory → files, by on-disk file name. */
    this.byDirectory = new Map()
    /** @type {Map<string, Promise<void>>} directory → the load in flight for it. */
    this.loading = new Map()
    /**
     * Called once a directory has finished loading, so the store can start
     * watching it. Kept as a hook so this module never imports the watcher.
     * @type {((directory: string, scope: string) => void)|undefined}
     */
    this.onLoaded = undefined
    this.disposed = false
  }

  /** @returns {string} the Global memory directory. */
  get globalDir() {
    return this.layout.globalDir
  }

  /** @returns {string} the directory holding session snapshots. */
  get stateDir() {
    return this.layout.stateDir
  }

  /**
   * Absolute path of a workspace's memory directory.
   * @param {string} workspaceRoot - the session working directory.
   * @returns {string} the memory directory for that workspace.
   */
  workspaceDir(workspaceRoot) {
    return this.layout.workspaceDir(workspaceRoot)
  }

  /**
   * The directory that holds one scope.
   * @param {'Global'|'Workspace'} scope - the requested scope.
   * @param {string} workspaceRoot - the session working directory.
   * @returns {string} the absolute directory.
   */
  directoryFor(scope, workspaceRoot) {
    return this.layout.directoryFor(scope, workspaceRoot)
  }

  /**
   * Load one directory into the cache.
   *
   * The directory only enters the cache once its files are in it, and concurrent
   * callers share the in-flight load. Publishing an empty map first would let a
   * racing caller (`overview` while `attach` is still loading) see a loaded
   * directory that holds no files, so every memory file would appear to vanish.
   *
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @returns {Promise<void>} completion of the initial load.
   */
  async ensureDirectory(directory, scope) {
    if (this.disposed) return
    if (this.byDirectory.has(directory)) return
    let pending = this.loading.get(directory)
    if (pending === undefined) {
      pending = this.loadDirectory(directory, scope)
      this.loading.set(directory, pending)
    }
    return pending
  }

  /**
   * Read one directory into the cache and hand it to the watcher.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @returns {Promise<void>} completion of the load.
   */
  async loadDirectory(directory, scope) {
    const logDir = join(directory, LOG_DIR_NAME)
    try {
      await mkdir(logDir, { recursive: true }).catch(() => {})
      await this.reloadDirectory(directory, scope)
      this.onLoaded?.(directory, scope)
    } finally {
      this.loading.delete(directory)
    }
  }

  /**
   * Re-read every file in one directory, memory files and logs alike.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @returns {Promise<void>} completion of the reload.
   */
  async reloadDirectory(directory, scope) {
    const files = new Map()
    await Promise.all([
      this.readFolder(directory, scope, files, ''),
      this.readFolder(join(directory, LOG_DIR_NAME), scope, files, `${LOG_DIR_NAME}/`),
    ])
    if (this.disposed) return
    this.byDirectory.set(directory, files)
  }

  /**
   * Collect the YAML files directly inside one folder.
   * @param {string} folder - the folder to read.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @param {Map<string, LoadedFile>} files - the accumulator.
   * @param {string} prefix - path prefix for the relative key.
   * @returns {Promise<void>} completion.
   */
  async readFolder(folder, scope, files, prefix) {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT') this.warn(`读取记忆目录失败 ${folder}: ${error.message}`)
      return
    }
    // A memory directory holds a handful of files, but loading them one await at
    // a time made startup cost one disk round-trip per file. Read them together.
    const loaded = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && extname(entry.name) === FILE_EXTENSION)
        .map(async (entry) => {
          const relative = `${prefix}${entry.name}`
          return [relative, await this.loadFile(join(folder, entry.name), scope, relative)]
        }),
    )
    for (const [relative, file] of loaded) files.set(relative, file)
  }

  /**
   * Read and parse one file.
   * @param {string} path - absolute file path.
   * @param {'Global'|'Workspace'} scope - fallback scope.
   * @param {string} relative - path inside the memory directory.
   * @returns {Promise<LoadedFile>} the loaded file, or its failure.
   */
  async loadFile(path, scope, relative) {
    let source
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      return { path, relative, scope, hash: '', error: `读取失败: ${error.message}` }
    }
    const hash = hashText(source)
    const fallbackName = basename(path, FILE_EXTENSION)
    const kind = isLogRelative(relative) ? 'log' : 'memory'
    try {
      const document = parseDocument(source, { fileName: fallbackName, scope, kind })
      return { path, relative, scope, hash, document, fileName: document.fileName }
    } catch (error) {
      const message = error instanceof DocumentError ? error.message : String(error?.message ?? error)
      return { path, relative, scope, hash, error: message, fileName: fallbackName }
    }
  }

  /**
   * Where a document belongs on disk.
   *
   * A file keeps the name it was loaded under, so renaming `meta_data.file_name`
   * moves the file to its matching path instead of leaving a stale one behind.
   * Logs are never renamed, so their path is decided by kind alone — and once a
   * log is loaded, its cache key wins, so a log whose key and declared name
   * disagree is still found at the path it actually occupies.
   *
   * @param {string} directory - absolute memory directory.
   * @param {string} fileName - `meta_data.file_name`.
   * @param {import('./model.js').DocumentKind} [kind] - which folder the file belongs in.
   * @returns {string} the path relative to the memory directory.
   */
  relativeFor(directory, fileName, kind = 'memory') {
    if (kind !== 'log') return this.locateIn(directory, fileName)?.relative ?? fileName + FILE_EXTENSION
    const keyed = join(LOG_DIR_NAME, fileName + FILE_EXTENSION)
    const cached = this.byDirectory.get(directory)?.get(keyed)
    if (cached?.document?.kind === 'log') return keyed
    return logRelative(fileName)
  }

  /**
   * Locate a log file by the date it covers.
   *
   * The cache is keyed by on-disk path, not by `meta_data.file_name`, so a log
   * written under a different declared name still answers for its date — looking
   * only at the canonical key would report it missing and then write a second
   * file for the same day.
   *
   * @param {string} directory - absolute memory directory.
   * @param {string} date - `YYYY-MM-DD`.
   * @returns {LoadedFile|undefined} the loaded log file.
   */
  logFile(directory, date) {
    const files = this.byDirectory.get(directory)
    if (files === undefined) return undefined
    const keyed = files.get(logRelative(date))
    if (keyed?.document?.kind === 'log') return keyed
    for (const file of files.values()) {
      if (file.document?.kind === 'log' && file.fileName === date) return file
    }
    return undefined
  }

  /**
   * Locate a file inside a known directory, or explain why it is not usable.
   * @param {string} directory - absolute memory directory.
   * @param {string} fileName - `meta_data.file_name`.
   * @returns {LoadedFile} the loaded file.
   * @throws {DocumentError} when the file is absent or failed to parse.
   */
  requireFile(directory, fileName) {
    const file = this.locateIn(directory, fileName)
    if (file === undefined) {
      throw new DocumentError(`找不到记忆文件 ${fileName}，请先使用 memory_read 查看文件清单`)
    }
    if (file.document === undefined) {
      throw new DocumentError(`记忆文件 ${fileName} 解析失败，无法读写: ${file.error}`)
    }
    return file
  }

  /**
   * The file map of one loaded directory.
   * @param {string} directory - absolute memory directory.
   * @returns {Map<string, LoadedFile>|undefined} the map, or undefined when the directory is not loaded.
   */
  files(directory) {
    return this.byDirectory.get(directory)
  }

  /**
   * Record one file, creating the directory entry if needed.
   * @param {string} directory - absolute memory directory.
   * @param {string} relative - path relative to the memory directory.
   * @param {LoadedFile} file - the file to cache.
   * @returns {void}
   */
  put(directory, relative, file) {
    const files = this.byDirectory.get(directory) ?? new Map()
    files.set(relative, file)
    this.byDirectory.set(directory, files)
  }

  /**
   * Every successfully loaded memory document for one directory.
   *
   * Logs are excluded: they are not part of the prompt injection or the file
   * list, only of an explicit date query.
   *
   * @param {string} directory - absolute memory directory.
   * @returns {import('./model.js').MemoryDocument[]} documents in file-name order.
   */
  documents(directory) {
    return this.collect(directory, 'memory')
  }

  /**
   * Every successfully loaded log document for one directory, oldest first.
   * @param {string} directory - absolute memory directory.
   * @returns {import('./model.js').MemoryDocument[]} log documents.
   */
  logDocuments(directory) {
    return this.collect(directory, 'log')
  }

  /**
   * Drop one file from the cache after it was deleted from disk.
   *
   * The watcher would notice on its own, but a rename writes the new file and
   * removes the old one in the same breath, and until the watcher catches up
   * the list would show both.
   *
   * @param {string} directory - absolute memory directory.
   * @param {string} relative - path relative to the memory directory.
   * @returns {boolean} whether anything was dropped.
   */
  forget(directory, relative) {
    return this.byDirectory.get(directory)?.delete(relative) ?? false
  }

  /**
   * Every loaded document of one kind, in file-name order.
   * @param {string} directory - absolute memory directory.
   * @param {import('./model.js').DocumentKind} kind - which kind to collect.
   * @returns {import('./model.js').MemoryDocument[]} documents.
   */
  collect(directory, kind) {
    const files = this.byDirectory.get(directory)
    if (files === undefined) return []
    return [...files.values()]
      .filter((file) => file.document?.kind === kind)
      .sort((a, b) => a.document.fileName.localeCompare(b.document.fileName, 'zh'))
      .map((file) => file.document)
  }

  /**
   * Every file that failed to load in one directory.
   * @param {string} directory - absolute memory directory.
   * @returns {LoadedFile[]} broken files.
   */
  broken(directory) {
    const files = this.byDirectory.get(directory)
    if (files === undefined) return []
    return [...files.values()].filter((file) => file.error !== undefined)
  }

  /**
   * Every directory this cache currently holds.
   * @returns {string[]} absolute directories.
   */
  directories() {
    return [...this.byDirectory.keys()]
  }

  /**
   * Find one loaded file by its declared name inside one known directory.
   * @param {string} directory - absolute memory directory.
   * @param {string} fileName - `meta_data.file_name`.
   * @returns {LoadedFile|undefined} the loaded file.
   */
  locateIn(directory, fileName) {
    const files = this.byDirectory.get(directory)
    if (files === undefined) return undefined
    for (const file of files.values()) {
      if (file.fileName === fileName) return file
    }
    return undefined
  }

  /**
   * Drop every cached file.
   * @returns {void}
   */
  clear() {
    this.byDirectory.clear()
    this.loading.clear()
  }

  /**
   * Stop accepting work and clear caches.
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    this.onLoaded = undefined
    this.clear()
  }
}
