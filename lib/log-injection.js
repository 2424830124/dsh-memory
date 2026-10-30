/**
 * Prompt log selection: discard empty days, keep the newest configured window,
 * and mark which selected days retain their full detail.
 *
 * Input files must already be ordered oldest to newest. `MemoryRuntime.logFilesOf`
 * owns scope precedence and ordering; this module owns the log-specific injection
 * policy so that policy can be tested independently of session coordination.
 *
 * @module dsh-memory/log-injection
 */

import { logEntries } from './log.js'

/**
 * Select the non-empty log days that belong in one scope's prompt window.
 *
 * @param {{directory: string, document: import('./model.js').MemoryDocument}[]} files - ascending log files.
 * @param {{days: number, detailDays: number}} rule - day and detail budgets.
 * @returns {{directory: string, document: import('./model.js').MemoryDocument, detail: boolean}[]} selected days, oldest first.
 */
export function selectLogInjection(files, rule) {
  const days = Math.max(0, Math.trunc(rule.days))
  if (days === 0) return []

  // Empty days do not consume the budget: a freshly initialized log file must
  // not push an older day with actual content out of the prompt.
  const filled = files.filter(({ document }) => logEntries(document).length > 0)
  const newest = filled.slice(-days)
  const detail = Math.min(newest.length, Math.max(0, Math.trunc(rule.detailDays)))
  const firstDetailed = newest.length - detail

  return newest.map((file, index) => ({
    ...file,
    detail: index >= firstDetailed,
  }))
}
