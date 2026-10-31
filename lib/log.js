/**
 * Short-term memory: one file per day, one heading per entry.
 *
 * A log file lives in `log/` beside the memory files and is named after the day
 * it covers (`2026-10-27.yaml`). Its `meta_data` carries `file_name` and a
 * `desc` that is fixed per scope, and its tree has a fixed shape of exactly two
 * levels:
 *
 * ```
 * data:
 *   2026-10-27:             the day: always equal to `file_name`
 *     update_at: ...
 *     19:20 去了杭州:        one entry: local time `HH:MM`, then a summary
 *       update_at: ...
 *       desc:                the entry's own body, as long as it needs to be
 * ```
 *
 * The day level is bookkeeping: it exists so the file is a well-formed heading
 * tree, and the plugin creates it. Everything a caller writes goes into an entry
 * — a time, a one-line summary, and a body.
 *
 * This module is pure data and rules — no filesystem, no harness. It answers
 * "is this a log name", "what does this heading mean", and "which entries does
 * this range keep"; the store, edit, and runtime layers do the I/O around it.
 *
 * @module dsh-memory/log
 */

import { DocumentError } from './errors.js'

/** Folder holding log files, inside a memory directory. */
export const LOG_DIR_NAME = 'log'

/** Deepest heading level in a log file. */
export const LOG_MAX_DEPTH = 2

/** Default limit for one entry's summary, in characters. */
export const DEFAULT_SUMMARY_MAX_CHARS = 200

/**
 * Fixed `meta_data.desc` of a log, one line per scope.
 *
 * The description says what the file is for, so it belongs to the plugin rather
 * than to whoever writes entries: a model that paraphrased it would only make
 * the two scopes drift apart. `他` is the user, deliberately unnamed.
 */
export const LOG_DESCS = Object.freeze({
  Global: '用来记录和“他”之间的互动',
  Workspace: '用来记录项目相关操作',
})

/**
 * The fixed description for one scope.
 * @param {string} [scope] - `Global` or `Workspace`.
 * @returns {string} the description.
 */
export function logDesc(scope) {
  return LOG_DESCS[scope] ?? LOG_DESCS.Global
}

/**
 * Separator for a range query, as in `2026-10-20..2026-10-22` or `12:00..14:00`.
 *
 * Deliberately not `>`, which already means "next heading level": a range and a
 * heading path must not look alike, or a date range reads as a path.
 */
const RANGE_SEPARATOR = '..'

/** `2026-10-27` */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** The shape of a date, without checking that the day exists. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/**
 * One clock reading, `HH:MM`, in 24-hour form.
 *
 * A single definition of "what a time looks like" for the whole module: an entry
 * title, a `hh:mm` query, and a range bound all have to agree, or a value the
 * reader accepts is one the writer would have rejected.
 */
const CLOCK = '([01]\\d|2[0-3]):([0-5]\\d)'

/** `19:20` */
const TIME_PATTERN = new RegExp(`^${CLOCK}$`)

/** `19:20`, optionally followed by the entry's summary. */
const ENTRY_PATTERN = new RegExp(`^${CLOCK}(?:\\s+([\\s\\S]*))?$`)

/**
 * Pad a number to two digits.
 * @param {number} value - the number.
 * @returns {string} the padded form.
 */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * Split one `YYYY-MM-DD` value into the numbers a clock can be built from.
 *
 * Existence is checked here rather than at each caller, so `2026-02-30` is
 * rejected once instead of being accepted by one comparison and not another.
 *
 * @param {unknown} value - candidate date.
 * @returns {{year: number, month: number, day: number}|undefined} the parts, or undefined when it is not a real date.
 */
function parseDateParts(value) {
  if (typeof value !== 'string') return undefined
  const match = DATE_PATTERN.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return { year, month, day }
}

/**
 * Whether a value is a calendar date in `YYYY-MM-DD` form.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether it is a real date.
 */
export function isLogDate(value) {
  return parseDateParts(value) !== undefined
}

/**
 * Sort key for one `YYYY-MM-DD` date: milliseconds since the epoch, spelled in
 * UTC so a DST boundary cannot make two days compare equal.
 *
 * @param {string} date - a `YYYY-MM-DD` date.
 * @returns {number} the date's value, or `NaN` when it is not a date.
 */
export function logDateValue(date) {
  const parts = parseDateParts(date)
  if (parts === undefined) return Number.NaN
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

/**
 * Split an entry title into the time it records and the summary it carries.
 *
 * The summary is optional here — a title is readable as long as its time is
 * spelled right — but {@link assertLogTitle} requires one for new entries, since
 * a timeline of bare times says nothing.
 *
 * @param {unknown} value - candidate title, e.g. `19:20 去了杭州`.
 * @returns {{time: string, summary: string}|undefined} the parts, or undefined when the title is not an entry.
 */
export function parseLogEntryTitle(value) {
  if (typeof value !== 'string') return undefined
  const match = ENTRY_PATTERN.exec(value.trim())
  if (match === null) return undefined
  return { time: `${match[1]}:${match[2]}`, summary: (match[3] ?? '').trim() }
}

/**
 * Local calendar date of one instant.
 * @param {Date} [date] - the instant, defaulting to now.
 * @returns {string} `YYYY-MM-DD`.
 */
export function formatLogDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Minutes since midnight for one clock reading.
 *
 * Shares {@link TIME_PATTERN} with the entry shape on purpose: a looser test
 * here would accept `99:99` from a query while {@link parseLogEntryTitle} refuses
 * it, and the two would disagree about the same string.
 *
 * @param {unknown} time - an `HH:MM` value.
 * @returns {number|undefined} the minute count, or undefined when malformed.
 */
function logMinutes(time) {
  if (typeof time !== 'string') return undefined
  const match = TIME_PATTERN.exec(time)
  if (match === null) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Reject a heading title that does not fit the log shape.
 *
 * @param {string} title - candidate title.
 * @param {number} depth - its level, from 1.
 * @param {string} date - the date this file covers, which the first level must name.
 * @returns {void}
 * @throws {DocumentError} when the title is not the shape its level requires.
 */
export function assertLogTitle(title, depth, date) {
  if (typeof title !== 'string' || title === '') throw new DocumentError('日志标题不能为空')
  if (depth === 1) {
    if (title !== date) {
      throw new DocumentError(
        `日志的一级标题就是当天日期 ${JSON.stringify(date)}，和 file_name 相同，由插件维护，实际是 ${JSON.stringify(title)}`,
      )
    }
    return
  }
  if (depth === 2) {
    const entry = parseLogEntryTitle(title)
    if (entry === undefined) {
      throw new DocumentError(`日志的二级标题要以时分开头，例如 "19:20 去了杭州"，实际是 ${JSON.stringify(title)}`)
    }
    if (entry.summary === '') {
      throw new DocumentError(`日志的二级标题要在时分后面写一句摘要，例如 "19:20 去了杭州"，实际是 ${JSON.stringify(title)}`)
    }
    return
  }
  throw new DocumentError(`日志最多 ${LOG_MAX_DEPTH} 级标题：一级是当天日期，二级是 "HH:MM 摘要"`)
}

/**
 * Whether a value looks like a date, whether or not that day exists.
 *
 * Used to tell "the caller wrote the day level" apart from "the caller wrote an
 * entry that happens to be malformed", so the error can name the right level.
 *
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether it is shaped like `YYYY-MM-DD`.
 */
export function isDateShaped(value) {
  return typeof value === 'string' && DATE_SHAPE.test(value)
}

/**
 * The entries of one log, in file order.
 *
 * A log has at most one first-level heading — the day it covers — so the entries
 * are that heading's children, and everything that walks a log goes through here
 * instead of assuming where the day level sits.
 *
 * @param {import('./model.js').MemoryDocument} document - the log to read.
 * @returns {Array<[string, import('./model.js').MemoryNode]>} title → node pairs.
 */
export function logEntries(document) {
  const day = [...document.roots.values()][0]
  return day === undefined ? [] : [...day.children.entries()]
}

/**
 * Read a date query: one day, or a `from..to` range.
 *
 * The separator is `..`, not the `>` of a heading path: a range and a path are
 * different questions, and `2026-10-20 > 2026-10-22` reads like a heading path
 * with a date as its parent, which it never is.
 *
 * @param {unknown} value - the `file_name` the read tool received.
 * @returns {{from: string, to: string}|undefined} the range, or undefined when the value is not a date query.
 */
export function parseLogDateQuery(value) {
  if (typeof value !== 'string') return undefined
  const parts = splitRange(value)
  // Only a value that at least starts like a date is a log query; anything else
  // falls through to the ordinary file lookup, which reports it better.
  const first = parts[0] ?? ''
  if (parts.length === 1 && !DATE_SHAPE.test(first)) return undefined
  // Once the caller wrote the separator they meant a range, so a half-written one
  // has to be named as such: returning undefined would drop the value into the
  // file lookup and report the query itself as a missing file name.
  const missing = parts.filter((part) => part === '')
  if (missing.length > 0) {
    throw new DocumentError(
      `日志范围要写成 "yyyy-mm-dd..yyyy-mm-dd"，两边都不能空，实际是 ${JSON.stringify(value)}`,
    )
  }
  if (parts.length > 2) {
    throw new DocumentError(`日志只能查一天或一个范围（写成 "yyyy-mm-dd..yyyy-mm-dd"），实际写出了 ${parts.length} 段`)
  }
  const bad = parts.find((part) => !isLogDate(part))
  if (bad !== undefined) {
    throw new DocumentError(`${JSON.stringify(bad)} 不是真实存在的日期，日期要写成 YYYY-MM-DD，例如 2026-10-27`)
  }
  if (parts.length === 1) return { from: parts[0], to: parts[0] }
  return parts[0] <= parts[1] ? { from: parts[0], to: parts[1] } : { from: parts[1], to: parts[0] }
}

/**
 * Split a range query on its separator, trimming each side.
 *
 * Both the date query and the time query accept the same separator, and a
 * heading path hands its levels in already split, so one helper keeps the two
 * in step.
 *
 * @param {string} value - the raw query text.
 * @returns {string[]} the parts, in the caller's order.
 */
function splitRange(value) {
  return value.split(RANGE_SEPARATOR).map((part) => part.trim())
}

/**
 * Read a time query from a heading path: one entry, or a `from..to` range.
 *
 * The path may name the day level (`# 2026-10-27 > ## 19:20 去了杭州`) or start
 * at the entry: the day is not a time, so it is dropped rather than rejected.
 *
 * A range is spelled *inside one heading level*, `19:20..21:00`. Two separate
 * levels are a parent and its child, not two bounds, and reading them as bounds
 * would silently turn "this one entry" into "everything between these hours".
 *
 * Summaries are ignored when a level is read as one entry: an entry is addressed
 * by its hour and minute. Two entries sharing a clock reading are still two
 * entries — `19:20 去了` and `19:20 回来` differ by title — which is why the
 * exact-title fallback in the caller, not this function, decides between them.
 *
 * @param {string[]|undefined} path - the heading path the read tool received.
 * @returns {{from: string, to: string}|undefined} the range, or undefined when the path says nothing about time.
 * @throws {DocumentError} when a spelled-out range has a bound that is not a clock reading.
 */
export function parseLogTimeQuery(path) {
  if (!Array.isArray(path) || path.length === 0) return undefined
  const levels = path
    .map((title) => String(title).trim())
    .filter((title) => title !== '' && !DATE_SHAPE.test(title))
  // A path that is nothing but the day level means "the whole day".
  if (levels.length === 0) return undefined

  const spelled = levels.filter((level) => splitRange(level).length > 1)
  if (spelled.length > 0) {
    if (levels.length !== 1) return undefined
    const parts = splitRange(spelled[0])
    if (parts.length > 2) {
      throw new DocumentError(`时间范围只能写成 "hh:mm..hh:mm"，实际写出了 ${parts.length} 段`)
    }
    const empty = parts.find((part) => part === '')
    if (empty !== undefined) {
      throw new DocumentError(`时间范围两边都要有时刻，例如 "19:20..21:00"，实际是 ${JSON.stringify(spelled[0])}`)
    }
    const bounds = parts.map((part) => parseLogEntryTitle(part)?.time)
    if (bounds.some((time) => time === undefined)) {
      throw new DocumentError(`时间范围两边都要是时分，例如 "19:20..21:00"，实际是 ${JSON.stringify(spelled[0])}`)
    }
    return logMinutes(bounds[0]) <= logMinutes(bounds[1])
      ? { from: bounds[0], to: bounds[1] }
      : { from: bounds[1], to: bounds[0] }
  }

  // Two sibling levels naming two entries is not a range; it is a path that does
  // not exist, and the caller reports that better than a silently widened query.
  if (levels.length > 1) return undefined
  const time = parseLogEntryTitle(levels[0])?.time
  return time === undefined ? undefined : { from: time, to: time }
}

/**
 * Whether one entry title falls inside a time range, inclusive.
 *
 * Both bounds are parsed on every call rather than trusted: a range built by hand
 * with a broken bound would otherwise compare `undefined` against a number,
 * which is always false, and quietly drop every entry of the day.
 *
 * @param {string} title - an entry title such as `19:20 去了杭州`.
 * @param {{from: string, to: string}} range - the range to test.
 * @returns {boolean} whether the title is inside it.
 * @throws {DocumentError} when the range itself is malformed.
 */
export function inTimeRange(title, range) {
  const from = logMinutes(range?.from)
  const to = logMinutes(range?.to)
  if (from === undefined || to === undefined) {
    throw new DocumentError(
      `时间范围不成立：${JSON.stringify(`${range?.from ?? ''}..${range?.to ?? ''}`)}，两边都要写成 hh:mm`,
    )
  }
  const time = parseLogEntryTitle(title)?.time
  const minutes = logMinutes(time)
  return minutes !== undefined && minutes >= Math.min(from, to) && minutes <= Math.max(from, to)
}

/**
 * Sort entry titles chronologically, keeping the input stable on ties.
 * @param {string[]} titles - entry titles.
 * @returns {string[]} the sorted titles.
 */
export function sortLogTitles(titles) {
  const minutesOf = (title) => {
    const time = parseLogEntryTitle(title)?.time
    return time === undefined ? 0 : logMinutes(time)
  }
  return [...titles].sort((a, b) => minutesOf(a) - minutesOf(b))
}

/**
 * Reject a summary longer than the configured limit.
 * @param {string} text - the summary stored in one entry title.
 * @param {number} maxChars - the configured limit, in code points.
 * @returns {void}
 * @throws {DocumentError} when the text is too long.
 */
export function assertSummaryLength(text, maxChars) {
  const length = Array.from(text).length
  if (length <= maxChars) return
  throw new DocumentError(
    `日志摘要最多 ${maxChars} 字，当前 ${length} 字。摘要只写在二级标题里，细节写进 new_string 的正文`,
  )
}

/**
 * The fixed update rules for log files, as the edit tool states them.
 *
 * They are not per-file metadata: a log is machine-shaped, so every log file
 * follows the same rules and the model should never have to look them up.
 *
 * @param {number} maxChars - the configured summary limit.
 * @returns {string} the description block.
 */
export function logRules(maxChars) {
  return [
    '日志文件（file_name 是日期）的写法：',
    '- 写之前必须先取一次当前时间：file_name 的日期、heading_path 里的 hh:mm 都用它，不要凭印象或沿用上一轮的时间。',
    '- heading_path 写成 "# yyyy-mm-dd > ## hh:mm 摘要"：一级是当天日期，和 file_name 相同；二级是时分加一句摘要。',
    `- 摘要最多 ${maxChars} 字，写在二级标题里；细节写进 new_string，长度不限。`,
    '- 写之前先 memory_read 读那一天，即使当天还没有内容。',
    '- new_string 和 old_string 的开头不能是 "#"（会被当成标题行）；中间和后面几行可以。日志标题不能改名、不能删除。',
    '- 关键词加在二级标题上，一级标题没有。正文里出现的人、项目、标签，建议顺手加上关键词。',
  ].join('\n')
}

/**
 * The read-side rules for log files, as the read tool states them.
 * @returns {string} the description block.
 */
export function logReadRules() {
  return [
    '读日志：file_name 传 "yyyy-mm-dd" 读一天，传 "yyyy-mm-dd..yyyy-mm-dd" 读连续几天。',
    'heading_path 传 "hh:mm" 只读那个时间点，传 "hh:mm..hh:mm" 读这段时间；查多天时，每一天都按这个时间段筛。',
    '日志不出现在文件清单里。',
  ].join('\n')
}
