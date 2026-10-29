/**
 * Hashing shared by the store, the runtime, and the snapshot layer.
 *
 * A memory file is fingerprinted in three places: the store remembers the hash
 * of the text it last loaded, the runtime compares it against what a session
 * read, and the snapshot layer records short per-heading hashes. All three must
 * agree byte for byte, so they share one implementation.
 *
 * @module dsh-memory/hash
 */

import { createHash } from 'node:crypto'

/** Length of the short form used in snapshots. */
const SHORT_HASH_LENGTH = 16

/**
 * Full sha256 of a text.
 * @param {string|null|undefined} text - the text to fingerprint.
 * @returns {string} 64 hexadecimal characters.
 */
export function hashText(text) {
  return createHash('sha256').update(text ?? '').digest('hex')
}

/**
 * Truncated sha256, small enough to keep a snapshot file readable.
 * @param {string|null|undefined} text - the text to fingerprint.
 * @param {number} [length] - how many characters to keep.
 * @returns {string} hexadecimal characters.
 */
export function shortHash(text, length = SHORT_HASH_LENGTH) {
  return hashText(text).slice(0, length)
}