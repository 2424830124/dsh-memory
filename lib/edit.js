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
 * The one sentence both body paths use when the text carries a heading line.
 *
 * New headings are addressed by `heading_path`, never by writing `#` into a body:
 * saying so here is what turns a rejected edit into a corrected one.
 */
const NO_HEADING_IN_BODY =
  '正文中不能出现标题：有行以 "#" 开头，会读成不存在的标题。新建标题请在 heading_path 里写出层级（例如 "# 标题 > ## 子标题"），正文里不要用 "#" 打头'

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
 * Whether any line of `text` would read back as a heading.
 *
 * A heading is recognised by its opening `#`, and the stored body is rendered
 * verbatim, so a `#`-prefixed line in the middle is indistinguishable from a
 * heading the tree does not have. The first line and every line after a newline
 * are therefore checked alike.
 *
 * @param {string} text - candidate body text.
 * @returns {boolean} whether some line opens with `#`.
 */
function hasHeadingLine(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .some((line) => line.trimStart().startsWith('#'))
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
  writeBodyText(node, request.newString)
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
 * @returns {void}
 * @throws {DocumentError} when the body is not acceptable.
 */
function writeBodyText(node, value) {
  const body = normalizeBody(value)
  assertBodyText(body)
  node.desc = body
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

  writeBody(node, request)
}

/**
 * Rewrite one node's own body from a request.
 *
 * Split out from {@link applyBodyOperation} because a log entry is addressed the
 * same way without going through the ordinary heading lookup.
 *
 * @param {import('./model.js').MemoryNode} node - the node whose body to change.
 * @param {EditRequest} request - the edit request.
 * @returns {void}
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
  node.desc = next
}

/**
 * Apply one edit to a log document.
 *
 * A log has a fixed two-level shape: the day level is bookkeeping the plugin
 * creates on demand, and everything a caller writes lands in one entry. The
 * entry's summary travels in its title, so creating an entry means picking a
 * title as well as a body — and rewriting that title (its time, its summary, or
 * both) is an ordinary rename, which re-sorts the entry into place. An entry can
 * also be deleted outright: a note written under the wrong time, or in the wrong
 * day, should not have to be emptied by hand and left behind as a husk. The day
 * level itself is neither renamed nor deleted: it *is* the file name, and an
 * empty shell for the day is what the file is.
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
  if (request.removeOnly === true) {
    removeLogEntry(document, path, result)
    return
  }

  // A `#`-prefixed `new_string` is the same signal here as in a memory file: the
  // caller is rewriting the title line, not the body.
  if (isHeadingOperation(request.newString)) {
    renameLogEntry(document, request, path, result, options)
    return
  }
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
    writeNewEntry(created, request)
    day.children.set(title, created)
    sortLogEntries(day.children)
    result.created = true
  } else {
    // Keyword-only edits never reach `writeBody`: a request that says nothing
    // about the body leaves it alone instead of appending an empty one.
    if (request.oldString !== undefined || request.newString !== undefined) {
      writeBody(entry, request)
    }
  }
}

/**
 * Remove one log entry, body, keywords and all.
 *
 * `normalizeLogPath` fixes the path at two levels, so the day level can never be
 * the target here: an entry is the only thing a log edit can address. Deleting
 * the day itself is deleting the file, which goes through `memory_manage` and
 * not through the entry-level edit.
 *
 * @param {import('./model.js').MemoryDocument} document - the log to mutate.
 * @param {string[]} path - the validated log heading path, day level first.
 * @param {EditOutcome} result - the outcome to fill in.
 * @returns {void}
 * @throws {DocumentError} when that entry does not exist.
 */
function removeLogEntry(document, path, result) {
  const [date, title] = path
  const entries = document.roots.get(date)?.children
  if (entries === undefined || !entries.has(title)) missingHeading(path)
  entries.delete(title)
  result.deleted = true
}

/**
 * Rewrite one entry's title line: its time, its summary, or both.
 *
 * The summary lives in the title, so fixing a typo in it has to be a rename
 * rather than a body edit. The new title goes through the same shape check a new
 * entry does, and the entry is re-sorted afterwards — moving `12:35` to `09:10`
 * means the file order changes too. The body and the keywords stay put.
 *
 * Only entries can be renamed. The day level is the file name, so rewriting it
 * would either rename the file behind the store's back or make the document
 * disagree with the name it was loaded under; both are better refused.
 *
 * @param {import('./model.js').MemoryDocument} document - the log to mutate.
 * @param {EditRequest} request - the edit request.
 * @param {string[]} path - the validated log heading path, day level first.
 * @param {EditOutcome} result - the outcome to fill in.
 * @param {EditOptions} options - configuration-dependent limits.
 * @returns {void}
 * @throws {DocumentError} when the title cannot be rewritten.
 */
function renameLogEntry(document, request, path, result, options) {
  const [date, title] = path
  const heading = parseHeadingLine(request.newString)

  if (heading.level === 1) {
    throw new DocumentError(
      `日志的一级标题就是当天日期 ${JSON.stringify(date)}，和 file_name 相同，改不了；要改的是二级条目，写成 "## hh:mm 摘要"`,
      path.join(' > '),
    )
  }
  if (heading.level !== path.length) {
    throw new DocumentError(`"#" 的个数必须等于标题层级 ${path.length}，实际是 ${heading.level}`, path.join(' > '))
  }

  const expected = levelLabel(path)
  if (request.oldString === undefined || request.oldString.trim() === '') {
    throw new DocumentError(
      `改标题时必须用 old_string 给出原标题行 "${expected}"；如果这是正文，正文开头不能是 "#"`,
      path.join(' > '),
    )
  }
  if (request.oldString.trim() !== expected) {
    throw new DocumentError(
      `改标题时 old_string 必须正好是 "${expected}"；如果这是正文，正文开头不能是 "#"`,
      path.join(' > '),
    )
  }

  const day = document.roots.get(date)
  const entries = day?.children
  if (entries === undefined || !entries.has(title)) missingHeading(path)

  assertLogTitle(heading.title, path.length, date)
  // The limit only guards a summary that is being *written*. Renaming the time
  // of an entry written under a looser limit must keep working, exactly like a
  // body edit on it does.
  const previous = parseLogEntryTitle(title).summary
  const next = parseLogEntryTitle(heading.title).summary
  if (next !== previous) assertSummaryLength(next, options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS)
  if (heading.title === title) return
  if (entries.has(heading.title)) {
    throw new DocumentError(`同级已存在标题 "${heading.title}"`, path.join(' > '))
  }

  renameHeading(entries, title, heading.title)
  sortLogEntries(entries)
  result.renamed = true
  result.path = [...path.slice(0, -1), heading.title]
}

/**
 * Fill in one new entry's body, normalizing it like any other heading.
 * @param {import('./model.js').MemoryNode} node - the entry node to fill in.
 * @param {EditRequest} request - the edit request.
 * @returns {void}
 * @throws {DocumentError} when the body is not acceptable.
 */
function writeNewEntry(node, request) {
  if (request.newString === undefined || request.newString === '') return
  writeBodyText(node, request.newString)
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
 * Reject body text that contains a heading line.
 *
 * The rendered form has no escaping: a heading line is `#`-prefixed, so a line
 * of body text that opens with `#` reads back as a heading that does not exist in
 * the tree, and every later edit addresses it wrongly. That is true of the first
 * line and of any line after a newline alike — the model cannot switch a heading
 * on halfway through a body, so a `#` at the start of any line is a mistake, not
 * prose. Headings are made by addressing them in `heading_path`.
 *
 * @param {string} text - the body text about to be stored.
 * @returns {void}
 * @throws {DocumentError} when some line opens with `#`.
 */
function assertBodyText(text) {
  if (hasHeadingLine(text)) throw new DocumentError(NO_HEADING_IN_BODY)
}

/**
 * Reject a heading line on either side of a log body edit.
 *
 * Reached only when the request is *not* a rename, so a `#`-prefixed line here
 * means the caller tried to write a heading into a body. A log heading is either
 * the day (fixed) or an entry title rewritten through {@link renameLogEntry};
 * body text that contains a heading line would read back as a heading the next
 * edit addresses wrongly, so it is refused whichever line it sits on. The rename
 * branch runs before this, so a real rename still gets through.
 *
 * @param {EditRequest} request - the edit request about to be applied.
 * @returns {void}
 * @throws {DocumentError} when either side contains a heading line.
 */
function assertPlainLog(request) {
  for (const value of [request.oldString, request.newString]) {
    if (value !== undefined && hasHeadingLine(value)) throw new DocumentError(NO_HEADING_IN_BODY)
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

