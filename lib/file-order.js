/**
 * Stable memory-file ordering shared by prompt injection and the browser panel.
 *
 * @module dsh-memory/file-order
 */

/**
 * Sort documents into the order `fileOrder` asks for.
 *
 * Unlisted files keep their incoming directory order. A stable sort also keeps
 * directory precedence when Global and Workspace have the same filename.
 *
 * @param {object[]} documents - documents in directory order.
 * @param {string[]|undefined} fileOrder - configured file names, first to last.
 * @returns {object[]} the same documents, reordered.
 */
export function orderByConfig(documents, fileOrder) {
  if (!Array.isArray(fileOrder) || fileOrder.length === 0) return documents
  const rank = new Map(fileOrder.map((fileName, index) => [fileName, index]))
  const unranked = Number.MAX_SAFE_INTEGER
  return [...documents].sort(
    (a, b) => (rank.get(a.fileName) ?? unranked) - (rank.get(b.fileName) ?? unranked),
  )
}
