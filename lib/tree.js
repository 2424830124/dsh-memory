/**
 * Heading-tree navigation.
 *
 * A memory document is a tree of `Map`s — every level keeps file order, which
 * is also render order. These helpers walk that tree without knowing anything
 * about YAML or rendering.
 *
 * @module dsh-memory/tree
 */

/**
 * Walk every heading in the document, parents before children.
 * @param {import('./model.js').MemoryDocument} document - the document to walk.
 * @returns {IterableIterator<{path: string[], node: import('./model.js').MemoryNode}>} every heading.
 */
export function* walk(document) {
  function* descend(level, prefix) {
    for (const [title, node] of level) {
      const path = [...prefix, title]
      yield { path, node }
      yield* descend(node.children, path)
    }
  }
  yield* descend(document.roots, [])
}

/**
 * Resolve a heading path to its node.
 * @param {import('./model.js').MemoryDocument} document - the document to search.
 * @param {string[]} path - heading titles from the top level down.
 * @returns {import('./model.js').MemoryNode|undefined} the node, when the whole path exists.
 */
export function findNode(document, path) {
  let level = document.roots
  let node
  for (const title of path) {
    node = level.get(title)
    if (node === undefined) return undefined
    level = node.children
  }
  return node
}

/**
 * Resolve the map that holds the last heading of a path.
 *
 * `undefined` means an ancestor is missing, which the edit layer reports as "create
 * the parent first". An empty path addresses the root level.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to search.
 * @param {string[]} path - heading titles from the top level down.
 * @returns {Map<string, import('./model.js').MemoryNode>|undefined} the containing map.
 */
export function findSiblings(document, path) {
  if (path.length <= 1) return document.roots
  return findNode(document, path.slice(0, -1))?.children
}

/**
 * Stamp `update_at` on one heading and every heading above it.
 *
 * A parent is a summary of its subtree, so its timestamp moves with it; a sibling
 * does not, or every edit would appear to touch the whole file.
 *
 * @param {import('./model.js').MemoryDocument} document - the document to update.
 * @param {string[]} path - the heading path that changed.
 * @param {string} timestamp - the new timestamp.
 * @returns {void}
 */
export function touchPath(document, path, timestamp) {
  let level = document.roots
  for (const title of path) {
    const node = level.get(title)
    if (node === undefined) return
    node.update_at = timestamp
    level = node.children
  }
}

/**
 * Move a heading to a new title, keeping its position among its siblings and its
 * whole subtree.
 * @param {Map<string, import('./model.js').MemoryNode>} siblings - the level holding the heading.
 * @param {string} oldTitle - the current title.
 * @param {string} newTitle - the new title.
 * @returns {void}
 */
export function renameHeading(siblings, oldTitle, newTitle) {
  const entries = [...siblings]
  siblings.clear()
  for (const [title, node] of entries) siblings.set(title === oldTitle ? newTitle : title, node)
}
