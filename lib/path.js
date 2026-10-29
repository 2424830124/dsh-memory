/**
 * Heading paths: how the model spells them and how the plugin reads them back.
 *
 * A path is written the way it reads in the file — `"# 2026-10-27 > ## 21:30"` —
 * so the model copies a line it has already seen instead of assembling a nested
 * array. The bare-title form is accepted as well, so a model that leaves the
 * marks out still resolves instead of failing on a lookup it cannot see.
 *
 * @module dsh-memory/path
 */

import { DocumentError } from './errors.js'

/** Separator between heading titles in a rendered path. */
export const PATH_SEPARATOR = ' > '

/**
 * Spell a heading path with the `#` prefixes the model sees.
 * @param {string[]} path - heading titles from the top level down.
 * @returns {string} a label such as `# a > ## b`.
 */
export function headingLabel(path) {
  return path.map((title, index) => `${'#'.repeat(index + 1)} ${title}`).join(PATH_SEPARATOR)
}

/**
 * Strip the addressing punctuation from one path segment.
 * @param {unknown} segment - one path segment.
 * @returns {string} the bare title.
 */
function normalizeSegment(segment) {
  const text = String(segment).trim()
  const match = /^#+\s*(.*)$/.exec(text)
  return (match === null ? text : match[1]).trim()
}

/**
 * Normalize a whole heading path.
 * @param {unknown} entries - the caller's `heading_path`.
 * @returns {string[]} bare titles from the top level down.
 * @throws {DocumentError} when the marks are inconsistent or out of order.
 */
export function normalizeHeadingPath(entries) {
  const segments = typeof entries === 'string' ? entries.split('>') : Array.isArray(entries) ? entries : []
  const titles = segments.map((segment) => String(segment).trim()).filter((segment) => segment !== '')
  const marks = titles.map((title) => /^(#+)\s*\S/.exec(title)?.[1].length ?? 0)

  const marked = marks.filter((count) => count > 0).length
  if (marked > 0 && marked < titles.length) {
    const index = marks.findIndex((count) => count === 0)
    throw new DocumentError(
      `heading_path 里 ${JSON.stringify(titles[index])} 没带 #，标题路径要么每段都带，要么都不带`,
      titles.join(PATH_SEPARATOR),
    )
  }
  marks.forEach((count, index) => {
    if (count === 0 || count === index + 1) return
    throw new DocumentError(
      `heading_path 第 ${index + 1} 段是 ${JSON.stringify(titles[index])}，"#" 的个数应该是 ${index + 1}`,
      titles.join(PATH_SEPARATOR),
    )
  })
  return titles.map(normalizeSegment)
}
