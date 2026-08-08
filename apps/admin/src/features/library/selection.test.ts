import { describe, expect, test } from 'bun:test'
import type { ImageDto } from '../../lib/queries/library'
import {
  addToSelection,
  intersectSelection,
  isSelectionStale,
  nextSelectionKeys,
  orderedSelection,
  removeFromSelection,
  toSelected,
  unshareableSelection,
  type SelectedImage,
  type Selection,
} from './selection'

function image(partial: Partial<ImageDto> & { id: number }): ImageDto {
  const stem = partial.stem ?? `DSCF${String(partial.id).padStart(4, '0')}`
  return {
    root: 'fuji',
    relPath: `${stem}.JPG`,
    dir: '',
    ext: 'JPG',
    kind: 'jpeg',
    fileSize: 8_000_000,
    mtimeMs: 0,
    captureAt: null,
    orientation: 1,
    rating: 0,
    width: 6240,
    height: 4160,
    rawPath: null,
    indexedAt: '2026-08-08T00:00:00.000Z',
    ...partial,
    stem,
  }
}

function selectionOf(...images: ImageDto[]): Selection {
  return addToSelection(new Map(), images)
}

function ids(selected: SelectedImage[]): number[] {
  return selected.map((item) => item.id)
}

// ── The defect this module exists to fix ─────────────────────────────────────
//
// Selection used to be a `Set<number>`, so anything picked on a page the user
// had left could only be ordered by CLICK order — a selection share then
// shipped its images in the sequence the owner happened to tick them, not in
// capture order. These are the tests that must never go green by accident.

describe('orderedSelection — ordering survives pagination', () => {
  const page1 = [
    image({ id: 11, captureAt: '2026-08-08T10:00:00.000Z' }),
    image({ id: 12, captureAt: '2026-08-07T10:00:00.000Z' }),
  ]
  const page3 = [
    image({ id: 31, captureAt: '2025-01-05T10:00:00.000Z' }),
    image({ id: 32, captureAt: '2024-06-30T10:00:00.000Z' }),
  ]

  test('click order on a later page does not leak into the share order', () => {
    // Owner ticks the OLDEST image first, on page 3, then jumps back to page 1.
    const selection = selectionOf(page3[1]!, page3[0]!, page1[1]!, page1[0]!)
    expect(ids(orderedSelection(selection))).toEqual([32, 31, 12, 11])
  })

  test('insertion order is irrelevant — every permutation yields the same order', () => {
    const forwards = selectionOf(page1[0]!, page1[1]!, page3[0]!, page3[1]!)
    const backwards = selectionOf(page3[1]!, page3[0]!, page1[1]!, page1[0]!)
    const scrambled = selectionOf(page1[1]!, page3[0]!, page1[0]!, page3[1]!)
    const expected = [32, 31, 12, 11]
    expect(ids(orderedSelection(forwards))).toEqual(expected)
    expect(ids(orderedSelection(backwards))).toEqual(expected)
    expect(ids(orderedSelection(scrambled))).toEqual(expected)
  })

  test('a re-selected image keeps one entry, not two', () => {
    const twice = addToSelection(selectionOf(page1[0]!), [page1[0]!, page1[1]!])
    expect(twice.size).toBe(2)
    expect(ids(orderedSelection(twice))).toEqual([12, 11])
  })
})

// ── The browse sort is not a share property ──────────────────────────────────
//
// This used to take `(sort, order)` from the Library toolbar, which defaults to
// captureAt/DESC — so a selection share arrived at the friend scrolling the trip
// BACKWARDS, and switching the toolbar to Sort=Name shipped it in filename
// order instead. Folder and album shares were always capture-ascending
// (`asc(images.captureAt)`, api share-auth.ts); now all three agree.

describe('orderedSelection — the API ordering, reproduced client-side', () => {
  test('oldest first, whatever the grid was sorted by', () => {
    // Filename order and capture order deliberately disagree: DSCF0001 is the
    // NEWEST frame, so a name-sorted or a desc-sorted grid would invert this.
    const selection = selectionOf(
      image({ id: 1, stem: 'DSCF0001', captureAt: '2026-07-11T09:00:00.000Z' }),
      image({ id: 2, stem: 'DSCF0002', captureAt: '2026-07-07T09:00:00.000Z' }),
      image({ id: 3, stem: 'DSCF0003', captureAt: '2026-07-04T09:00:00.000Z' }),
    )
    expect(ids(orderedSelection(selection))).toEqual([3, 2, 1])
  })

  test('NULL capture dates sort first, matching SQLite ascending', () => {
    const selection = selectionOf(
      image({ id: 2, captureAt: '2026-01-01T00:00:00.000Z' }),
      image({ id: 1, captureAt: null }),
      image({ id: 3, captureAt: '2025-01-01T00:00:00.000Z' }),
    )
    expect(ids(orderedSelection(selection))).toEqual([1, 3, 2])
  })

  test('id breaks ties, so the order is total and deterministic', () => {
    const at = '2026-03-03T12:00:00.000Z'
    const selection = selectionOf(
      image({ id: 7, captureAt: at }),
      image({ id: 3, captureAt: at }),
      image({ id: 5, captureAt: at }),
    )
    expect(ids(orderedSelection(selection))).toEqual([3, 5, 7])
  })

  test('an empty selection orders to an empty array', () => {
    expect(orderedSelection(new Map())).toEqual([])
  })
})

describe('unshareableSelection', () => {
  test('picks out RAF rows — they have no rendition, so a share of them 500s', () => {
    const selection = selectionOf(
      image({ id: 1 }),
      image({ id: 2, root: 'raws', ext: 'RAF', kind: 'raw' }),
      image({ id: 3, root: 'raws', ext: 'RAF', kind: 'raw' }),
    )
    expect(ids(unshareableSelection(selection))).toEqual([2, 3])
  })

  test('an all-JPEG selection has nothing to complain about', () => {
    expect(unshareableSelection(selectionOf(image({ id: 1 }), image({ id: 2 })))).toEqual([])
  })
})

describe('toSelected', () => {
  test('keeps exactly the fields the ordering and the share guard need', () => {
    const selected = toSelected(image({ id: 1, captureAt: '2026-01-01T00:00:00.000Z', rating: 4 }))
    expect(Object.keys(selected).toSorted()).toEqual([
      'captureAt',
      'dir',
      'ext',
      'id',
      'kind',
      'rating',
      'root',
      'stem',
    ])
  })
})

describe('add / remove / intersect', () => {
  const a = image({ id: 1 })
  const b = image({ id: 2 })
  const c = image({ id: 3 })

  test('every operation returns a new map and leaves the input untouched', () => {
    const base = selectionOf(a, b)
    expect(addToSelection(base, [c]).size).toBe(3)
    expect(removeFromSelection(base, [1]).size).toBe(1)
    expect(intersectSelection(base, new Set([1])).size).toBe(1)
    expect(base.size).toBe(2)
  })

  test('removing an id that is not selected is a no-op', () => {
    expect([...removeFromSelection(selectionOf(a, b), [99]).keys()]).toEqual([1, 2])
  })

  test('intersect keeps only what the current filter matched', () => {
    const kept = intersectSelection(selectionOf(a, b, c), new Set([3, 1, 404]))
    expect([...kept.keys()]).toEqual([1, 3])
  })

  test('intersect with nothing matching empties the selection', () => {
    expect(intersectSelection(selectionOf(a, b), new Set()).size).toBe(0)
  })

  test('intersect preserves the stored sort keys, so order survives narrowing', () => {
    const selection = selectionOf(
      image({ id: 1, captureAt: '2024-01-01T00:00:00.000Z' }),
      image({ id: 2, captureAt: '2026-01-01T00:00:00.000Z' }),
      image({ id: 3, captureAt: '2025-01-01T00:00:00.000Z' }),
    )
    const kept = intersectSelection(selection, new Set([1, 2]))
    expect(ids(orderedSelection(kept))).toEqual([1, 2])
  })
})

// ── Stale selection on filter change ─────────────────────────────────────────

const FILTER_A = '["fuji",null,"Ereignisse|Segeln 25",false,true,0,null,null,null]'
const FILTER_B = '["fuji",null,null,true,true,0,null,null,null]'

describe('isSelectionStale', () => {
  const one = selectionOf(image({ id: 1 }))

  test('an empty selection is never stale, whatever the key history says', () => {
    expect(isSelectionStale(new Map(), new Set([FILTER_A, FILTER_B]), FILTER_A)).toBe(false)
  })

  test('picked entirely under the filter on screen — not stale', () => {
    expect(isSelectionStale(one, new Set([FILTER_A]), FILTER_A)).toBe(false)
  })

  test('the filter moved after picking — stale', () => {
    expect(isSelectionStale(one, new Set([FILTER_A]), FILTER_B)).toBe(true)
  })

  test('picked across two filters — stale even while looking at one of them', () => {
    expect(isSelectionStale(one, new Set([FILTER_A, FILTER_B]), FILTER_A)).toBe(true)
  })

  test('a non-empty selection with no recorded key is stale, not silently trusted', () => {
    expect(isSelectionStale(one, new Set(), FILTER_A)).toBe(true)
  })
})

describe('nextSelectionKeys', () => {
  const one = selectionOf(image({ id: 1 }))

  test('a plain add records the current filter without forgetting the old ones', () => {
    const keys = nextSelectionKeys(new Set([FILTER_A]), one, FILTER_B)
    expect([...keys].toSorted()).toEqual([FILTER_A, FILTER_B].toSorted())
  })

  test('"select all matching" does NOT clear the warning — earlier picks are still in there', () => {
    // The Library page passes matchesCurrentFilter=false here on purpose.
    const keys = nextSelectionKeys(new Set([FILTER_A]), one, FILTER_B, false)
    expect(isSelectionStale(one, keys, FILTER_B)).toBe(true)
  })

  test('"keep only what matches" collapses the history to the current filter', () => {
    const keys = nextSelectionKeys(new Set([FILTER_A, FILTER_B]), one, FILTER_B, true)
    expect([...keys]).toEqual([FILTER_B])
    expect(isSelectionStale(one, keys, FILTER_B)).toBe(false)
  })

  test('clearing the selection clears the history', () => {
    expect([...nextSelectionKeys(new Set([FILTER_A, FILTER_B]), new Map(), FILTER_A)]).toEqual([])
  })

  test('returns the same set instance when nothing changed, so React can skip a render', () => {
    const keys = new Set([FILTER_A])
    expect(nextSelectionKeys(keys, one, FILTER_A)).toBe(keys)
    expect(nextSelectionKeys(keys, one, FILTER_A, true)).toBe(keys)
    const empty = new Set<string>()
    expect(nextSelectionKeys(empty, new Map(), FILTER_A)).toBe(empty)
  })

  test('does not mutate the previous set', () => {
    const keys = new Set([FILTER_A])
    nextSelectionKeys(keys, one, FILTER_B)
    expect([...keys]).toEqual([FILTER_A])
  })
})

describe('the page lifecycle it models', () => {
  test('pick under one album, switch album, then narrow — warning appears then clears', () => {
    const picked = selectionOf(image({ id: 1 }), image({ id: 2 }))
    let keys = nextSelectionKeys(new Set<string>(), picked, FILTER_A)
    expect(isSelectionStale(picked, keys, FILTER_A)).toBe(false)

    // The owner switches to the untagged bucket: same selection, different filter.
    expect(isSelectionStale(picked, keys, FILTER_B)).toBe(true)

    // "Keep only what matches" re-walks FILTER_B server-side; id 1 survives.
    const narrowed = intersectSelection(picked, new Set([1]))
    keys = nextSelectionKeys(keys, narrowed, FILTER_B, true)
    expect(isSelectionStale(narrowed, keys, FILTER_B)).toBe(false)
    expect([...narrowed.keys()]).toEqual([1])
  })
})
