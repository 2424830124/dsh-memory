/**
 * Per-session snapshots, kept on disk.
 *
 * One file per session holds three separate things, because they change for
 * different reasons and each one has a different cost when it moves:
 *
 * 1. `files` — which version of which heading the session has already been told
 *    about. Rewritten on every delivery.
 * 2. `injected` — the exact prompt text the session was opened with, plus the
 *    log files it was built from. Written once and never again for that session.
 * 3. `tools` — the `memory_edit` description the session was opened with. Also
 *    written once.
 *
 * Items 2 and 3 are frozen on purpose: both sit at the front of the request
 * prefix, so re-rendering them on every file change would invalidate the
 * provider's prefix cache each time. A file that changes while a session is open
 * is announced by a notice instead, and reaches the prompt on the next session.
 *
 * @module dsh-memory/snapshot
 */

import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeAtomic } from './atomic.js'
import { shortHash } from './hash.js'
import { walk } from './tree.js'

/**
 * Snapshot format version; a snapshot from another version is ignored.
 *
 * Bumped to 4 when the frozen prompt text and tool description joined the file:
 * a version-3 snapshot has no frozen text, so its session would silently pick up
 * a new prompt prefix on the next assembly — exactly what the freeze is for.
 */
const SNAPSHOT_VERSION = 4

/**
 * One file's fingerprint inside a snapshot.
 * @typedef {object} FileSnapshot
 * @property {string} hash - short hash of the whole file text.
 * @property {Record<string, string>} sections - heading-path key → short hash.
 */

/**
 * The prompt text one session was opened with.
 *
 * Frozen at attach time, together with the keys of the log files it was built
 * from. `logKeys` travels with the text so a later change to the log-day config
 * cannot retroactively alter what an existing session is compared against: the
 * session keeps the days it actually saw.
 *
 * @typedef {object} FrozenInjection
 * @property {string} text - the rendered memory block.
 * @property {string[]} logKeys - snapshot keys of the log files it included.
 */

/**
 * One stored snapshot.
 * @typedef {object} SessionSnapshot
 * @property {Record<string, FileSnapshot>} files - the delivery baseline.
 * @property {FrozenInjection} [injected] - frozen prompt text, once frozen.
 * @property {string} [tools] - frozen `memory_edit` description.
 * @property {string} [updatedAt] - last activity, as an ISO timestamp.
 */

/**
 * One reported change inside a file.
 *
 * `path` is the heading the change is about, and is empty when the change is
 * about the file itself rather than one heading.
 *
 * @typedef {object} SectionChange
 * @property {string[]} path - heading titles, or empty for a file-level change.
 * @property {'added'|'updated'|'removed'|'renamed'|'file'} kind - what happened.
 * @property {string[]} [from] - the old heading path, for a rename.
 */

/** Hash of a heading that carries neither a body nor keywords. */
const EMPTY_SECTION_HASH = shortHash(JSON.stringify(['', '']))

/**
 * Key used to store heading paths in the fingerprint map.
 * @param {string[]} path - heading titles.
 * @returns {string} the map key.
 */
function pathKey(path) {
  return path.join('\u0000')
}

/**
 * Compute the per-heading fingerprint map of one document.
 *
 * The key is the full heading path, because that is how the model addresses a
 * heading. A rename therefore changes the key, which {@link diffSections} knows
 * how to report as one rename instead of a subtree of deletions and additions.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to fingerprint.
 * @returns {Record<string, string>} heading path key → short hash.
 */
export function headingHashes(document) {
  const hashes = {}
  for (const { path, node } of walk(document)) {
    hashes[pathKey(path)] = shortHash(JSON.stringify([node.desc, node.keyword]))
  }
  return hashes
}

/**
 * Compute the snapshot entry for one document.
 * @param {import('./model.js').MemoryDocument} document - the document.
 * @returns {FileSnapshot} the entry.
 */
export function snapshotEntry(document) {
  return { hash: shortHash(document.source), sections: headingHashes(document) }
}

/**
 * Whether one heading path sits at or below a prefix.
 * @param {string[]} path - the heading path.
 * @param {string[]} prefix - the prefix to test.
 * @returns {boolean} whether the path is under the prefix.
 */
function underPath(path, prefix) {
  return path.length >= prefix.length && prefix.every((title, index) => path[index] === title)
}

/**
 * The position where two paths of equal length first disagree.
 * @param {string[]} left - one path.
 * @param {string[]} right - the other path.
 * @returns {number} the index, or `-1` when they differ in more than one place.
 */
function soleDifference(left, right) {
  if (left.length !== right.length) return -1
  let found = -1
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    if (found !== -1) return -1
    found = index
  }
  return found
}

/**
 * Whether a pair of paths is best explained as one renamed heading.
 *
 * A single moved heading is indistinguishable from a deletion plus an unrelated
 * addition, so a rename is only claimed when the heading's own content came
 * along (`before`/`after` agree on a non-empty fingerprint) or when a whole
 * subtree moved — every heading below the old title reappears below the new one.
 *
 * @param {string[]} fromPath - the old heading path.
 * @param {string[]} toPath - the new heading path.
 * @param {string[][]} removedPaths - every heading that disappeared.
 * @param {string[][]} addedPaths - every heading that appeared.
 * @param {Record<string, string>} before - the previous fingerprint map.
 * @param {Record<string, string>} after - the current fingerprint map.
 * @returns {boolean} whether this is a rename.
 */
function looksRenamed(fromPath, toPath, removedPaths, addedPaths, before, after) {
  const previous = before[pathKey(fromPath)]
  const current = after[pathKey(toPath)]
  if (previous !== undefined && previous === current && previous !== EMPTY_SECTION_HASH) return true
  const moved = removedPaths.filter((path) => underPath(path, fromPath))
  if (moved.length < 2) return false
  const departed = new Set(moved.map((path) => pathKey(path.slice(fromPath.length))))
  const arrived = new Set(
    addedPaths.filter((path) => underPath(path, toPath)).map((path) => pathKey(path.slice(toPath.length))),
  )
  if (departed.size !== arrived.size) return false
  return [...departed].every((path) => arrived.has(path))
}

/**
 * Compare two heading fingerprint maps.
 *
 * @param {Record<string, string>|undefined} before - the previous map.
 * @param {Record<string, string>} after - the current map.
 * @returns {SectionChange[]} changes, outermost heading first.
 */
export function diffSections(before, after) {
  const previous = before ?? {}
  const addedPaths = []
  const updatedPaths = []
  const removedPaths = []
  for (const [key, hash] of Object.entries(after)) {
    const was = previous[key]
    if (was === hash) continue
    if (was === undefined) addedPaths.push(key.split('\u0000'))
    else updatedPaths.push(key.split('\u0000'))
  }
  for (const key of Object.keys(previous)) {
    if (after[key] === undefined) removedPaths.push(key.split('\u0000'))
  }

  // A rename has to be recognised before the per-heading comparison: without it
  // one changed parent title is reported as a whole subtree of additions and
  // removals. Shortest paths first, so the outermost rename wins and its
  // descendants count as moved rather than separately renamed.
  const renames = []
  const byDepth = [...removedPaths].sort(
    (left, right) => left.length - right.length || pathKey(left).localeCompare(pathKey(right), 'zh'),
  )
  const moved = (path, list, key) => list.some((rename) => underPath(path, rename[key]))
  for (const removed of byDepth) {
    if (moved(removed, renames, 'fromPath')) continue
    const candidates = addedPaths
      .filter((added) => !moved(added, renames, 'toPath'))
      .map((added) => ({ added, index: soleDifference(removed, added) }))
      .filter((candidate) => candidate.index >= 0)
      .sort((left, right) => left.index - right.index)
    for (const { added } of candidates) {
      if (!looksRenamed(removed, added, removedPaths, addedPaths, previous, after)) continue
      renames.push({ fromPath: removed, toPath: added })
      break
    }
  }

  const changes = []
  for (const rename of renames) {
    changes.push({ path: rename.toPath, kind: 'renamed', from: rename.fromPath })
  }
  for (const path of removedPaths) {
    if (moved(path, renames, 'fromPath')) continue
    changes.push({ path, kind: 'removed' })
  }
  for (const path of addedPaths) {
    if (moved(path, renames, 'toPath')) continue
    changes.push({ path, kind: 'added' })
  }
  for (const path of updatedPaths) changes.push({ path, kind: 'updated' })

  return changes.sort((left, right) => left.path.length - right.path.length || pathKey(left.path).localeCompare(pathKey(right.path), 'zh'))
}

/**
 * Compare one file's snapshot entry against its previous entry.
 *
 * Headings are compared one by one, but the file's own metadata — its name, its
 * description, its injection settings, its heading order — lives outside the
 * heading fingerprints. When only that moved, the file still changed and the
 * caller still has to hear about it, so one file-level change is reported
 * instead of nothing at all.
 *
 * @param {FileSnapshot|undefined} previous - the entry the session last saw.
 * @param {FileSnapshot} entry - the current entry.
 * @returns {SectionChange[]} changes, outermost heading first.
 */
export function diffEntries(previous, entry) {
  const changes = diffSections(previous?.sections, entry.sections)
  if (changes.length > 0) return changes
  if (previous === undefined || previous.hash === entry.hash) return []
  return [{ path: [], kind: 'file' }]
}

/**
 * Path of one session snapshot.
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {string} the absolute file path.
 */
function snapshotPath(stateDir, sessionId) {
  return join(stateDir, 'sessions', `${sessionId}.json`)
}

/**
 * Read one session snapshot from disk.
 *
 * A missing file and a corrupt file both mean "no baseline to compare against",
 * which makes the session adopt the current state instead of replaying it.
 *
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {Promise<SessionSnapshot|undefined>} the snapshot.
 */
export async function readSnapshot(stateDir, sessionId) {
  try {
    const parsed = JSON.parse(await readFile(snapshotPath(stateDir, sessionId), 'utf8'))
    if (parsed?.version !== SNAPSHOT_VERSION || typeof parsed.files !== 'object' || parsed.files === null) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Copy one session snapshot onto another identity.
 *
 * A forked session starts from the same prompt text and tool description as its
 * parent, so it must start from the same frozen copies: rendering them again
 * would give the fork a different prefix from the session it forked off, and the
 * two would stop sharing a cache.
 *
 * @param {string} stateDir - the state directory.
 * @param {string} fromId - the source session identity.
 * @param {string} toId - the destination session identity.
 * @returns {Promise<boolean>} whether a snapshot was copied.
 */
export async function copySnapshot(stateDir, fromId, toId) {
  if (fromId === toId) return false
  const source = await readSnapshot(stateDir, fromId)
  if (source === undefined) return false
  const path = snapshotPath(stateDir, toId)
  await mkdir(dirname(path), { recursive: true })
  await copyFile(snapshotPath(stateDir, fromId), path)
  return true
}

/**
 * Write one session snapshot to disk.
 *
 * The body lands through {@link writeAtomic}: a snapshot is rewritten on every
 * delivery, and a process that dies halfway through would otherwise leave a
 * truncated file that reads back as "no baseline" and replays every change.
 *
 * The `injected` and `tools` members are only written when they are given: the
 * delivery baseline advances constantly, while those two are frozen for the life
 * of the session, and a rewrite that dropped them would silently restore the
 * very cache invalidation they exist to prevent.
 *
 * `updatedAt` is taken from the snapshot when it carries one. That timestamp is
 * the end of the model's last message, not the moment of this write — the
 * retention window measures how long the provider's cached prefix has been
 * idle, so a notice pushed to an idle session must not move it.
 *
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @param {SessionSnapshot|Record<string, FileSnapshot>} snapshot - the snapshot, or a bare fingerprint map.
 * @returns {Promise<void>} completion.
 */
export async function writeSnapshot(stateDir, sessionId, snapshot) {
  const path = snapshotPath(stateDir, sessionId)
  // A bare map is the old shape, still passed by tests and by nothing else; it
  // means "just the baseline".
  const next = wasBareMap(snapshot) ? { files: snapshot } : snapshot
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify(
    {
      version: SNAPSHOT_VERSION,
      updatedAt: typeof next.updatedAt === 'string' ? next.updatedAt : new Date().toISOString(),
      files: next.files,
      ...(next.injected !== undefined ? { injected: next.injected } : {}),
      ...(next.tools !== undefined ? { tools: next.tools } : {}),
    },
    null,
    2,
  )
  await writeAtomic(path, body)
}

/**
 * Whether a snapshot argument is the bare fingerprint map of the old API.
 * @param {unknown} value - the argument.
 * @returns {boolean} true when it has no `files` member of its own.
 */
function wasBareMap(value) {
  if (value === null || typeof value !== 'object') return false
  return Object.hasOwn(value, 'files') === false
}

/**
 * Drop one session snapshot.
 *
 * Called when a session goes idle for longer than the prefix cache can live: the
 * next message rebuilds everything from disk, which is the only way the frozen
 * prompt text ever picks up a file that changed while the session was open.
 *
 * @param {string} stateDir - the state directory.
 * @param {string} sessionId - the session identity.
 * @returns {Promise<void>} completion.
 */
export async function removeSnapshot(stateDir, sessionId) {
  await rm(snapshotPath(stateDir, sessionId), { force: true })
}

/**
 * Whether a snapshot's last activity is older than the retention window.
 *
 * `0` disables pruning everywhere, so nothing is ever stale.
 *
 * @param {SessionSnapshot} snapshot - the loaded snapshot.
 * @param {number} ttlMinutes - retention in minutes.
 * @returns {boolean} whether the snapshot has expired.
 */
export function isStale(snapshot, ttlMinutes) {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return false
  const updatedAt = Date.parse(snapshot?.updatedAt ?? '')
  if (!Number.isFinite(updatedAt)) return false
  return updatedAt < Date.now() - ttlMinutes * 60 * 1000
}

/**
 * Drop snapshots whose last activity is older than the retention window.
 *
 * The window is measured in minutes because it exists to match the provider's
 * prefix cache lifetime, which is measured in minutes: a snapshot nobody has
 * touched for longer than that can no longer save a cached prefix, so the next
 * message rebuilds it from whatever is on disk at that moment.
 *
 * `updatedAt` is the end of the model's last message, not the start of the
 * request: the clock that matters is how long the cached prefix has been idle.
 *
 * @param {string} stateDir - the state directory.
 * @param {number} ttlMinutes - retention in minutes; `0` disables pruning.
 * @returns {Promise<number>} how many snapshots were removed.
 */
export async function pruneSnapshots(stateDir, ttlMinutes) {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return 0
  const directory = join(stateDir, 'sessions')
  let names
  try {
    names = await readdir(directory)
  } catch {
    return 0
  }
  const cutoff = Date.now() - ttlMinutes * 60 * 1000
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(directory, name)
    try {
      const updatedAt = Date.parse(JSON.parse(await readFile(path, 'utf8'))?.updatedAt ?? '')
      if (!Number.isFinite(updatedAt) || updatedAt >= cutoff) continue
      await rm(path, { force: true })
      removed += 1
    } catch {
      // A corrupt snapshot is replaced on the next write; leave it alone here.
    }
  }
  return removed
}
