/**
 * Turning documents back into files.
 *
 * Every write goes through {@link writeAtomic}, so a crash never leaves a
 * half-written memory file. Writes to the same path are serialized, because two
 * sessions may save the same memory file at once and a plain `writeFile` pair
 * would interleave.
 *
 * When the caller knows the version it edited, the hash on disk is compared
 * first: another process (a different workspace, a different window) may have
 * written the file in between, and silently overwriting it would lose that edit.
 *
 * @module dsh-memory/writer
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeAtomic } from './atomic.js'
import { serializeDocument } from './document.js'
import { DocumentError } from './errors.js'
import { hashText } from './hash.js'

/**
 * Read the current content hash of one file.
 * @param {string} path - absolute file path.
 * @returns {Promise<string|undefined>} the hash, or undefined when unreadable.
 */
async function hashOfPath(path) {
  try {
    return hashText(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

export class MemoryWriter {
  /**
   * @param {object} options - writer configuration.
   * @param {import('./cache.js').MemoryCache} options.cache - the cache to refresh after a write.
   * @param {(message: string) => void} [options.warn] - diagnostic sink.
   */
  constructor(options) {
    this.cache = options.cache
    this.warn = options.warn ?? (() => {})
    /** @type {Map<string, Promise<unknown>>} per-file write queue. */
    this.queues = new Map()
  }

  /**
   * Persist one document and refresh the cache.
   *
   * `baseRelative` names the file the edit was based on when it differs from the
   * file being written — a rename writes a new path but must still be checked
   * against the old one, otherwise the hash read comes back empty for the new
   * path and the optimistic lock silently passes.
   *
   * A missing file does not count as "no conflict": if the caller edited a file
   * that has since been deleted, recreating it would resurrect stale content, so
   * that is reported instead. The same holds for every document, logs included.
   *
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope the file belongs to.
   * @param {import('./document.js').MemoryDocument} document - the document to write.
   * @param {{expectedHash?: string, baseRelative?: string}} [options] - the version the edit was based on.
   * @returns {Promise<import('./cache.js').LoadedFile>} the reloaded file.
   */
  async write(directory, scope, document, options = {}) {
    const relative = this.cache.relativeFor(directory, document.fileName, document.kind)
    const path = join(directory, relative)
    const basePath = options.baseRelative === undefined ? path : join(directory, options.baseRelative)
    const run = async () => {
      if (options.expectedHash !== undefined) {
        const current = await hashOfPath(basePath)
        if (current === undefined) {
          throw new DocumentError('这个文件在磁盘上已经被删除了，请重新 memory_read 后再修改')
        }
        if (current !== options.expectedHash) {
          throw new DocumentError('这个文件在磁盘上被其他程序改过了，请重新 memory_read 再修改')
        }
      }
      const text = serializeDocument(document)
      await mkdir(dirname(path), { recursive: true })
      await writeAtomic(path, text)
      const loaded = await this.cache.loadFile(path, scope, relative)
      this.cache.put(directory, relative, loaded)
      return loaded
    }

    const previous = this.queues.get(path) ?? Promise.resolve()
    const next = previous.then(run, run)
    const settled = next.catch(() => {})
    this.queues.set(path, settled)
    // The queue only exists to order writes that overlap; once this write settles
    // and nothing else queued behind it, the entry is dead weight in a long-lived
    // process that touches many paths.
    void settled.then(() => {
      if (this.queues.get(path) === settled) this.queues.delete(path)
    })
    return next
  }

  /**
   * Create the file for a newly declared memory file.
   * @param {string} directory - absolute memory directory.
   * @param {'Global'|'Workspace'} scope - the scope the file belongs to.
   * @param {import('./document.js').MemoryDocument} document - the document to create.
   * @returns {Promise<import('./cache.js').LoadedFile>} the created file.
   */
  async create(directory, scope, document) {
    const path = join(directory, this.cache.relativeFor(directory, document.fileName))
    if (existsSync(path)) throw new DocumentError(`记忆文件已存在: ${document.fileName}`)
    // Only the target directory and the Global one are checked: two workspaces
    // may each own a memory file with the same name, because no session ever
    // sees both. A name reused inside the directories one session does see would
    // make `requireFile` pick one of them arbitrarily.
    const duplicate = this.cache.locateIn(directory, document.fileName) ?? this.cache.locateIn(this.cache.globalDir, document.fileName)
    if (duplicate !== undefined) throw new DocumentError(`记忆文件名已被占用: ${document.fileName}`)
    return this.write(directory, scope, document)
  }

  /**
   * Drop every queued write entry.
   * @returns {void}
   */
  dispose() {
    this.queues.clear()
  }
}
