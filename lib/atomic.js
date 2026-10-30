/**
 * Replace a file without ever leaving a half-written one behind.
 *
 * Memory files and session snapshots are both read by other processes (the
 * panel, a second agent) while they are being written. Writing in place means a
 * crash mid-write leaves a truncated YAML that fails to parse; writing a temp
 * file and renaming it is atomic on the same filesystem, so a reader sees either
 * the old version or the new one.
 *
 * @module dsh-memory/atomic
 */

import { rename, rm, stat, writeFile } from 'node:fs/promises'

/**
 * Distinguishes two writes that start in the same millisecond.
 *
 * `pid` and the clock are not enough on their own: a snapshot is rewritten from
 * several places (a delivery, a frozen-part write, the retention sweep), and two
 * of them landing in the same millisecond would share a temp path — one rename
 * wins, the other fails with ENOENT.
 */
let counter = 0

/**
 * Windows rename failures that mean "someone else is momentarily on the target".
 *
 * `rename` onto a destination that a concurrent rename is replacing, or that a
 * reader has open, fails with EPERM or EBUSY rather than blocking like POSIX. The
 * window is microseconds, so a short backoff is enough.
 */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Wait before the next rename attempt.
 * @param {number} attempt - zero-based attempt number.
 * @returns {Promise<void>} resolves after the backoff.
 */
function backoff(attempt) {
  return new Promise((resolve) => {
    setTimeout(resolve, 5 * 2 ** attempt)
  })
}

/**
 * Write `text` to `path` through a temp file in the same directory.
 * @param {string} path - the destination.
 * @param {string} text - what to write.
 * @returns {Promise<void>} resolves once the rename landed.
 * @throws when the write or the rename fails; the temp file is removed first.
 */
export async function writeAtomic(path, text) {
  // 同目录是为了让 rename 落在同一个文件系统上：跨设备 rename 会退化成拷贝，
  // 那就又不原子了。
  counter += 1
  const temp = `${path}.${process.pid}.${Date.now()}.${counter}.tmp`
  await writeFile(temp, text, 'utf8')
  let last
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      last = error
      if (!TRANSIENT.has(error?.code) || attempt === 5) break
      // The target is briefly held by another writer; wait it out.
      await backoff(attempt)
    }
  }
  await rm(temp, { force: true }).catch(() => {})
  throw last
}

/**
 * Whether two paths name one and the same file on this filesystem.
 *
 * Renaming `abc` to `ABC` is a real rename on Linux but the *same* file on
 * Windows and (by default) macOS: the write lands on the old file, and then
 * deleting the "old" path removes the file that was just written - the memory
 * file is gone, while the cache still answers for it. Comparing device and
 * inode asks the filesystem instead of guessing from the platform.
 *
 * @param {string} a - one path.
 * @param {string} b - the other path.
 * @returns {Promise<boolean>} true when both paths resolve to one file.
 */
export async function sameFileOnDisk(a, b) {
  if (a === b) return true
  try {
    const [left, right] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
    return left.dev === right.dev && left.ino === right.ino
  } catch {
    // One of them is missing: they cannot be the same file.
    return false
  }
}
