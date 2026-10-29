/**
 * Model-facing rendering of memory documents.
 *
 * Three renderers exist and they differ only in policy:
 *
 * - {@link renderInjection} honors `inject_ignore`: it is the standing view in
 *   the system prompt, so what it carries is what the user chose to spend
 *   context on, per heading level if they want.
 * - {@link renderRead} ignores `inject_ignore` and always shows everything: it is
 *   view the model copies an `old_string` out of, so it must match what the edit
 *   tool compares against character for character.
 * - {@link renderFileList} is the "you have no name" answer.
 *
 * The shared policy is a small object, not a boolean pile, so a future view can
 * add one field instead of another parameter.
 *
 * @module dsh-memory/render
 */

import { logEntries } from './log.js'
import { MAX_DEPTH } from './model.js'
import { findNode } from './tree.js'

/** Marks the injected memory block. */
const INJECTION_OPEN = '<memory>'
/** Closes the injected memory block. */
const INJECTION_CLOSE = '</memory>'
/**
 * 记忆文件是「我」的口吻写的，提示词其余部分是第二人称且是英文。这句放在标签
 * 之前，用提示词自己的语言把归属点明，标签就只管边界。
 */
const INJECTION_PREAMBLE = 'The following is your own long-term memory.'

/** Render a document with nothing suppressed: the read view. */
const READ = Object.freeze({ injectIgnore: Object.freeze([]), logStyle: false })
/** Render a log the way its own shape reads: the date heading carries no metadata. */
const LOG_READ = Object.freeze({ injectIgnore: Object.freeze([]), logStyle: true })

/**
 * What a log group header calls itself.
 *
 * A group covers several days, so a concrete date there would claim the whole
 * group is that day. It is the technical name, not a Chinese one: memory files
 * are named freely, and any Chinese label could be taken by a real file later.
 */
const LOG_KIND = 'log'

/**
 * Render policy for one view.
 * @typedef {object} RenderPolicy
 * @property {string[]} injectIgnore - suppression list; empty for a read.
 * @property {boolean} logStyle - whether the top heading is a bare date.
 */

/**
 * Render the metadata lines of one heading, in the order the model reads them.
 *
 * Each line is prefixed so it can never be mistaken for body text: a body line
 * that starts with `- Keyword:` is still possible in principle, but nothing in
 * the tool contract ever tells the model to copy a metadata line into
 * `old_string`.
 *
 * @param {import('./model.js').MemoryNode} node - the heading.
 * @param {number} depth - the heading's level, from 1.
 * @param {RenderPolicy} policy - rendering policy.
 * @param {string[]} out - the accumulator to append to.
 * @returns {void}
 */
function renderMeta(node, depth, policy, out) {
  if (!isSuppressed(policy.injectIgnore, depth, 'keyword') && node.keyword.length > 0) {
    out.push(`- Keyword: ${node.keyword.join(', ')}`)
  }
  if (!isSuppressed(policy.injectIgnore, depth, 'update_at') && node.update_at !== '') {
    out.push(`- Update at: ${node.update_at}`)
  }
}

/**
 * Whether one aspect of a heading level is suppressed by `inject_ignore`.
 * @param {string[]} injectIgnore - the file's suppression list.
 * @param {number} depth - the heading's level, from 1.
 * @param {'desc'|'keyword'} aspect - the part of the heading to test.
 * @returns {boolean} whether that part must not be injected.
 */
function isSuppressed(injectIgnore, depth, aspect) {
  return injectIgnore.includes(aspect) || injectIgnore.includes(`t${depth}.${aspect}`)
}

/**
 * Render a heading subtree for one consumer.
 *
 * Bodies are stored without leading or trailing blank lines; the blank line that
 * makes the output readable is added here, before every heading. That way the
 * text a model copies back as `old_string` stays tight, while what it sees is
 * spaced like the document a person would write.
 *
 * @param {Map<string, import('./model.js').MemoryNode>} level - headings at this level.
 * @param {number} depth - the depth of those headings, from 1.
 * @param {RenderPolicy} policy - rendering policy.
 * @param {string[]} [out] - the accumulator to append to.
 * @returns {string[]} rendered lines.
 */
function renderLevel(level, depth, policy, out = []) {
  if (depth > MAX_DEPTH) return out
  if (policy.injectIgnore.includes(`t${depth}`)) return out
  for (const [title, node] of level) renderNode(title, node, depth, policy, out)
  return out
}

/**
 * Render one heading and its subtree into `out`.
 * @param {string} title - the heading title.
 * @param {import('./model.js').MemoryNode} node - the heading.
 * @param {number} depth - the heading's level, from 1.
 * @param {RenderPolicy} policy - rendering policy.
 * @param {string[]} out - the accumulator to append to.
 * @returns {void}
 */
function renderNode(title, node, depth, policy, out) {
  if (out.length > 0) out.push('')
  out.push(`${'#'.repeat(depth)} ${title}`)
  // A log's date heading exists only to group the entries under it: its own
  // timestamps and body would be noise the model never edits.
  if (policy.logStyle && depth === 1) {
    renderLevel(node.children, depth + 1, policy, out)
    return
  }
  renderMeta(node, depth, policy, out)
  if (!isSuppressed(policy.injectIgnore, depth, 'desc') && node.desc !== '') out.push(node.desc)
  renderLevel(node.children, depth + 1, policy, out)
}

/**
 * Render the front-matter header that identifies one memory file.
 *
 * A log leaves `file_name` out: its date heading already carries that, and the
 * two lines would only repeat each other. It says `kind: log` instead, which no
 * memory file can be called.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to describe.
 * @param {object} [options] - which lines to include.
 * @param {string} [options.kind] - label the header with a kind instead of a file name.
 * @param {boolean} [options.showFileName] - include the `file_name` line.
 * @param {boolean} [options.showScope] - include the scope line.
 * @param {boolean} [options.showFormat] - include the file's `format` rules.
 * @returns {string[]} rendered lines.
 */
function renderHeader(document, options = {}) {
  const lines = ['---']
  if (options.kind !== undefined) lines.push(`kind: ${options.kind}`)
  else if (options.showFileName !== false) lines.push(`file_name: ${document.fileName}`)
  if (document.desc !== '') lines.push(`desc: ${document.desc}`)
  if (options.showScope === true) lines.push(`scope: ${document.scope}`)
  if (options.showFormat === true && document.format !== '') {
    lines.push('format: |')
    for (const line of document.format.split('\n')) lines.push(line === '' ? '' : `  ${line}`)
  }
  lines.push('---')
  return lines
}

/**
 * Render one day of log entries for prompt injection.
 *
 * Injection is opt-in: a day of entries would otherwise crowd out the long-term
 * notes they sit next to. The title already carries the summary worth keeping, so
 * an entry's body is left out unless `includeDetail` asks for it.
 *
 * @param {import('./model.js').MemoryDocument} document - the log to render.
 * @param {object} [options] - rendering limits.
 * @param {boolean} [options.enabled] - whether logs may be injected at all.
 * @param {number} [options.maxEntries] - keep at most this many entries, newest kept.
 * @param {boolean} [options.includeDetail] - also render each entry's body, indented.
 * @returns {string} the injected block, or `''` when there is nothing to inject.
 */
export function renderLog(document, options = {}) {
  if (options.enabled !== true) return ''

  const entries = logEntries(document)
  if (entries.length === 0) return ''

  const maxEntries = options.maxEntries ?? 0
  const kept = maxEntries > 0 && entries.length > maxEntries ? entries.slice(-maxEntries) : entries

  // 日期写成一级标题：它就是这份日志的 file_name，也是写条目时 heading_path 的第一段。
  // 条目写成二级标题，和落盘的形状一致 —— 注入里看到的层级就是文件里的层级。
  const lines = [`# ${document.fileName}`]
  for (const [title, entry] of kept) {
    // 摘要长度在写入时就按 logSummaryMaxChars 卡住了，注入时不再截一次：
    // 两处上限只会让人对不上「为什么这里少了几个字」。
    lines.push('', `## ${title}`)
    if (options.includeDetail === true && entry.desc !== '') {
      for (const line of entry.desc.split('\n')) lines.push(line)
    }
  }

  const omitted = entries.length - kept.length
  if (omitted > 0) lines.push('', `（还有 ${omitted} 条更早的没显示）`)

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Render every file for prompt injection.
 *
 * The header carries `scope`: the same file name can exist as a global and as a
 * workspace copy, and the injection shows both.
 *
 * @param {import('./model.js').MemoryDocument[]} documents - documents to inject, in order.
 * @param {object} [options] - log injection limits, see {@link renderLog}.
 * @param {boolean} [options.enabled] - whether logs may be injected at all.
 * @param {number} [options.maxEntries] - keep at most this many entries per day.
 * @param {(document: import('./model.js').MemoryDocument) => boolean} [options.hasDetail]
 *   - whether one day keeps its body; the days without it render as summary lines only.
 * @param {boolean} [options.framed] - wrap the result in the preamble and the `<memory>`
 *   markers (default). The panel turns this off: it shows what the model reads, not the
 *   framing it already knows about.
 * @returns {string} the complete injection text, or `''` when there is nothing to inject.
 */
export function renderInjection(documents, options = {}) {
  const blocks = []
  for (const document of documents) {
    if (document.kind === 'log') continue
    const policy = { injectIgnore: document.injectIgnore, logStyle: false }
    const block = renderLevel(document.roots, 1, policy, renderHeader(document, { showScope: true })).join('\n')
    if (block !== '') blocks.push(block)
  }

  // 日志按作用域分组，每组一个文件头：全局和工作区各是独立的一份，
  // 同一天在两个作用域都写了的时候，光看日期分不出是哪个。
  const groups = new Map()
  for (const document of documents) {
    if (document.kind !== 'log') continue
    const day = renderLog(document, {
      enabled: options.enabled,
      maxEntries: options.maxEntries,
      includeDetail: options.hasDetail?.(document) === true,
    })
    if (day === '') continue
    const group = groups.get(document.scope) ?? { first: document, days: [] }
    group.days.push(day)
    groups.set(document.scope, group)
  }
  for (const group of groups.values()) {
    // `desc` 由作用域写死，同组每一天都相同，取第一天即可。
    // 组头带 `kind: log`，不带 `file_name`：一个头管好几天，写具体日期就等于说这组都是那一天。
    const lines = renderHeader(group.first, { showScope: true, kind: LOG_KIND })
    lines.push('')
    for (const [index, day] of group.days.entries()) {
      if (index > 0) lines.push('')
      lines.push(day)
    }
    blocks.push(lines.join('\n'))
  }

  if (blocks.length === 0) return ''
  const body = blocks.join('\n\n')
  // 归属句和标记是给模型的封装，面板里要看的是封装里面的东西。
  if (options.framed === false) return body
  return [INJECTION_PREAMBLE, INJECTION_OPEN, body, INJECTION_CLOSE].join('\n\n')
}

/**
 * Render one document, or one heading subtree, for the read tool.
 *
 * The header carries `scope` so a model that edited a workspace copy and a
 * global copy of the same file can tell which one it is looking at now.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to render.
 * @param {string[]} [path] - heading path; omit to render the whole document.
 * @returns {string} the rendered text.
 */
export function renderRead(document, path) {
  const log = document.kind === 'log'
  const lines = renderHeader(document, { showScope: true, showFileName: !log })
  const policy = log ? LOG_READ : READ
  if (path === undefined || path.length === 0) {
    return renderLevel(document.roots, 1, policy, lines).join('\n')
  }
  const node = findNode(document, path)
  if (node === undefined) return lines.join('\n')
  renderNode(path.at(-1), node, path.length, policy, lines)
  return lines.join('\n')
}

/**
 * Render several days of logs as one answer, newest last.
 *
 * One header for the whole range, then a `---` between days: repeating the
 * front matter per day would spend more lines on bookkeeping than on entries.
 *
 * @param {import('./model.js').MemoryDocument[]} documents - the days to render, in order.
 * @returns {string} the rendered text, or `''` when there is nothing to render.
 */
export function renderLogRange(documents) {
  if (documents.length === 0) return ''
  const lines = renderHeader(documents[0], { showScope: true, showFileName: false })
  for (const [index, document] of documents.entries()) {
    if (index > 0) lines.push('', '---')
    renderLevel(document.roots, 1, LOG_READ, lines)
  }
  return lines.join('\n')
}

/**
 * Render the file list returned when the read tool is called without a file name.
 * @param {import('./model.js').MemoryDocument[]} documents - documents to list.
 * @returns {string} the rendered list.
 */
export function renderFileList(documents) {
  if (documents.length === 0) return '（还没有任何记忆文件）'
  const lines = []
  for (const document of documents) {
    lines.push(`- ${document.fileName} [${document.scope}]`)
    if (document.desc !== '') lines.push(`  ${document.desc}`)
  }
  return lines.join('\n')
}

/**
 * Render every file's `format` block, used in the edit tool's description.
 * @param {{fileName: string, scope: string, format: string}[]} entries - one entry per file.
 * @returns {string} the rendered block.
 */
export function renderFormats(entries) {
  if (entries.length === 0) return '（还没有任何记忆文件，先用 memory_manage 新建）'
  const lines = []
  for (const entry of entries) {
    lines.push(`[${entry.scope}] ${entry.fileName}:`)
    if (entry.format.trim() === '') lines.push('  （这个文件没有声明 format）')
    else for (const line of entry.format.split('\n')) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}
