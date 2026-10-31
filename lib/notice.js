/**
 * Rendering of cross-session change notices.
 *
 * A notice is a user-role message injected without waking the session, so it has
 * to be short, unambiguous, and say *who* did it. Every notice is wrapped in a
 * single tag so the model can tell it apart from real user input.
 *
 * The diff itself lives in {@link module:dsh-memory/snapshot}: what counts as a
 * change is a property of the fingerprints, not of the wording.
 *
 * @module dsh-memory/notice
 */

import { headingLabel } from './path.js'

/** Source kind stamped on every memory notice, so the runtime can recognise its own. */
export const NOTICE_SOURCE_KIND = 'memory'

/** Human labels per change kind, used in the rendered notice. */
const CHANGE_LABELS = {
  added: '别的会话新增',
  updated: '别的会话更新',
  removed: '别的会话删除',
  renamed: '别的会话改名',
  file: '别的会话改了这份文件的元数据',
  deleted: '别的会话删掉了这份文件',
}

/**
 * One change to one heading.
 * @typedef {object} SectionChange
 * @property {string[]} path - the heading path, empty for a file-level change.
 * @property {'added'|'updated'|'removed'|'renamed'|'file'|'deleted'} kind - what happened to it.
 * @property {string[]} [from] - the old heading path, for a rename.
 */

/**
 * Changes grouped per file.
 * @typedef {object} FileUpdate
 * @property {string} fileName - `meta_data.file_name`.
 * @property {string} scope - `Global` or `Workspace`.
 * @property {SectionChange[]} changes - the changes to report.
 */

/**
 * Render one change as a single notice line.
 * @param {FileUpdate} update - the file the change belongs to.
 * @param {SectionChange} change - the change.
 * @returns {string} the line, without its bullet.
 */
function changeLine(update, change) {
  const label = CHANGE_LABELS[change.kind] ?? change.kind
  const where = `${update.scope}/${update.fileName}`
  if (change.kind === 'file') return `${where}: 这份文件本身（${label}）`
  if (change.kind === 'deleted') return `${where}: 整份文件（${label}）`
  if (change.kind === 'renamed') return `${where}: ${headingLabel(change.path)}（${label}，原来叫 ${headingLabel(change.from ?? [])}）`
  return `${where}: ${headingLabel(change.path)}（${label}）`
}

/**
 * Render the notice body for a batch of changes.
 *
 * Updates whose change list came out empty are skipped rather than rendered: an
 * empty `<memory_update>` block tells the model that something changed while
 * showing it nothing, which is worse than staying silent.
 *
 * @param {FileUpdate[]} updates - grouped changes.
 * @returns {string|undefined} the message text, or `undefined` when there is nothing to say.
 */
export function renderNotice(updates) {
  const lines = [
    '<memory_update>',
    '别的会话修改了记忆，以下是你上次看到之后变化的部分。需要细节时用 memory_read 读取。',
    '',
  ]
  let changes = 0
  for (const update of updates) {
    for (const change of update.changes ?? []) {
      lines.push(`- ${changeLine(update, change)}`)
      changes += 1
    }
  }
  // Nothing between the opening lines and the closing tag means nothing to say.
  if (changes === 0) return undefined
  lines.push('</memory_update>')
  return lines.join('\n')
}

/**
 * Render the notice body for files that failed to parse.
 * @param {{path: string, error: string}[]} broken - broken files.
 * @returns {string|undefined} the message text, or `undefined` when nothing is broken.
 */
export function renderBrokenNotice(broken) {
  if (!Array.isArray(broken) || broken.length === 0) return undefined
  const lines = ['<memory_broken>', '记忆文件解析失败，已跳过注入。请修复或删除该文件。', '']
  for (const file of broken) lines.push(`路径: ${file.path}`, `错误: ${file.error}`, '')
  if (lines.at(-1) === '') lines.pop()
  lines.push('</memory_broken>')
  return lines.join('\n')
}
