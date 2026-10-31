/**
 * Browser-panel memory file operations.
 *
 * The runtime still resolves which workspace belongs to a session and owns the
 * notification/snapshot pipeline. This service owns the panel's file-facing
 * operations: listing shelves, rendering file views, applying validated edits,
 * and creating/deleting files. Dependencies are explicit so panel persistence
 * does not need the rest of the session coordinator.
 *
 * @module dsh-memory/panel-service
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { DocumentError } from './errors.js'
import { isLogDate } from './log.js'
import {
  MAX_DEPTH,
  assertUsableFileName,
  assertUsableTitle,
  cloneDocument,
  createDocument,
  createNode,
  normalizeKind,
  normalizeScope,
  readInjectIgnore,
  readKeywords,
} from './model.js'
import { renderInjection, renderLog, renderRead } from './render.js'
import { localTimestamp, normalizeBody, normalizeMetaLine } from './text.js'
import { findNode, findSiblings, renameHeading } from './tree.js'
import { orderByConfig } from './file-order.js'

function scopeOf(request) {
  return normalizeScope(request.scope)
}

function kindOf(request) {
  return normalizeKind(request.kind)
}

function outline(level) {
  const nodes = []
  for (const [title, node] of level) {
    nodes.push({
      title,
      desc: node.desc ?? '',
      keyword: [...(node.keyword ?? [])],
      updateAt: node.update_at ?? '',
      children: outline(node.children ?? new Map()),
    })
  }
  return nodes
}

/**
 * @param {{store: import('./store.js').MemoryStore, config: object,
 *   resolveDirectory: (scope: string, sessionId?: string) => string|undefined,
 *   broadcast: (directory: string) => void}} options - service dependencies.
 */
export class MemoryPanelService {
  constructor({ store, config, resolveDirectory, broadcast }) {
    this.store = store
    this.config = config
    this.resolveDirectory = resolveDirectory
    this.broadcast = broadcast
  }

  /** @returns {Promise<object[]>} scope shelves, Global first. */
  async overview(sessionId) {
    const summarize = async (directory, scope) => {
      await this.store.ensureDirectory(directory, scope)
      return {
        files: orderByConfig(this.store.documents(directory), this.config?.fileOrder).map((document) => ({
          fileName: document.fileName,
          desc: document.desc ?? '',
          format: document.format ?? '',
        })),
        logs: this.store.logDocuments(directory)
          .map((document) => ({ fileName: document.fileName, desc: document.desc ?? '' }))
          .reverse(),
      }
    }

    const globalDir = this.store.globalDir
    const scopes = [{ scope: 'Global', directory: globalDir, ...(await summarize(globalDir, 'Global')) }]
    const directory = this.resolveDirectory('Workspace', sessionId)
    if (directory !== undefined) scopes.push({ scope: 'Workspace', directory, ...(await summarize(directory, 'Workspace')) })
    return scopes
  }

  /** @returns {Promise<object>} resolved scope/kind/directory/pool/document tuple. */
  async panelTarget(request) {
    const scope = scopeOf(request)
    const kind = kindOf(request)
    const directory = this.resolveDirectory(scope, request.sessionId)
    if (directory === undefined) return { scope, kind, directory, pool: [], document: undefined }
    await this.store.ensureDirectory(directory, scope)
    const pool = kind === 'log' ? this.store.logDocuments(directory) : this.store.documents(directory)
    return { scope, kind, directory, pool, document: pool.find((entry) => entry.fileName === request.fileName) }
  }

  /** @returns {Promise<object|undefined>} the file in tool and prompt renderings. */
  async fileText(request) {
    const { kind, directory, document } = await this.panelTarget(request)
    if (directory === undefined || document === undefined) return undefined
    const injected = kind === 'log'
      ? renderLog(document, { enabled: true, includeDetail: true })
      : renderInjection([document], { framed: false })
    return {
      fileName: document.fileName,
      scope: document.scope,
      kind,
      source: document.source ?? '',
      text: renderRead(document),
      injected,
      meta: {
        fileName: document.fileName,
        desc: document.desc ?? '',
        format: document.format ?? '',
        scope: document.scope,
        injectIgnore: [...(document.injectIgnore ?? [])],
      },
      tree: outline(document.roots),
    }
  }

  /** Apply the panel's metadata, heading and body edits with an optimistic hash guard. */
  async patchFile(request) {
    const { scope, kind, directory, pool, document } = await this.panelTarget(request)
    if (directory === undefined) {
      throw new DocumentError('这个会话还没有工作目录，无法修改工作区记忆')
    }
    if (document === undefined) throw new DocumentError(`找不到记忆文件: ${request.fileName}`)
    const working = cloneDocument(document)
    if (kind === 'memory') {
      if (request.newFileName !== undefined) {
        const next = String(request.newFileName).trim()
        assertUsableFileName(next)
        if (next !== working.fileName) {
          // Same rules `memory_manage` applies, so the two entry points cannot
          // disagree about which names are legal: a date name belongs to the
          // log, and a name is taken as soon as anything answers to it -
          // including a broken file, which `documents()` leaves out but
          // `locateIn()` still reports.
          if (isLogDate(next)) {
            throw new DocumentError(`${next} 是日期形式，日志文件的名字由插件自己管理，请换一个文件名`)
          }
          const taken =
            pool.some((entry) => entry.fileName === next) ||
            this.store.locateIn(directory, next) !== undefined ||
            this.store.locateIn(this.store.globalDir, next) !== undefined
          if (taken) {
            throw new DocumentError(`已经有一个叫 ${next} 的记忆文件了`)
          }
          working.fileName = next
        }
      }
      if (request.desc !== undefined) working.desc = normalizeMetaLine(request.desc)
      if (request.format !== undefined) {
        working.format = String(request.format).trim() === '' ? '' : String(request.format)
      }
      if (request.injectIgnore !== undefined) {
        working.injectIgnore = readInjectIgnore(request.injectIgnore, working.fileName)
      }
    }

    const targets = (request.nodes ?? []).map((change) => {
      const path = Array.isArray(change.path) ? change.path : []
      const node = findNode(working, path)
      if (node === undefined) throw new DocumentError(`找不到标题: ${path.join(' > ')}`)
      const siblings = findSiblings(working, path)
      return { change, node, siblings, path, title: path[path.length - 1] }
    })
    const removals = (request.removed ?? []).map((item) => {
      const path = Array.isArray(item) ? item.map(String) : []
      if (path.length === 0) throw new DocumentError('不能删除整份记忆')
      const siblings = findSiblings(working, path)
      const title = path[path.length - 1]
      if (siblings === undefined || !siblings.has(title)) {
        throw new DocumentError(`找不到标题: ${path.join(' > ')}`)
      }
      return { siblings, title }
    })
    if (removals.length > 0 && kind !== 'memory') {
      throw new DocumentError('日志的标题由插件按日期组织，不能删除')
    }

    const renames = []
    const translatePath = (path) => {
      const out = [...path]
      for (const rename of renames) {
        const depth = rename.parentPath.length
        if (out.length <= depth) continue
        if (out[depth] !== rename.from) continue
        if (out.slice(0, depth).every((title, index) => title === rename.parentPath[index])) {
          out[depth] = rename.to
        }
      }
      return out
    }

    for (const { change, node, siblings, path, title } of targets) {
      if (change.title !== undefined) {
        const next = String(change.title).trim()
        assertUsableTitle(next)
        if (next !== title) {
          if (siblings.has(next)) throw new DocumentError(`同一层已经有「${next}」这级标题了`)
          renameHeading(siblings, title, next)
          renames.push({ parentPath: translatePath(path.slice(0, -1)), from: title, to: next })
        }
      }
      if (change.desc !== undefined) node.desc = normalizeBody(change.desc)
      if (change.keyword !== undefined) node.keyword = readKeywords(change.keyword, path)
    }
    for (const { siblings, title } of removals) siblings.delete(title)
    for (const change of request.newNodes ?? []) {
      if (kind !== 'memory') throw new DocumentError('日志的标题由插件按日期组织，不能手动新增')
      const parentPath = translatePath(Array.isArray(change.parent) ? change.parent.map(String) : [])
      const title = String(change.title ?? '').trim()
      assertUsableTitle(title)
      if (parentPath.length + 1 > MAX_DEPTH) {
        throw new DocumentError(`标题最多 ${MAX_DEPTH} 层`)
      }
      const siblings = findSiblings(working, [...parentPath, title])
      if (siblings === undefined) throw new DocumentError(`找不到标题: ${parentPath.join(' > ')}`)
      if (siblings.has(title)) throw new DocumentError(`同一层已经有「${title}」这级标题了`)
      siblings.set(title, createNode(localTimestamp()))
      const created = siblings.get(title)
      if (change.desc !== undefined) created.desc = normalizeBody(change.desc)
      if (change.keyword !== undefined) created.keyword = readKeywords(change.keyword, [...parentPath, title])
    }

    const known = this.store.locateIn(directory, document.fileName)
    const loaded = await this.store.write(directory, scope, working, {
      expectedHash: known?.hash,
      baseRelative: known?.relative,
    })
    if (loaded.document === undefined) {
      throw new DocumentError(`写入后无法重新解析该文件: ${loaded.error ?? '未知错误'}`)
    }
    if (known !== undefined && working.fileName !== document.fileName) {
      await this.store.forgetRenamed(directory, known.relative, working.fileName, '已写入')
    }
    this.broadcast(directory)
    return this.fileText({ scope, sessionId: request.sessionId, fileName: working.fileName, kind })
  }

  /** Create an empty memory file; logs are created by the runtime's daily flow. */
  async createFile(request) {
    const scope = scopeOf(request)
    const directory = this.resolveDirectory(scope, request.sessionId)
    if (directory === undefined) {
      throw new DocumentError('这个会话还没有工作目录，无法新建工作区记忆')
    }
    const name = String(request.fileName ?? '').trim()
    assertUsableFileName(name)
    await this.store.ensureDirectory(directory, scope)
    // Shared factory so a file the panel creates carries the same defaults
    // (`inject_ignore` included) as one `memory_manage` creates.
    const created = await this.store.create(directory, scope, createDocument({ fileName: name, scope }))
    if (created.document === undefined) {
      throw new DocumentError(`新建后无法重新解析该文件: ${created.error ?? '未知错误'}`)
    }
    this.broadcast(directory)
    return this.fileText({ scope, sessionId: request.sessionId, fileName: name, kind: 'memory' })
  }

  /** Delete a memory file or log day named on the panel shelf. */
  async deleteFile(request) {
    const { scope, kind, directory, document } = await this.panelTarget(request)
    if (directory === undefined) return undefined
    if (document === undefined) throw new DocumentError(`找不到记忆文件: ${request.fileName}`)
    const known = this.store.locateIn(directory, document.fileName)
    if (known !== undefined) {
      await rm(join(directory, known.relative), { force: true })
      this.store.forget(directory, known.relative)
    }
    this.broadcast(directory)
    return { fileName: document.fileName, scope, kind }
  }
}
