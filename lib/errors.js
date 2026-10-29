/**
 * The single error type this plugin throws at the model.
 *
 * Every layer — document parsing, editing, the store, the runtime — reports a
 * failure the same way: a `DocumentError` whose message the model can act on,
 * plus the heading path it applies to when there is one. Keeping the type in its
 * own module lets each layer throw and catch it without importing the document
 * model.
 *
 * @module dsh-memory/errors
 */

/** A structural or semantic problem in one memory operation. */
export class DocumentError extends Error {
  /**
   * @param {string} message - what is wrong, phrased for the model.
   * @param {string} [path] - the offending heading path, when one applies.
   */
  constructor(message, path) {
    super(message)
    this.name = 'DocumentError'
    this.path = path
  }
}
