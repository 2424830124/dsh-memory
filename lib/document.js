/**
 * The on-disk memory file format: YAML text ⇄ {@link MemoryDocument}.
 *
 * One file is one memory "notebook": `meta_data` for identity and injection
 * policy, `data` for the heading tree. Parsing validates everything the edit and
 * render layers rely on, so a document that exists in memory is always
 * renderable and addressable; anything else becomes a `DocumentError` that the
 * store turns into a "broken file" record instead of a crash.
 *
 * @module dsh-memory/document
 */

import YAML from 'yaml'

import { DocumentError } from './errors.js'
import { LOG_MAX_DEPTH, assertLogTitle, isLogDate, logDesc } from './log.js'
import {
  MAX_DEPTH,
  RESERVED_KEYS,
  SCOPES,
  assertUsableFileName,
  assertUsableTitle,
  isPlainObject,
  readInjectIgnore,
  readKeywords,
} from './model.js'
import { PATH_SEPARATOR } from './path.js'
import { normalizeBody, normalizeMetaBlock, normalizeMetaLine } from './text.js'

/**
 * How one kind of document constrains its heading tree.
 *
 * Choosing a shape instead of branching on `kind` inside the readers means the
 * only thing a new document kind has to supply is its vocabulary.
 *
 * @typedef {object} TreeShape
 * @property {number} maxDepth - deepest allowed heading level.
 * @property {(title: string, depth: number) => void} assertTitle - the level's title rule.
 */

/** Memory files: free titles, three levels. */
const MEMORY_SHAPE = {
  maxDepth: MAX_DEPTH,
  assertTitle: (title) => assertUsableTitle(title),
}

/**
 * Log files: the day as the only first-level heading, `HH:MM 摘要` entries below.
 * @param {string} date - the day this file covers, which the first level must name.
 * @returns {TreeShape} the shape for one log file.
 */
function logShape(date) {
  return {
    maxDepth: LOG_MAX_DEPTH,
    assertTitle: (title, depth) => assertLogTitle(title, depth, date),
  }
}

/**
 * Read the child headings of one level.
 *
 * Shared by the `data` root and by every node, so a reserved word is rejected at
 * the top level exactly as it is deeper in the tree.
 *
 * @param {Record<string, unknown>} entries - title → raw node mapping.
 * @param {string[]} prefix - the path of the level's parent.
 * @param {string} fileLabel - display label used in diagnostics.
 * @param {TreeShape} shape - the rules this document follows.
 * @returns {Map<string, import('./model.js').MemoryNode>} the children in file order.
 * @throws {DocumentError} on a reserved, empty, duplicate, or malformed heading.
 */
function readChildren(entries, prefix, fileLabel, shape) {
  const children = new Map()
  for (const [key, value] of Object.entries(entries)) {
    const title = normalizeMetaLine(key)
    shape.assertTitle(title, prefix.length + 1)
    if (children.has(title)) {
      throw new DocumentError(`${fileLabel}: 同级标题重复 "${title}"`, prefix.join(PATH_SEPARATOR))
    }
    children.set(title, readNode(value, [...prefix, title], fileLabel, shape))
  }
  return children
}

/**
 * Validate and normalize one heading subtree.
 * @param {unknown} raw - the heading's mapping.
 * @param {string[]} selfPath - this heading's full path, from the top level down.
 * @param {string} fileLabel - display label used in diagnostics.
 * @param {TreeShape} shape - the rules this document follows.
 * @returns {import('./model.js').MemoryNode} the normalized node.
 * @throws {DocumentError} when the node is too deep or malformed.
 */
function readNode(raw, selfPath, fileLabel, shape) {
  const depth = selfPath.length
  const label = selfPath.join(PATH_SEPARATOR)
  if (depth > shape.maxDepth) throw new DocumentError(`标题最多 ${shape.maxDepth} 级`, label)
  if (!isPlainObject(raw)) throw new DocumentError(`标题 ${JSON.stringify(selfPath.at(-1))} 的内容必须是对象`, label)

  const fields = {}
  const headings = {}
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_KEYS.has(key)) fields[key] = value
    else headings[key] = value
  }

  return {
    update_at: normalizeMetaLine(fields.update_at),
    desc: normalizeBody(fields.desc),
    keyword: readKeywords(fields.keyword, label),
    children: readChildren(headings, selfPath, fileLabel, shape),
  }
}

/**
 * Read a memory file's metadata.
 * @param {Record<string, unknown>} meta - the `meta_data` mapping.
 * @param {{fileName?: string, scope?: string}} fallback - values used when the metadata omits them.
 * @returns {{fileName: string, desc: string, format: string, scope: string, injectIgnore: string[]}} the metadata.
 * @throws {DocumentError} when the name or scope is unusable.
 */
function readMemoryMeta(meta, fallback) {
  const fileName = normalizeMetaLine(meta.file_name) || normalizeMetaLine(fallback.fileName)
  assertUsableFileName(fileName)

  const declaredScope = normalizeMetaLine(meta.scope)
  const scope = declaredScope === '' ? fallback.scope : declaredScope
  if (scope !== undefined && !SCOPES.includes(scope)) {
    throw new DocumentError(`meta_data.scope 必须是 ${SCOPES.join(' 或 ')}，实际是 "${scope}"`)
  }

  return {
    fileName,
    desc: normalizeMetaLine(meta.desc),
    format: normalizeMetaBlock(meta.format),
    scope: scope ?? 'Global',
    injectIgnore: readInjectIgnore(meta.inject_ignore, fileName),
  }
}

/**
 * Read a log file's metadata.
 *
 * A log declares nothing but its date: no `desc`, no `format`, no injection
 * policy. Rejecting the extra keys is what keeps the file shape honest — a model
 * that writes `format` expects it to be honored, and for a log it never is.
 *
 * @param {Record<string, unknown>} meta - the `meta_data` mapping.
 * @param {{fileName?: string, scope?: string}} fallback - values used when the metadata omits them.
 * @returns {{fileName: string, desc: string, format: string, scope: string, injectIgnore: string[]}} the metadata.
 * @throws {DocumentError} when the name is not a date or extra keys are present.
 */
function readLogMeta(meta, fallback) {
  const extra = Object.keys(meta).filter((key) => key !== 'file_name' && key !== 'desc')
  if (extra.length > 0) {
    throw new DocumentError(`日志文件的 meta_data 只能写 file_name 和 desc，多出了 ${extra.join('、')}`)
  }
  const fileName = normalizeMetaLine(meta.file_name) || normalizeMetaLine(fallback.fileName)
  if (!isLogDate(fileName)) {
    throw new DocumentError(`日志文件的 file_name 必须是日期 YYYY-MM-DD，实际是 ${JSON.stringify(fileName)}`)
  }
  const scope = fallback.scope ?? 'Global'
  // `desc` is fixed by the scope rather than authored: a log is either "his" or
  // the project's, and a model that rewrote that line would be describing the
  // file's purpose, which it is not allowed to change. A stored value is
  // accepted and overwritten rather than rejected, so a file that carries an
  // older or hand-edited line still loads.
  return { fileName, desc: logDesc(scope), format: '', scope, injectIgnore: [] }
}

/**
 * Parse memory file text.
 * @param {string} source - raw file text.
 * @param {{fileName?: string, scope?: string, kind?: import('./model.js').DocumentKind}} [fallback] - values used when the metadata omits them.
 * @returns {import('./model.js').MemoryDocument} the parsed document.
 * @throws {DocumentError} when the text is not a well-formed memory file.
 */
export function parseDocument(source, fallback = {}) {
  let raw
  try {
    raw = YAML.parse(source)
  } catch (error) {
    throw new DocumentError(`YAML 解析失败: ${error.message}`)
  }
  if (raw === null || raw === undefined) raw = {}
  if (!isPlainObject(raw)) throw new DocumentError('文件顶层必须是对象')

  const meta = raw.meta_data
  if (!isPlainObject(meta)) throw new DocumentError('缺少 meta_data 段')

  const kind = fallback.kind === 'log' ? 'log' : 'memory'
  const fields = kind === 'log' ? readLogMeta(meta, fallback) : readMemoryMeta(meta, fallback)

  const data = raw.data === undefined || raw.data === null ? {} : raw.data
  if (!isPlainObject(data)) throw new DocumentError('data 段必须是对象')

  return {
    kind,
    ...fields,
    roots: readChildren(data, [], fields.fileName, kind === 'log' ? logShape(fields.fileName) : MEMORY_SHAPE),
    source,
  }
}

/**
 * Serialize a document back to YAML text.
 *
 * Empty fields are omitted rather than written as `""`, so a hand-edited file
 * and a plugin-written one look the same.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to write.
 * @returns {string} canonical YAML text ending with a newline.
 */
export function serializeDocument(document) {
  const data = {}
  for (const [title, node] of document.roots) data[title] = writeNode(node)
  if (document.kind === 'log') {
    const meta = { file_name: document.fileName }
    if (document.desc !== '') meta.desc = document.desc
    return YAML.stringify({ meta_data: meta, data }, { lineWidth: 0 })
  }

  const meta = {
    file_name: document.fileName,
    desc: document.desc,
    scope: document.scope,
  }
  if (document.format !== '') meta.format = document.format
  if (document.injectIgnore.length > 0) meta.inject_ignore = [...document.injectIgnore]

  return YAML.stringify({ meta_data: meta, data }, { lineWidth: 0 })
}

/**
 * Project one heading subtree onto its serialized form, omitting empty fields.
 * @param {import('./model.js').MemoryNode} node - the node to write.
 * @returns {object} the plain object for YAML.
 */
function writeNode(node) {
  const out = {}
  if (node.update_at !== '') out.update_at = node.update_at
  if (node.desc !== '') out.desc = node.desc
  if (node.keyword.length > 0) out.keyword = [...node.keyword]
  for (const [title, child] of node.children) out[title] = writeNode(child)
  return out
}
