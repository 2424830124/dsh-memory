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

import { MemoryCache } from './cache.js'
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
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope its files declare.
   * @returns {Promise<void>} completion of the reload.
   */
  async reloadDirectory(directory, scope) {
    return this.cache.reloadDirectory(directory, scope)
  }

  /**
   * Debounce a reload triggered by a watch event.
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
