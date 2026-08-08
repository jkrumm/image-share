import { describe, expect, test } from 'bun:test'
import type { AlbumNode } from '../../lib/queries/library'
import {
  albumPath,
  albumValue,
  ancestorValues,
  buildAlbumTree,
  ALBUM_SEPARATOR,
} from './album-path'

function node(path: string, imageCount = 0): AlbumNode {
  const leaf = path === '' ? '(untagged)' : (path.split(ALBUM_SEPARATOR).at(-1) ?? path)
  return {
    path,
    leaf,
    depth: path === '' ? 0 : path.split(ALBUM_SEPARATOR).length,
    imageCount,
    ratedCounts: { r4plus: 0, r5: 0 },
    minCaptureAt: null,
    maxCaptureAt: null,
  }
}

/** The live Fuji library, exactly as `GET /api/library/albums` returns it. */
const PRODUCTION_ALBUMS: AlbumNode[] = [
  node('', 1794),
  node('Ereignisse', 550),
  node('Ereignisse|Segeln 25', 550),
  node('Insta Post Marokko', 8),
  node('Insta Post Segel 25', 37),
]

describe('albumValue / albumPath', () => {
  test('round-trips a hierarchical keyword path', () => {
    expect(albumPath(albumValue('Ereignisse|Segeln 25'))).toBe('Ereignisse|Segeln 25')
  })

  test('round-trips a path that itself contains the namespace prefix', () => {
    expect(albumPath(albumValue('album:weird'))).toBe('album:weird')
  })

  test('namespaces the value so no keyword can collide with a control row', () => {
    expect(albumValue('Ereignisse')).toBe('album:Ereignisse')
  })

  test('round-trips the empty path', () => {
    expect(albumPath(albumValue(''))).toBe('')
  })
})

describe('buildAlbumTree', () => {
  test('nests the real library into two roots, one of them with a child', () => {
    expect(buildAlbumTree(PRODUCTION_ALBUMS)).toEqual([
      {
        value: 'album:Ereignisse',
        label: 'Ereignisse',
        children: [{ value: 'album:Ereignisse|Segeln 25', label: 'Segeln 25' }],
      },
      { value: 'album:Insta Post Marokko', label: 'Insta Post Marokko' },
      { value: 'album:Insta Post Segel 25', label: 'Insta Post Segel 25' },
    ])
  })

  test('the synthetic untagged node never enters the hierarchy', () => {
    const values = buildAlbumTree(PRODUCTION_ALBUMS).map((n) => n.value)
    expect(values).not.toContain('album:')
    // …and dropping it does not cost a real album.
    expect(buildAlbumTree(PRODUCTION_ALBUMS)).toHaveLength(3)
  })

  test('a leaf carries no children key at all, so Mantine renders no chevron', () => {
    const [first] = buildAlbumTree([node('Solo')])
    expect(first).toEqual({ value: 'album:Solo', label: 'Solo' })
    expect('children' in (first ?? {})).toBe(false)
  })

  test('nests three levels deep in one forward pass', () => {
    const tree = buildAlbumTree([node('A'), node('A|B'), node('A|B|C')])
    expect(tree).toEqual([
      {
        value: 'album:A',
        label: 'A',
        children: [
          { value: 'album:A|B', label: 'B', children: [{ value: 'album:A|B|C', label: 'C' }] },
        ],
      },
    ])
  })

  test('siblings keep the server order rather than being re-sorted', () => {
    const tree = buildAlbumTree([node('A'), node('A|z'), node('A|a')])
    expect(tree[0]?.children?.map((n) => n.label)).toEqual(['z', 'a'])
  })

  test('a node whose parent prefix is missing surfaces as a root instead of vanishing', () => {
    // The API guarantees every ancestor is emitted; if that ever regresses the
    // album must still be reachable, not silently dropped.
    expect(buildAlbumTree([node('Ereignisse|Segeln 25')])).toEqual([
      { value: 'album:Ereignisse|Segeln 25', label: 'Segeln 25' },
    ])
  })

  test('an empty list and an untagged-only list both build an empty tree', () => {
    expect(buildAlbumTree([])).toEqual([])
    expect(buildAlbumTree([node('')])).toEqual([])
  })

  test('does not mutate the input', () => {
    const albums = [node('A'), node('A|B')]
    const before = JSON.stringify(albums)
    buildAlbumTree(albums)
    expect(JSON.stringify(albums)).toBe(before)
  })
})

describe('ancestorValues', () => {
  test('lists every prefix of a deep path, so a deep link opens its branch', () => {
    expect(ancestorValues('A|B|C')).toEqual(['album:A', 'album:A|B', 'album:A|B|C'])
  })

  test('a top-level album is its own only ancestor', () => {
    expect(ancestorValues('Ereignisse')).toEqual(['album:Ereignisse'])
  })

  test.each([[undefined], ['']])('%p expands nothing', (path) => {
    expect(ancestorValues(path)).toEqual([])
  })
})
