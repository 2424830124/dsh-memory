/**
 * On-disk store: the memory directories this process serves, their cache, their
 * watchers, and their writes.
 *
 * Memory files are plugin-private data, so this module talks to `node:fs`
 * directly instead of `ctx.fs`: the composed filesystem would apply sandbox
 * policy and draft approval prompts for the model's own memory, and every write
 * would surface as a workspace observation.
 *
 * This is the facade only. The three parts live in their own modules:
 *
 * - `cache.js` indexes the files and owns every read.
 * - `watch.js` keeps that index in step with the disk.
 * - `writer.js` turns documents back into files.
 *
 * Callers keep using `MemoryStore` and never need to know the split: the
 * delegating methods below are the whole public surface.
 *
 * @module dsh-memory/store
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sameFileOnDisk } from './atomic.js'
import { MemoryCache } from './cache.js'
import { DocumentError } from './errors.js'
import { resolveLayout } from './paths.js'
import { MemoryWatcher } from './watch.js'
import { MemoryWriter } from './writer.js'

export { FILE_EXTENSION, isLogRelative, logRelative } from './cache.js'

/**
 * The set of memory directories this process serves.
 */
export class MemoryStore {
  /**
   * @param {object} options - store configuration.
   * @param {string} [options.homeDir] - Harness home override.
   * @param {string} [options.globalDir] - Global memory directory override.
   * @param {string} [options.workspaceDirName] - workspace memory directory name.
   * @param {NodeJS.ProcessEnv} [options.env] - environment to read `DSH_HOME` from.
   * @param {(message: string) => void} [options.warn] - diagnostic sink.
   */
  constructor(options = {}) {
    /** @type {import('./paths.js').MemoryLayout} */
    this.layout = resolveLayout(options)
    this.warn = options.warn ?? (() => {})

    this.cache = new MemoryCache(this.layout, this.warn)
    this.watcher = new MemoryWatcher({ cache: this.cache, warn: this.warn })
    this.writer = new MemoryWriter({ cache: this.cache, warn: this.warn })

    // The cache publishes a directory only once its files are in it; watching
    // starts at that moment so a watcher never fires into a half-built index.
    this.cache.onLoaded = (directory, scope) => this.watcher.watchDirectory(directory, scope)
    this.disposed = false
  }

  /** @returns {string} the Harness home directory. */
  get homeDir() {
    return this.layout.homeDir
  }

  /** @returns {string} the plugin's private data directory. */
  get dataDir() {
    return this.layout.dataDir
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
    return this.cache.workspaceDir(workspaceRoot)
  }

  /**
   * The directory that holds one scope.
   * @param {'Global'|'Workspace'} scope - the requested scope.
   * @param {string} workspaceRoot - the session working directory.
   * @returns {string} the absolute directory.
   */
  directoryFor(scope, workspaceRoot) {
    return this.cache.directoryFor(scope, workspaceRoot)
  }

  /**
   * Subscribe to external filesystem changes.
   * @param {(changed: {directory: string, fileName: string}) => void} listener - called after a reload.
   * @returns {() => void} the disposer.
   */
  onChange(listener) {
    return this.watcher.onChange(listener)
  }

  /**
   * Load one directory into the cache and start watching it.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @returns {Promise<void>} completion of the initial load.
   */
  async ensureDirectory(directory, scope) {
    return this.cache.ensureDirectory(directory, scope)
  }

  /**
   * Re-read every file in one directory.
   *
   * Tests call this to reload a directory without waiting for a watch event;
   * production paths go through the watcher below.
   *
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @returns {Promise<void>} completion of the reload.
   */
  async reloadDirectory(directory, scope) {
    return this.cache.reloadDirectory(directory, scope)
  }

  /**
   * Debounce a reload triggered by a watch event.
   *
   * Only the watcher calls this; tests drive it directly to exercise the
   * debounce without a real file event.
   *
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @param {string} relative - the file that changed, relative to the memory directory.
   * @returns {void}
   */
  scheduleReload(directory, scope, relative) {
    this.watcher.scheduleReload(directory, scope, relative)
  }

  /**
   * Locate a log file by the date it covers.
   * @param {string} directory - absolute memory directory.
   * @param {string} date - `YYYY-MM-DD`.
   * @returns {import('./cache.js').LoadedFile|undefined} the loaded log file.
   */
  logFile(directory, date) {
    return this.cache.logFile(directory, date)
  }

  /**
   * Locate a file inside a known directory, or explain why it is not usable.
   * @param {string} directory - absolute memory directory.
   * @param {string} fileName - `meta_data.file_name`.
   * @returns {import('./cache.js').LoadedFile} the loaded file.
   * @throws {import('./errors.js').DocumentError} when the file is absent or failed to parse.
   */
  requireFile(directory, fileName) {
    return this.cache.requireFile(directory, fileName)
  }

  /**
   * Every successfully loaded memory document for one directory.
   * @param {string} directory - absolute memory directory.
   * @returns {import('./model.js').MemoryDocument[]} documents in file-name order.
   */
  documents(directory) {
    return this.cache.documents(directory)
  }

  /**
   * Every successfully loaded log document for one directory, oldest first.
   * @param {string} directory - absolute memory directory.
   * @returns {import('./model.js').MemoryDocument[]} log documents.
   */
  logDocuments(directory) {
    return this.cache.logDocuments(directory)
  }

  /**
   * Drop one file from the cache after it was deleted from disk.
   * @param {string} directory - absolute memory directory.
   * @param {string} relative - path relative to the memory directory.
   * @returns {boolean} whether anything was dropped.
   */
  forget(directory, relative) {
    return this.cache.forget(directory, relative)
  }

  /**
   * Every file that failed to load in one directory.
   * @param {string} directory - absolute memory directory.
   * @returns {import('./cache.js').LoadedFile[]} broken files.
   */
  broken(directory) {
    return this.cache.broken(directory)
  }

  /**
   * Every directory this store currently serves.
   * @returns {string[]} absolute directories.
   */
  directories() {
    return this.cache.directories()
  }

  /**
   * Find one loaded file by its declared name inside one known directory.
   * @param {string} directory - absolute memory directory.
   * @param {string} fileName - `meta_data.file_name`.
   * @returns {import('./cache.js').LoadedFile|undefined} the loaded file.
   */
  locateIn(directory, fileName) {
    return this.cache.locateIn(directory, fileName)
  }

  /**
   * Persist one document and refresh the cache.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope the file belongs to.
   * @param {import('./document.js').MemoryDocument} document - the document to write.
   * @param {{expectedHash?: string, baseRelative?: string}} [options] - the version the edit was based on.
   * @returns {Promise<import('./cache.js').LoadedFile>} the reloaded file.
   */
  async write(directory, scope, document, options = {}) {
    return this.writer.write(directory, scope, document, options)
  }

  /**
   * Create the file for a newly declared memory file.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope the file belongs to.
   * @param {import('./document.js').MemoryDocument} document - the document to create.
   * @returns {Promise<import('./cache.js').LoadedFile>} the created file.
   */
  async create(directory, scope, document) {
    return this.writer.create(directory, scope, document)
  }

  /**
   * Disk path of one file relative to its memory directory.
   * @param {string} directory - absolute memory directory.
   * @param {string} fileName - `meta_data.file_name`.
   * @returns {string} the path relative to the memory directory.
   */
  relativeFor(directory, fileName) {
    return this.cache.relativeFor(directory, fileName)
  }

  /**
   * Finish a rename whose write already landed on the new path: drop the old path.
   *
   * A case-only rename (`abc` → `ABC`) is one file on a case-insensitive
   * filesystem: there the write replaced the old path in place, and deleting it
   * would take the new file with it. `verb` is how the caller's message starts
   * ("已改名" / "已写入"), so both entry points keep their own wording.
   *
   * @param {string} directory - absolute memory directory.
   * @param {string} previousRelative - the old file's path, relative to the directory.
   * @param {string} nextFileName - the name the file was written under.
   * @param {string} verb - the message prefix, e.g. `已改名`.
   * @returns {Promise<void>} completion once the old path is gone.
   * @throws {DocumentError} when the old file cannot be deleted.
   */
  async forgetRenamed(directory, previousRelative, nextFileName, verb) {
    const oldPath = join(directory, previousRelative)
    const newPath = join(directory, this.cache.relativeFor(directory, nextFileName))
    try {
      if (!(await sameFileOnDisk(oldPath, newPath))) await rm(oldPath, { force: true })
    } catch (error) {
      throw new DocumentError(
        `${verb}「${nextFileName}」，但旧文件 ${previousRelative} 没能删除（${error?.message ?? error}）。请手动删掉它，否则会同时存在两份。`,
      )
    }
    this.forget(directory, previousRelative)
  }

  /**
   * Stop watching and clear caches.
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    this.cache.dispose()
    this.watcher.dispose()
    this.writer.dispose()
  }
}
