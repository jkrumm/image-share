import type { TreeNodeData } from '@mantine/core'
import type { AlbumNode } from '../../lib/queries/library'

// The keyword-path algebra behind the album tree. Pure and separate from the
// component so the nesting pass — the one part of the rail that can silently
// lose an album — is testable.

/** `image_keywords.path` joins its segments with `|` (design §4). */
export const ALBUM_SEPARATOR = '|'
/** Tree node values are namespaced so no keyword path can collide with a control row. */
export const ALBUM_VALUE_PREFIX = 'album:'

export function albumValue(path: string): string {
  return `${ALBUM_VALUE_PREFIX}${path}`
}

export function albumPath(value: string): string {
  return value.slice(ALBUM_VALUE_PREFIX.length)
}

type Draft = { value: string; label: string; children: Draft[] }

/**
 * Nests the server's flat prefix list. `GET /api/library/albums` already emits
 * every ancestor of every stored path and sorts by path, so a parent is always
 * seen before its children and a single forward pass is enough — no synthesis,
 * no sorting, no recursive descent.
 *
 * The synthetic `path: ''` untagged node is skipped here: it has no place in a
 * hierarchy and is rendered as a first-class row above the tree instead.
 */
export function buildAlbumTree(albums: AlbumNode[]): TreeNodeData[] {
  const byPath = new Map<string, Draft>()
  const roots: Draft[] = []

  for (const node of albums) {
    if (node.path === '') continue
    const draft: Draft = { value: albumValue(node.path), label: node.leaf, children: [] }
    byPath.set(node.path, draft)

    const cut = node.path.lastIndexOf(ALBUM_SEPARATOR)
    const parent = cut === -1 ? undefined : byPath.get(node.path.slice(0, cut))
    if (parent) parent.children.push(draft)
    else roots.push(draft)
  }

  return roots.map(toTreeNode)
}

function toTreeNode(draft: Draft): TreeNodeData {
  if (draft.children.length === 0) return { value: draft.value, label: draft.label }
  return { value: draft.value, label: draft.label, children: draft.children.map(toTreeNode) }
}

/** Every ancestor of `path`, so opening a deep link reveals the selected node. */
export function ancestorValues(path: string | undefined): string[] {
  if (!path) return []
  const segments = path.split(ALBUM_SEPARATOR)
  return segments.map((_, i) => albumValue(segments.slice(0, i + 1).join(ALBUM_SEPARATOR)))
}
