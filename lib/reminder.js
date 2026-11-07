/**
 * The every-N-turns reminder.
 *
 * The user writes one piece of text and a turn interval. On every Nth real user
 * message the host's `agent/pre-step` waterfall hands over the messages a step
 * is about to commit, and this module places a plugin-authored message directly
 * after the user's own, so the model reads the reminder in the same request
 * while everything the human typed stays exactly as it was.
 *
 * Nothing here touches the system prompt. The counter rides on the conversation
 * instead of the request header, which is the whole point: the frozen injection
 * exists to protect the provider's cached prefix, and a reminder that rewrote
 * the prompt would cut that prefix on every occurrence.
 *
 * @module dsh-memory/reminder
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeAtomic } from './atomic.js'

/** State subdirectory holding one counter file per session. */
export const REMINDER_DIR_NAME = 'reminder'

/**
 * Source kind stamped on every reminder message.
 *
 * `plugin:<name>` is the producer-owned form the host requires of a plugin that
 * authors a message of its own; the runtime recognises its own messages by it,
 * exactly like a memory notice carries {@link NOTICE_SOURCE_KIND}.
 */
export const REMINDER_SOURCE_KIND = 'plugin:dsh-memory'

/** Tag wrapping the reminder body, so the model can tell it from real input. */
export const REMINDER_TAG = 'memory_reminder'

/** Shape version of the counter file. */
const STATE_VERSION = 1

/**
 * Path of one session's reminder counter.
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {string} the absolute file path.
 */
export function reminderStatePath(stateDir, sessionId) {
  return join(stateDir, REMINDER_DIR_NAME, `${sessionId}.json`)
}

/**
 * Read how many user messages this session has counted so far.
 *
 * A missing file, a corrupt one, or a nonsense value all mean the same thing:
 * start counting from zero. The file is bookkeeping, never a source of truth a
 * turn should fail over.
 *
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {Promise<number>} the number of turns counted so far.
 */
export async function readReminderTurns(stateDir, sessionId) {
  try {
    const parsed = JSON.parse(await readFile(reminderStatePath(stateDir, sessionId), 'utf8'))
    const turns = parsed?.turns
    return typeof turns === 'number' && Number.isFinite(turns) && turns > 0 ? Math.trunc(turns) : 0
  } catch {
    return 0
  }
}

/**
 * Persist one session's turn count.
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @param {number} turns - the count to record.
 * @returns {Promise<void>} completion.
 */
export async function writeReminderTurns(stateDir, sessionId, turns) {
  const path = reminderStatePath(stateDir, sessionId)
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, JSON.stringify({ version: STATE_VERSION, turns }, null, 2))
}

/**
 * Count the real user messages in one step.
 *
 * Only `source.kind === 'user'` counts: a scheduled message, a notice, or a
 * plugin-authored context message is not something the human sent, and the
 * interval the user typed is about their own turns.
 *
 * @param {unknown} messages - the messages a step is about to commit.
 * @returns {number} how many of them are user input.
 */
export function countUserMessages(messages) {
  if (!Array.isArray(messages)) return 0
  let count = 0
  for (const message of messages) {
    if (message?.source?.kind === 'user') count += 1
  }
  return count
}

/**
 * Decide whether the turn that just landed is a reminder turn.
 *
 * A step may carry several user messages at once, so the test is "did a
 * multiple of `every` fall inside this step", not "is the new total a
 * multiple": with `every = 3`, going from 2 turns to 4 must still fire once.
 *
 * @param {number} previousTurns - the count before this step.
 * @param {number} turns - the count after this step.
 * @param {number} every - the configured interval; `<= 0` means off.
 * @returns {boolean} whether this step owes the model a reminder.
 */
export function reminderDue(previousTurns, turns, every) {
  if (!Number.isFinite(every) || every <= 0) return false
  if (!Number.isFinite(turns) || turns <= previousTurns) return false
  return Math.floor(turns / every) > Math.floor(previousTurns / every)
}

/**
 * Render the body the model reads.
 * @param {string} text - what the user configured.
 * @param {number} turns - the turn count the reminder landed on.
 * @returns {string} the tagged body.
 */
export function renderReminder(text, turns) {
  return [
    `<${REMINDER_TAG}>`,
    `第 ${turns} 轮。这是用户提前设置好的提示，不是新的请求。`,
    '',
    text,
    `</${REMINDER_TAG}>`,
  ].join('\n')
}

/**
 * One plugin-authored user-role message carrying the reminder.
 * @param {object} options - message contents.
 * @param {string} options.text - what the user configured.
 * @param {number} options.turns - the turn count it landed on.
 * @param {string} [options.id] - identity to use; defaults to a fresh one.
 * @returns {object} the message to place beside the user's own.
 */
export function reminderMessage({ text, turns, id = randomUUID() }) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: renderReminder(text, turns) }],
    source: { kind: REMINDER_SOURCE_KIND, form: 'notice', summary: `第 ${turns} 轮提示` },
  }
}

/**
 * Place the reminder directly after the last user message of the step.
 *
 * After, not before: the model reads the batch in order, so the reminder ends up
 * as the last thing it sees about what it was asked, which is where a nudge
 * belongs. Steps with no user message cannot happen (the runtime only calls this
 * once it counted one), but falling back to the end keeps that harmless.
 *
 * @param {object[]} messages - the messages the step is about to commit.
 * @param {object} reminder - the message to insert.
 * @returns {object[]} a new array; the input is not touched.
 */
export function withReminder(messages, reminder) {
  const next = [...messages]
  let insertAt = next.length
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.source?.kind === 'user') {
      insertAt = index + 1
      break
    }
  }
  next.splice(insertAt, 0, reminder)
  return next
}
