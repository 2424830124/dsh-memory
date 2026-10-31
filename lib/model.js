/**
 * The memory document model: constants, node shapes, and field validation.
 *
 * Everything here is pure data. Nothing touches the filesystem or the harness,
 * so the model can be exercised directly in unit tests and reused by any layer.
 *
 * Adding a heading level (`t4`) or a new per-heading part means touching the
 * `LEVELS` / `ASPECTS` lists at the top of this file and nothing else: the depth
 * limit, the reserved-key set, and the legal `inject_ignore` values are all
 * derived from them.
 *
 * @module dsh-memory/model
 */

import { DocumentError } from './errors.js'
import { logDesc } from './log.js'
import { normalizeBody, normalizeMetaLine } from './text.js'

/** Heading levels, in order, as `inject_ignore` spells them. */
const LEVELS = ['t1', 't2', 't3', 't4']

/** Per-heading parts, as `inject_ignore` spells them. */
const ASPECTS = ['desc', 'keyword', 'update_at']

/** Deepest heading a memory file may contain. */
export const MAX_DEPTH = LEVELS.length

/** Keys reserved for node fields; they can never be heading titles. */
export const RESERVED_KEYS = new Set(ASPECTS)

/** Legal `inject_ignore` entries: every level, every aspect, every pair. */
const INJECT_IGNORE_VALUES = new Set([
  ...LEVELS,
  ...ASPECTS,
  ...LEVELS.flatMap((level) => ASPECTS.map((aspect) => `${level}.${aspect}`)),
])

/**
 * The same list as an array, in the order the panel offers it.
 *
 * 整层（`t1` 这种）也在这里：它本身就是一个可选的值——选中表示这一层的正文、
 * 关键词、更新时间全都不注入。面板里每层只占一行（行本身选整层，右边的「›」
 * 再展开该层的三项），所以不会和分组标题撞名。
 */
export const INJECT_IGNORE_OPTIONS = Object.freeze([
  ...ASPECTS,
  ...LEVELS.flatMap((level) => [level, ...ASPECTS.map((aspect) => `${level}.${aspect}`)]),
])

/** Every heading level the panel should offer, derived from the options. */
export const INJECT_IGNORE_LEVELS = Object.freeze([...LEVELS])

/**
 * What a new memory file suppresses unless told otherwise.
 *
 * The three parts that cost the most prompt space and change the least often;
 * a file that wants them back clears the list explicitly.
 */
const DEFAULT_INJECT_IGNORE = Object.freeze(['update_at', 'keyword'])

/** Scopes a memory file may declare. */
export const SCOPES = ['Global', 'Workspace']

/**
 * Read a request's `scope`, defaulting to Global.
 *
 * The settings route, the panel service, and the tools all have to agree on
 * what an absent or unexpected scope means, so they share this one reader.
 *
 * @param {unknown} value - the requested scope.
 * @returns {'Global'|'Workspace'} the scope to use.
 */
export function normalizeScope(value) {
  return value === 'Workspace' ? 'Workspace' : 'Global'
}

/**
 * Read a request's `kind`, defaulting to a memory file.
 * @param {unknown} value - the requested kind.
 * @returns {DocumentKind} the kind to use.
 */
export function normalizeKind(value) {
  return value === 'log' ? 'log' : 'memory'
}

/**
 * The two kinds of file the plugin stores.
 *
 * They share one document shape on purpose: a log is a memory file with a fixed
 * heading vocabulary, so read, edit, render, and the store's cache all work on
 * both without a second code path.
 *
 * @typedef {'memory'|'log'} DocumentKind
 */

/**
 * A parsed file, memory or log.
 * @typedef {object} MemoryDocument
 * @property {DocumentKind} kind - which rules apply to this document.
 * @property {string} fileName - `meta_data.file_name`, the addressing key.
 * @property {string} desc - `meta_data.desc`; always empty for a log.
 * @property {string} format - `meta_data.format`; goes into the edit tool description only.
 * @property {'Global'|'Workspace'} scope - where the file lives.
 * @property {string[]} injectIgnore - entries from `meta_data.inject_ignore`.
 * @property {Map<string, MemoryNode>} roots - top-level headings in file order.
 * @property {string} source - the raw text this document was parsed from.
 */

/**
 * A heading node.
 * @typedef {object} MemoryNode
 * @property {string} update_at - ISO timestamp written by the plugin, never by the model.
 * @property {string} desc - normalized heading body.
 * @property {string[]} keyword - keywords.
 * @property {Map<string, MemoryNode>} children - child headings in file order.
 */

/**
 * Whether a value is a plain object (not an array, not null).
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether it is a plain object.
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject a value that cannot be used as a heading title.
 *
 * The rendered form has no escaping, so a newline or the bare word `desc` would
 * read back as something other than a heading.
 *
 * @param {string} title - candidate title.
 * @returns {void}
 * @throws {DocumentError} when the title is empty, reserved, or multiline.
 */
export function assertUsableTitle(title) {
  if (title === '') throw new DocumentError('标题不能为空')
  if (RESERVED_KEYS.has(title)) throw new DocumentError(`"${title}" 是保留字，不能作为标题`)
  if (title.includes('\n')) throw new DocumentError('标题不能包含换行')
}

/**
 * Reject a value that cannot be used as a memory file name.
 *
 * A file name is also the on-disk base name, so a separator (or a Windows
 * reserved character) in it would silently write outside the memory directory.
 *
 * @param {string} fileName - candidate file name.
 * @returns {void}
 * @throws {DocumentError} when the name is unusable.
 */
export function assertUsableFileName(fileName) {
  if (fileName === '') throw new DocumentError('文件名不能为空')
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(fileName)) {
    throw new DocumentError(`文件名不能包含 \\ / : * ? " < > | 这些字符: ${JSON.stringify(fileName)}`)
  }
  if (fileName === '.' || fileName === '..') throw new DocumentError(`"${fileName}" 不能作为文件名`)
}

/**
 * Read a keyword list, dropping blanks and duplicates while keeping order.
 * @param {unknown} value - candidate keyword value.
 * @param {string} path - heading path for diagnostics.
 * @returns {string[]} keywords.
 * @throws {DocumentError} when the value is not a list of strings.
 */
export function readKeywords(value, path) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new DocumentError('keyword 必须是数组', path)
  const seen = new Set()
  const keywords = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new DocumentError('keyword 的每一项都必须是字符串', path)
    const keyword = entry.trim()
    if (keyword === '' || seen.has(keyword)) continue
    seen.add(keyword)
    keywords.push(keyword)
  }
  return keywords
}

/**
 * Read the `inject_ignore` list, rejecting unknown entries.
 * @param {unknown} value - candidate list.
 * @param {string} fileLabel - display label used in diagnostics.
 * @returns {string[]} the accepted entries.
 * @throws {DocumentError} when the list holds an unknown or duplicated entry.
 */
export function readInjectIgnore(value, fileLabel) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new DocumentError(`${fileLabel}: inject_ignore 必须是数组`)
  const seen = new Set()
  const entries = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new DocumentError(`${fileLabel}: inject_ignore 的每一项都必须是字符串`)
    const name = entry.trim()
    if (!INJECT_IGNORE_VALUES.has(name)) {
      throw new DocumentError(`${fileLabel}: inject_ignore 含有未知值 "${name}"，可选 ${[...INJECT_IGNORE_VALUES].join(', ')}`)
    }
    if (seen.has(name)) continue
    seen.add(name)
    entries.push(name)
  }
  return entries
}

/**
 * Create an empty heading node.
 * @param {string} timestamp - the `update_at` value to stamp.
 * @returns {MemoryNode} a fresh node.
 */
export function createNode(timestamp) {
  return { update_at: timestamp, desc: '', keyword: [], children: new Map() }
}

/**
 * Create an empty memory file.
 * @param {object} fields - the file's metadata.
 * @param {string} fields.fileName - `meta_data.file_name`.
 * @param {DocumentKind} [fields.kind] - `memory` or `log`.
 * @param {string} [fields.desc] - `meta_data.desc`.
 * @param {string} [fields.format] - `meta_data.format`.
 * @param {'Global'|'Workspace'} [fields.scope] - `meta_data.scope`.
 * @param {string[]} [fields.injectIgnore] - `meta_data.inject_ignore`; omit to take the default.
 * @returns {MemoryDocument} a document with no headings.
 */
export function createDocument({ fileName, kind = 'memory', desc = '', format = '', scope = 'Global', injectIgnore }) {
  assertUsableFileName(fileName)
  return {
    kind,
    fileName,
    // A log's `desc` belongs to the plugin, not to the caller: the scope alone
    // decides the sentence, so the two copies can never disagree.
    desc: kind === 'log' ? logDesc(scope) : normalizeMetaLine(desc),
    format: kind === 'log' ? '' : normalizeBody(format),
    scope,
    // A log keeps everything (its parts are already fixed by the renderer), a
    // memory file starts from the default suppression list.
    injectIgnore: kind === 'log' ? [] : [...(injectIgnore ?? DEFAULT_INJECT_IGNORE)],
    roots: new Map(),
    source: '',
  }
}

/**
 * Deep-copy a document.
 *
 * Edits mutate a document in place, so the runtime copies the cached one first:
 * a write that fails validation would otherwise leave the in-memory cache — and
 * therefore the prompt injection — showing content that never reached disk.
 *
 * @param {MemoryDocument} document - the document to copy.
 * @returns {MemoryDocument} an independent copy sharing no mutable state.
 */
export function cloneDocument(document) {
  return {
    kind: document.kind,
    fileName: document.fileName,
    desc: document.desc,
    format: document.format,
    scope: document.scope,
    injectIgnore: [...document.injectIgnore],
    roots: cloneLevel(document.roots),
    source: document.source,
  }
}

/**
 * Deep-copy one level of headings.
 * @param {Map<string, MemoryNode>} level - the headings to copy.
 * @returns {Map<string, MemoryNode>} the copy.
 */
function cloneLevel(level) {
  const copy = new Map()
  for (const [title, node] of level) {
    copy.set(title, {
      update_at: node.update_at,
      desc: node.desc,
      keyword: [...node.keyword],
      children: cloneLevel(node.children),
    })
  }
  return copy
}
