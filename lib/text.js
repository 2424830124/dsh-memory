/**
 * Text normalization.
 *
 * Two shapes are normalized for two different consumers, and mixing them up is
 * the one mistake that breaks `memory_edit`:
 *
 * - A whole heading body is stored *tight*: no leading blank line, no trailing
 *   blank line, no run of two blank lines. {@link normalizeBody} does that.
 * - A search or replacement fragment keeps its extent: an `old_string` ending in
 *   a newline must still end in one, or the replacement lands a line short.
 *   {@link normalizeFragment} only strips trailing whitespace per line.
 *
 * The tool hands the model exactly the stored text, so an `old_string` the model
 * copied out of a read always matches character for character.
 *
 * @module dsh-memory/text
 */

/**
 * Split text into lines, with every line ending spelled as `\n`.
 * @param {string} text - the text to split.
 * @returns {string[]} the lines.
 */
function splitLines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

/**
 * Normalize a whole heading body: strip trailing whitespace from every line,
 * collapse blank-line runs to one, and drop blank lines at both ends.
 * @param {unknown} value - raw heading body.
 * @returns {string} the normalized body.
 */
export function normalizeBody(value) {
  if (typeof value !== 'string') return ''
  const collapsed = []
  for (const line of splitLines(value)) {
    const trimmed = line.replace(/[ \t]+$/, '')
    if (trimmed === '' && (collapsed.length === 0 || collapsed.at(-1) === '')) continue
    collapsed.push(trimmed)
  }
  while (collapsed.length > 0 && collapsed.at(-1) === '') collapsed.pop()
  return collapsed.join('\n')
}

/**
 * Normalize a fragment without changing its extent.
 * @param {unknown} value - the caller's `old_string` or `new_string`.
 * @returns {string} the normalized fragment.
 */
export function normalizeFragment(value) {
  if (typeof value !== 'string') return ''
  return splitLines(value).map((line) => line.replace(/[ \t]+$/, '')).join('\n')
}

/**
 * Normalize a single-line metadata field: trimmed, with internal newlines folded
 * to spaces so it stays a YAML scalar.
 * @param {unknown} value - candidate metadata value.
 * @returns {string} the normalized string.
 */
export function normalizeMetaLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Normalize a multiline metadata field, keeping paragraph structure.
 * @param {unknown} value - candidate metadata value.
 * @returns {string} the normalized string.
 */
export function normalizeMetaBlock(value) {
  return typeof value === 'string' ? normalizeBody(value) : ''
}

/**
 * Format one moment the way a memory file stores `update_at`.
 *
 * The value is local wall-clock time with an explicit offset, e.g.
 * `2026-10-27T03:18:36+08:00`. Three properties matter and each rules out an
 * obvious alternative:
 *
 * - `toISOString()` is UTC, so on a UTC+8 machine every stamp read as eight
 *   hours earlier than the clock the user sees - in prompts and in the panel.
 * - A bare local string (`2026-10-27T03:18:36`) drops the offset, so an entry
 *   written in another time zone could not be compared with a local one.
 * - Milliseconds are omitted: nothing reads them, and they make every line
 *   longer without making it more useful.
 *
 * @param {Date} [date] - the moment to format; defaults to now.
 * @returns {string} the local timestamp, offset included.
 */
export function localTimestamp(date = new Date()) {
  const pad = (value) => String(Math.abs(value)).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const hours = Math.trunc(offset / 60)
  const minutes = offset % 60
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(hours)}:${pad(minutes)}`
  )
}
