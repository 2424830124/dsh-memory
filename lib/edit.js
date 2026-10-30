/**
 * Heading-level operations on a memory document.
 *
 * Everything here is a pure in-memory mutation: the caller decides when to
 * persist. {@link applyEdit} is the whole rulebook for the edit tool — which
 * parameter does what, in which order, and what may be refused — and returns a
 * description of what changed so the caller can both persist and notify.
 *
 * The operation order is deliberate: a heading operation first (rename, create,
 * delete), then keywords against the *resulting* path, then the timestamp. A
 * rename combined with a keyword edit has to land on the new title.
 *
 * @module dsh-memory/edit
 */

import { DocumentError } from './errors.js'
import {
  DEFAULT_SUMMARY_MAX_CHARS,
  LOG_MAX_DEPTH,
  assertLogTitle,
  assertSummaryLength,
  parseLogEntryTitle,
  sortLogTitles,
} from './log.js'
import { MAX_DEPTH, assertUsableTitle, createNode } from './model.js'
import { normalizeBody, normalizeFragment } from './text.js'
import { findNode, findSiblings, renameHeading, touchPath } from './tree.js'

/** A line that is a heading: one to six `#`, a space, then a title. */
const HEADING_LINE = /^(#{1,6})\s+(.*)$/

/**
 * Parse a heading line into its level and title.
 * @param {unknown} text - a single line.
 * @returns {{level: number, title: string}|undefined} the parsed heading, when the line is one.
 */
export function parseHeadingLine(text) {
  if (typeof text !== 'string') return undefined
  const match = HEADING_LINE.exec(text.trim())
  if (match === null) return undefined
  const title = match[2].trim()
  return title === '' ? undefined : { level: match[1].length, title }
}

/**
 * An edit request, as the tool hands it over. Every field is optional except the
 * path; {@link applyEdit} decides which combinations are meaningful.
 *
 * @typedef {object} EditRequest
 * @property {string[]} path - heading titles from the top level down.
 * @property {string} [oldString] - exact text to replace, or the heading line to rename.
 * @property {string} [newString] - replacement text, or the new heading line.
 * @property {boolean} [removeOnly] - delete the heading instead of editing it.
 * @property {string[]} [addKeywords] - keywords to add.
 * @property {string[]} [removeKeywords] - keywords to remove.
 */

/**
 * What one applied edit did.
 * @typedef {object} EditOutcome
 * @property {boolean} created - whether the heading was created.
 * @property {boolean} renamed - whether the heading was renamed.
 * @property {boolean} deleted - whether the heading was deleted.
 * @property {string[]} path - the heading path after the edit.
 * @property {string} [body] - the stored body, when the edit wrote one.
 */

/**
 * Options the caller supplies for rules that depend on the plugin configuration.
 * @typedef {object} EditOptions
 * @property {number} [summaryMaxChars] - limit for one log entry's summary.
 */

/**
 * Apply one edit to a document.
 *
 * `heading_path` names the heading to work on. Body edits replace inside that
 * heading's own `desc`; a `#`-prefixed `new_string` renames the heading, creates
 * it, or (empty) deletes it together with its subtree.
 *
 * Log documents follow the same call shape but a different rulebook: see
 * {@link applyLogOperation}.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to mutate.
 * @param {EditRequest} request - the edit request, `path` already normalized.
 * @param {string} timestamp - the `update_at` value to stamp.
 * @param {EditOptions} [options] - configuration-dependent limits.
 * @returns {EditOutcome} what changed.
 * @throws {DocumentError} for any request that must not be applied.
 */
export function applyEdit(document, request, timestamp, options = {}) {
  const log = document.kind === 'log'
  const path = log ? normalizeLogPath(request.path, document.fileName) : normalizeEditPath(request.path)
  const result = { created: false, renamed: false, deleted: false, path: [...path] }

  if (log) {
    applyLogOperation(document, request, path, timestamp, result, options)
  } else if (request.removeOnly === true || isHeadingOperation(request.newString)) {
    applyHeadingOperation(document, request, path, timestamp, result)
  } else if (request.oldString !== undefined || request.newString !== undefined) {
    applyBodyOperation(document, request, path, timestamp, result)
  }

  // A rename updates `result.path`; keyword and touch must follow the new path.
  applyKeywordOperation(document, request, result.path)

  touchPath(document, result.path, timestamp)
  return result
}

/**
 * Validate and copy the heading path of one request.
 * @param {unknown} path - the caller's normalized path.
 * @returns {string[]} the path to edit.
 * @throws {DocumentError} when the path is empty, too deep, or holds a bad title.
 */
function normalizeEditPath(path) {
  if (!Array.isArray(path) || path.length === 0) throw new DocumentError('heading_path 不能为空')
  if (path.length > MAX_DEPTH) throw new DocumentError(`标题最多 ${MAX_DEPTH} 级`)
  const titles = path.map((title) => String(title))
  for (const title of titles) assertUsableTitle(title)
  return titles
}

/**
 * Validate and copy the heading path of one log edit.
 *
 * Exactly one shape is accepted — `# yyyy-mm-dd > ## hh:mm 摘要` — so the tool
 * description can state one form and the error can name the same form back. The
 * day level is not optional even though `file_name` already carries the date:
 * one required shape is cheaper to explain than a convenience the model has to
 * remember on top of it.
 *
 * @param {unknown} path - the caller's normalized path.
 * @param {string} date - the day this log covers.
 * @returns {string[]} the path to edit, with the day as its first level.
 * @throws {DocumentError} when the path is empty or not the log shape.
 */
function normalizeLogPath(path, date) {
  if (!Array.isArray(path) || path.length === 0) throw new DocumentError('heading_path 不能为空')
  if (path.length > LOG_MAX_DEPTH) {
    throw new DocumentError(`日志最多 ${LOG_MAX_DEPTH} 级标题，要写成 "# ${date} > ## hh:mm 摘要"`)
  }
  if (path.length < LOG_MAX_DEPTH) {
    throw new DocumentError(`日志要写成两级 "# ${date} > ## hh:mm 摘要"，一级是当天日期，二级是时分加一句摘要`)
  }
  const titles = path.map((title) => String(title))
  titles.forEach((title, index) => assertLogTitle(title, index + 1, date))
  return titles
}

/**
 * Whether a replacement value is a heading operation rather than body text.
 * @param {unknown} value - the caller's `new_string`.
 * @returns {boolean} whether its first line names a heading.
 */
function isHeadingOperation(value) {
  if (typeof value !== 'string') return false
  return parseHeadingLine(value.split('\n')[0]) !== undefined
}

/**
 * Rename, create, or delete the addressed heading.
 * @param {import('./model.js').MemoryDocument} document - the document to mutate.
 * @param {EditRequest} request - the edit request.
 * @param {string[]} path - the heading path.
 * @param {string} timestamp - the `update_at` value to stamp.
 * @param {EditOutcome} result - the outcome to fill in.
 * @returns {void}
 * @throws {DocumentError} when the heading operation is not allowed.
 */
function applyHeadingOperation(document, request, path, timestamp, result) {
  const siblings = findSiblings(document, path)
  const title = path.at(-1)
  const existing = siblings?.get(title)

  if (request.removeOnly === true) {
    if (existing === undefined) missingHeading(path)
    siblings.delete(title)
    result.deleted = true
    return
  }

  if (existing === undefined) {
    if (parseHeadingLine(request.newString) !== undefined) {
      throw new DocumentError(
        `新建标题只要在 heading_path 里写出 ${JSON.stringify(levelLabel(path))} 即可，new_string 填这个标题的正文`,
        path.join(' > '),
      )
    }
    createHeading(document, siblings, path, request, timestamp, result)
    return
  }

  const heading = parseHeadingLine(request.newString)
  if (heading === undefined || heading.level !== path.length) {
    throw new DocumentError(`"#" 的个数必须等于标题层级 ${path.length}，实际是 ${heading?.level ?? 0}`, path.join(' > '))
  }
  const expected = levelLabel(path)
  if (request.oldString === undefined || request.oldString.trim() === '') {
    throw new DocumentError('改标题时必须用 old_string 给出原标题行')
  }
  if (request.oldString.trim() !== expected) {
    throw new DocumentError(`改标题时 old_string 必须正好是 "${expected}"`, path.join(' > '))
  }
  assertUsableTitle(heading.title)
  if (heading.title === title) return
  if (siblings.has(heading.title)) throw new DocumentError(`同级已存在标题 "${heading.title}"`, path.join(' > '))

  const renamed = [...path.slice(0, -1), heading.title]
  renameHeading(siblings, title, heading.title)
  result.renamed = true
  result.path = renamed
}

/**
 * Spell one heading path as a heading line, e.g. `## 21:30`.
 * @param {string[]} path - heading titles from the top level down.
 * @returns {string} the heading line for the deepest title.
 */
function levelLabel(path) {
  return `${'#'.repeat(path.length)} ${path.at(-1)}`
}

/**
 * Create the heading an edit is addressing, when it does not exist yet.
 *
 * A create is reached from two directions — a `#`-prefixed `new_string` and a
 * plain body write on a path that does not exist yet — and both must refuse the
 * same things, so the guard lives here once.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to mutate.
 * @param {Map<string, import('./model.js').MemoryNode>|undefined} siblings - the level that must hold it.
 * @param {string[]} path - the heading path.
 * @param {EditRequest} request - the edit request.
 * @param {string} timestamp - the `update_at` value to stamp.
 * @param {EditOutcome} result - the outcome to fill in.
 * @returns {void}
 * @throws {DocumentError} when the heading cannot be created.
 */
function createHeading(document, siblings, path, request, timestamp, result) {
  if (siblings === undefined) missingParent(document, path)
  if (request.oldString !== undefined && request.oldString !== '') missingHeading(path)
  if (request.newString === undefined || request.newString === '') {
    throw new DocumentError('标题不存在，且没有给出要写入的内容')
  }
  const node = createNode(timestamp)
  result.body = writeBodyText(node, request.newString)
  siblings.set(path.at(-1), node)
  result.created = true
}

/**
 * Store one heading body, normalized and validated.
 *
 * Every body that reaches disk goes through here: a memory heading, a newly
 * created heading, and a log entry differ in when they are called, not in what a
 * body is allowed to contain.
 *
 * @param {import('./model.js').MemoryNode} node - the node to fill in.
 * @param {unknown} value - the caller's body text.
 * @returns {string} the stored body.
 * @throws {DocumentError} when the body is not acceptable.
 */
function writeBodyText(node, value) {
  const body = normalizeBody(value)
  assertBodyText(body)
  node.desc = body
  return body
}

/**
 * Replace or append body text inside the addressed heading.
 * @param {import('./model.js').MemoryDocument} document - the document to mutate.
 * @param {EditRequest} request - the edit request.
 * @param {string[]} path - the heading path.
 * @param {string} timestamp - the `update_at` value to stamp.
 * @param {EditOutcome} result - the outcome to fill in.
 * @returns {void}
 * @throws {DocumentError} when the heading is missing or the text cannot be applied.
 */
function applyBodyOperation(document, request, path, timestamp, result) {
  const siblings = findSiblings(document, path)
  const title = path.at(-1)
  const node = siblings?.get(title)

  if (node === undefined) {
    createHeading(document, siblings, path, request, timestamp, result)
    return
  }

  const body = writeBody(node, request)
  if (body !== undefined) result.body = body
}

/**
 * Rewrite one node's own body from a request.
 *
 * Split out from {@link applyBodyOperation} because a log entry is addressed the
 * same way without going through the ordinary heading lookup.
 *
 * @param {import('./model.js').MemoryNode} node - the node whose body to change.
 * @param {EditRequest} request - the edit request.
 * @returns {string|undefined} the new body when it actually changed.
 * @throws {DocumentError} when the text cannot be applied.
 */
function writeBody(node, request) {
  let next
  if (request.oldString === undefined) {
    const appended = normalizeFragment(request.newString ?? '')
    if (appended.trim() === '') throw new DocumentError('没有给出要改动的内容')
    next = normalizeBody(node.desc === '' ? appended : `${node.desc}\n\n${appended}`)
  } else {
    const needle = normalizeFragment(request.oldString)
    if (needle.trim() === '') throw new DocumentError('old_string 不能为空')
    const offset = uniqueOffset(node.desc, needle)
    const replacement = normalizeFragment(request.newString ?? '')
    next = normalizeBody(`${node.desc.slice(0, offset)}${replacement}${node.desc.slice(offset + needle.length)}`)
  }

  assertBodyText(next)
  const changed = next !== node.desc
  node.desc = next
  return changed ? next : undefined
}

/**
 * Apply one edit to a log document.
 *
 * A log has a fixed two-level shape and no rename, no delete: the day level is
 * bookkeeping the plugin creates on demand, and the only thing a caller can
 * write is one entry's body. The entry's summary travels in its title, so
 * creating an entry means picking a title as well as a body.
 *
 * Keywords are the exception: they belong to the entry, never to the day level,
 * so the caller may attach them in the same call that writes the body. They are
 * applied by `applyEdit` after this function returns.
 *
 * @param {import('./model.js').MemoryDocument} document - the log to mutate.
 * @param {EditRequest} request - the edit request.
 * @param {string[]} path - the validated log heading path, day level first.
 * @param {string} timestamp - the `update_at` value to stamp.
 * @param {EditOutcome} result - the outcome to fill in.
 * @param {EditOptions} options - configuration-dependent limits.
 * @returns {void}
 * @throws {DocumentError} when the edit is not something a log allows.
 */
function applyLogOperation(document, request, path, timestamp, result, options) {
  if (request.removeOnly === true) throw new DocumentError('日志条目不能删除')
  assertPlainLog(request)

  const [date, title] = path

  let day = document.roots.get(date)
  if (day === undefined) {
    day = createNode(timestamp)
    document.roots.set(date, day)
  }

  const entry = day.children.get(title)
  if (entry === undefined) {
    if (request.oldString !== undefined && request.oldString !== '') missingHeading(path)
    assertSummaryLength(parseLogEntryTitle(title).summary, options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS)
    const created = createNode(timestamp)
    const body = writeNewEntry(created, request)
    if (body !== undefined) result.body = body
    day.children.set(title, created)
    sortLogEntries(day.children)
    result.created = true
  } else {
    // Keyword-only edits never reach `writeBody`: a request that says nothing
    // about the body leaves it alone instead of appending an empty one.
    if (request.oldString !== undefined || request.newString !== undefined) {
      const body = writeBody(entry, request)
      if (body !== undefined) result.body = body
    }
  }
}

/**
 * Fill in one new entry's body, normalizing it like any other heading.
 * @param {import('./model.js').MemoryNode} node - the entry node to fill in.
 * @param {EditRequest} request - the edit request.
 * @returns {string|undefined} the stored body, or undefined when there is none.
 * @throws {DocumentError} when the body is not acceptable.
 */
function writeNewEntry(node, request) {
  if (request.newString === undefined || request.newString === '') return undefined
  return writeBodyText(node, request.newString)
}

/**
 * Order entries by the time their titles record.
 *
 * Entries are appended in the order they are written, so without this the file
 * would follow the model's writing session rather than the day it describes.
 *
 * @param {Map<string, import('./model.js').MemoryNode>} entries - the day's entries.
 * @returns {void}
 */
function sortLogEntries(entries) {
  const sorted = sortLogTitles([...entries.keys()]).map((key) => [key, entries.get(key)])
  entries.clear()
  for (const [key, value] of sorted) entries.set(key, value)
}

/**
 * Offset of the only occurrence of `needle` in `body`.
 * @param {string} body - the normalized heading body.
 * @param {string} needle - the text to find.
 * @returns {number} the offset of the single match.
 * @throws {DocumentError} when the text is absent or ambiguous.
 */
function uniqueOffset(body, needle) {
  const first = body.indexOf(needle)
  if (first === -1) {
    throw new DocumentError('old_string 与目标标题的原文不一致，未做任何修改。请先 memory_read 再逐字符复制原文')
  }
  if (body.indexOf(needle, first + needle.length) !== -1) {
    const count = body.split(needle).length - 1
    throw new DocumentError(`old_string 在该标题里出现了 ${count} 次，请带上更多上下文使其唯一`)
  }
  return first
}

/**
 * Reject body text that opens with a `#`.
 *
 * The rendered form has no escaping: a heading line is `#`-prefixed, so body text
 * that itself starts with `#` reads back as a heading that does not exist in the
 * tree, and every later edit addresses it wrongly.
 *
 * Only the opening matters. A `#` further in — mid-sentence or on a later line of
 * prose — renders as ordinary text, so it stays allowed; the model only has to
 * keep the first character clear.
 *
 * @param {string} text - the body text about to be stored.
 * @returns {void}
 * @throws {DocumentError} when the text opens with `#`.
 */
function assertBodyText(text) {
  if (text.trimStart().startsWith('#')) {
    throw new DocumentError(
      '正文开头不能是 "#"；要改标题请把原标题行填进 old_string、新标题行填进 new_string。"#" 出现在正文中间是可以的',
    )
  }
}

/**
 * Reject a leading `#` on either side of a log edit.
 *
 * A log is an append-only record: the heading is the time slot chosen by
 * `heading_path`, never something written as text. Text that starts with `#`
 * would read back as a heading the next edit addresses wrongly, so the opening
 * must stay clear — while a `#` inside prose is ordinary text and stays allowed.
 *
 * @param {EditRequest} request - the edit request about to be applied.
 * @returns {void}
 * @throws {DocumentError} when either side opens with `#`.
 */
function assertPlainLog(request) {
  for (const value of [request.oldString, request.newString]) {
    if (value !== undefined && value.trimStart().startsWith('#')) {
      throw new DocumentError(
        '日志里不能写标题：new_string 和 old_string 开头都不能是 "#"，时间标题只放在 heading_path 里；"#" 出现在中间是可以的',
      )
    }
  }
}

/**
 * Add or remove keywords on the addressed heading: removals first, then additions.
 * @param {import('./model.js').MemoryDocument} document - the document to mutate.
 * @param {EditRequest} request - the edit request.
 * @param {string[]} path - the heading path.
 * @returns {void}
 * @throws {DocumentError} when the heading is missing.
 */
function applyKeywordOperation(document, request, path) {
  const add = request.addKeywords ?? []
  const remove = request.removeKeywords ?? []
  if (add.length === 0 && remove.length === 0) return

  const node = findNode(document, path)
  if (node === undefined) throw new DocumentError(`找不到标题 ${JSON.stringify(path.at(-1))}，无法修改 keyword`, path.join(' > '))

  const dropped = new Set(remove.map((keyword) => String(keyword).trim()))
  const kept = node.keyword.filter((keyword) => !dropped.has(keyword))
  for (const keyword of add) {
    const trimmed = String(keyword).trim()
    if (trimmed === '' || kept.includes(trimmed)) continue
    kept.push(trimmed)
  }
  node.keyword = kept
}

/**
 * Throw the standard "this heading does not exist" error.
 * @param {string[]} path - the heading path.
 * @returns {never} always throws.
 */
function missingHeading(path) {
  throw new DocumentError(`找不到标题 ${JSON.stringify(path.at(-1))}`, path.join(' > '))
}

/**
 * Throw the standard "create the parent first" error.
 * @param {import('./model.js').MemoryDocument} document - the document to inspect.
 * @param {string[]} path - the heading path that could not be created.
 * @returns {never} always throws.
 */
function missingParent(document, path) {
  const titles = path.slice(0, -1)
  const index = titles.findIndex((_title, position) => findNode(document, path.slice(0, position + 1)) === undefined)
  const hint = index === -1 ? undefined : `；先建 ${JSON.stringify(levelLabel(titles.slice(0, index + 1)))}，一次只能多建一级`
  throw new DocumentError(
    `上级标题不存在，无法新建 ${JSON.stringify(path.at(-1))}${hint ?? ''}`,
    path.join(' > '),
  )
}

