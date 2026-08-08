import { describe, expect, test } from 'bun:test'
import {
  dateRangeLabel,
  filterKeyOf,
  LIBRARY_PAGE_LIMIT,
  LibrarySearchSchema,
  scopeLabel,
  scopeSourceOf,
  shareActionOf,
  shareRootOf,
  toImagesParams,
  unscopableAxis,
  unshareableFilters,
  type LibrarySearchParams,
} from './search-params'

function parse(raw: Record<string, unknown>): LibrarySearchParams {
  return LibrarySearchSchema.parse(raw)
}

describe('LibrarySearchSchema — defaults', () => {
  test('a bare URL lands on the fuji root, not on every root at once', () => {
    // The regression: an undefined root fetched across ALL roots, so first paint
    // pulled RAF rows into a grid that can never render them.
    expect(parse({})).toEqual({
      root: 'fuji',
      untagged: false,
      recursive: true,
      page: 1,
      sort: 'captureAt',
      order: 'desc',
    })
  })

  test('recursive defaults to true, matching the API and POST /api/shares', () => {
    expect(parse({}).recursive).toBe(true)
  })

  test('optional filters stay absent rather than becoming empty strings', () => {
    const search = parse({})
    expect(search.dir).toBeUndefined()
    expect(search.album).toBeUndefined()
    expect(search.minRating).toBeUndefined()
    expect(search.captureFrom).toBeUndefined()
    expect(search.captureTo).toBeUndefined()
    expect(search.stem).toBeUndefined()
  })
})

describe('LibrarySearchSchema — round-trip', () => {
  test('a fully specified search parses to itself', () => {
    const search: LibrarySearchParams = {
      root: 'share',
      dir: 'agent/2026-08',
      album: 'Ereignisse|Segeln 25',
      untagged: false,
      recursive: false,
      minRating: 4,
      captureFrom: '2025-06-01',
      captureTo: '2025-06-30',
      stem: 'DSCF12',
      page: 3,
      sort: 'name',
      order: 'asc',
    }
    expect(parse(search)).toEqual(search)
  })

  test('an empty dir survives — it is the root folder, not "no folder"', () => {
    expect(parse({ dir: '' }).dir).toBe('')
  })

  test('an empty album survives parsing — "any album" is a real scope here', () => {
    expect(parse({ album: '' }).album).toBe('')
  })

  test('every browsable root is accepted', () => {
    for (const root of ['fuji', 'raws', 'share'] as const) {
      expect(parse({ root }).root).toBe(root)
    }
  })
})

describe('LibrarySearchSchema — rejects invalid', () => {
  const invalid: [string, Record<string, unknown>][] = [
    ['an unknown root', { root: 'homelab' }],
    ['page 0', { page: 0 }],
    ['a negative page', { page: -1 }],
    ['a fractional page', { page: 1.5 }],
    ['a page as a string (search params are not coerced here)', { page: '2' }],
    ['a rating above 5', { minRating: 6 }],
    ['a negative rating', { minRating: -1 }],
    ['a fractional rating', { minRating: 2.5 }],
    ['an unknown sort column', { sort: 'fileSize' }],
    ['an unknown order', { order: 'descending' }],
    ['untagged as a string', { untagged: 'true' }],
    ['recursive as a number', { recursive: 1 }],
    ['a non-string dir', { dir: 42 }],
  ]

  for (const [name, raw] of invalid) {
    test(`rejects ${name}`, () => {
      expect(() => parse(raw)).toThrow()
    })
  }

  test('rating 0 and 5 are the inclusive bounds', () => {
    expect(parse({ minRating: 0 }).minRating).toBe(0)
    expect(parse({ minRating: 5 }).minRating).toBe(5)
  })
})

describe('toImagesParams — album / untagged mutual exclusion', () => {
  test('an album is sent and `untagged` is omitted entirely, not sent as false', () => {
    // Sending both is a 400 on the API — and `untagged=false` counts as sent.
    const params = toImagesParams(parse({ album: 'Ereignisse|Segeln 25' }))
    expect(params.album).toBe('Ereignisse|Segeln 25')
    expect('untagged' in params).toBe(false)
  })

  test('an album wins if a URL somehow carries both', () => {
    const params = toImagesParams(parse({ album: 'Insta Post Marokko', untagged: true }))
    expect(params.album).toBe('Insta Post Marokko')
    expect('untagged' in params).toBe(false)
  })

  test('the untagged bucket sends untagged=true and no album', () => {
    const params = toImagesParams(parse({ untagged: true }))
    expect(params.untagged).toBe(true)
    expect('album' in params).toBe(false)
  })

  test('browsing everything sends neither key', () => {
    const params = toImagesParams(parse({}))
    expect('album' in params).toBe(false)
    expect('untagged' in params).toBe(false)
  })

  test('an empty album ("any album") is still sent — it is not the untagged bucket', () => {
    const params = toImagesParams(parse({ album: '' }))
    expect(params.album).toBe('')
    expect('untagged' in params).toBe(false)
  })
})

describe('toImagesParams — the rest of the query', () => {
  test('non-raws roots are pinned to JPEG so the grid can render every tile', () => {
    expect(toImagesParams(parse({ root: 'fuji' })).kind).toBe('jpeg')
    expect(toImagesParams(parse({ root: 'share' })).kind).toBe('jpeg')
  })

  test('the raws root browses raw rows, so no kind filter is applied', () => {
    expect('kind' in toImagesParams(parse({ root: 'raws' }))).toBe(false)
  })

  test('the page limit is the shared constant unless overridden', () => {
    expect(toImagesParams(parse({})).limit).toBe(LIBRARY_PAGE_LIMIT)
    expect(toImagesParams(parse({}), 200).limit).toBe(200)
  })

  test('rating 0 means "no filter" and is not sent', () => {
    expect('minRating' in toImagesParams(parse({ minRating: 0 }))).toBe(false)
    expect(toImagesParams(parse({ minRating: 3 })).minRating).toBe(3)
  })

  test('the capture range is forwarded verbatim as bare days', () => {
    const params = toImagesParams(parse({ captureFrom: '2025-06-01', captureTo: '2025-06-30' }))
    expect(params.captureFrom).toBe('2025-06-01')
    expect(params.captureTo).toBe('2025-06-30')
  })

  test('one open end of the range is fine', () => {
    const params = toImagesParams(parse({ captureFrom: '2025-06-01' }))
    expect(params.captureFrom).toBe('2025-06-01')
    expect('captureTo' in params).toBe(false)
  })

  test('an empty stem is dropped rather than sent as an empty LIKE', () => {
    expect('stem' in toImagesParams(parse({ stem: '' }))).toBe(false)
    expect(toImagesParams(parse({ stem: 'DSCF12' })).stem).toBe('DSCF12')
  })

  test('an empty dir IS sent — it scopes to the root directory', () => {
    expect(toImagesParams(parse({ dir: '' })).dir).toBe('')
  })

  test('sort, order, page and recursive are carried through', () => {
    const params = toImagesParams(parse({ sort: 'name', order: 'asc', page: 4, recursive: false }))
    expect(params).toMatchObject({ sort: 'name', order: 'asc', page: 4, recursive: false })
  })
})

describe('filterKeyOf', () => {
  test('sort and order do not change WHICH images match, so they are excluded', () => {
    const base = parse({ album: 'Ereignisse' })
    expect(filterKeyOf({ ...base, sort: 'name', order: 'asc' })).toBe(filterKeyOf(base))
  })

  test('paging does not change the filter either', () => {
    const base = parse({ album: 'Ereignisse' })
    expect(filterKeyOf({ ...base, page: 7 })).toBe(filterKeyOf(base))
  })

  test('an unset rating and rating 0 are the same filter', () => {
    expect(filterKeyOf(parse({ minRating: 0 }))).toBe(filterKeyOf(parse({})))
  })

  test.each([
    ['root', { root: 'share' as const }],
    ['dir', { dir: 'agent' }],
    ['album', { album: 'Ereignisse' }],
    ['untagged', { untagged: true }],
    ['recursive', { recursive: false }],
    ['minRating', { minRating: 4 }],
    ['captureFrom', { captureFrom: '2025-06-01' }],
    ['captureTo', { captureTo: '2025-06-30' }],
    ['stem', { stem: 'DSCF' }],
  ])('%s changes the filter key', (_name, patch) => {
    expect(filterKeyOf(parse(patch))).not.toBe(filterKeyOf(parse({})))
  })

  test('an absent dir and an empty dir are different filters', () => {
    expect(filterKeyOf(parse({ dir: '' }))).not.toBe(filterKeyOf(parse({})))
  })

  test('the key is stable across two equal searches built differently', () => {
    expect(filterKeyOf(parse({ album: 'A', page: 1 }))).toBe(
      filterKeyOf(parse({ page: 1, album: 'A' })),
    )
  })
})

describe('scopeLabel', () => {
  test.each([
    ['Untagged', { untagged: true }],
    ['Untagged', { untagged: true, album: undefined }],
    ['Album · Ereignisse|Segeln 25', { album: 'Ereignisse|Segeln 25' }],
    ['Folder · agent/2026-08', { dir: 'agent/2026-08' }],
    ['Folder · (root)', { dir: '' }],
    ['All images', {}],
  ])('reads %s', (expected, raw) => {
    expect(scopeLabel(parse(raw))).toBe(expected)
  })
})

describe('scopeLabel — the active filters, not just the browse axis', () => {
  test('names the capture range next to the count it produced', () => {
    expect(scopeLabel(parse({ album: 'Ereignisse|Segeln 25', captureFrom: '2025-08-01' }))).toBe(
      'Album · Ereignisse|Segeln 25 · from 2025-08-01',
    )
  })

  test('a full range reads as a range', () => {
    expect(scopeLabel(parse({ captureFrom: '2025-08-01', captureTo: '2025-08-08' }))).toBe(
      'All images · 2025-08-01 → 2025-08-08',
    )
  })

  test('an open start reads as an end bound', () => {
    expect(dateRangeLabel(parse({ captureTo: '2025-08-08' }))).toBe('until 2025-08-08')
    expect(dateRangeLabel(parse({}))).toBeNull()
  })

  test('the filename filter is named too', () => {
    expect(scopeLabel(parse({ dir: 'agent', stem: 'DSCF' }))).toBe('Folder · agent · “DSCF”')
  })
})

describe('scopeSourceOf', () => {
  test('an album scope becomes an album source carrying recursive + minRating', () => {
    expect(scopeSourceOf(parse({ album: 'Ereignisse|Segeln 25', minRating: 3 }))).toEqual({
      type: 'album',
      root: 'fuji',
      album: 'Ereignisse|Segeln 25',
      recursive: true,
      minRating: 3,
    })
  })

  test('a folder scope becomes a folder source; the root folder is a real scope', () => {
    expect(scopeSourceOf(parse({ dir: '', recursive: false }))).toEqual({
      type: 'folder',
      root: 'fuji',
      dir: '',
      recursive: false,
      minRating: null,
    })
  })

  test('rating 0 is "no filter", never a literal 0 (which would drop unrated images)', () => {
    expect(scopeSourceOf(parse({ dir: 'agent', minRating: 0 }))?.minRating).toBeNull()
  })

  test.each([
    ['browsing everything', {}],
    ['the untagged bucket — no share source can express it', { untagged: true }],
    ['an empty album ("any album") — rejected by POST /api/shares', { album: '' }],
    ['the raws root — nothing there is shareable', { root: 'raws' as const, dir: '' }],
  ])('is null when %s', (_name, raw) => {
    expect(scopeSourceOf(parse(raw))).toBeNull()
  })
})

describe('shareActionOf — the count next to the button is the set the button ships', () => {
  test('a plain album scope creates a live album share', () => {
    const action = shareActionOf(parse({ album: 'Ereignisse|Segeln 25' }))
    expect(action?.mode).toBe('scope')
  })

  test.each([
    ['captureFrom', { captureFrom: '2025-08-01' }, ['the dates']],
    ['captureTo', { captureTo: '2025-08-08' }, ['the dates']],
    ['both bounds', { captureFrom: '2025-08-01', captureTo: '2025-08-08' }, ['the dates']],
    ['a filename filter', { stem: 'DSCF' }, ['the filename filter']],
    [
      'dates and a filename filter',
      { captureFrom: '2025-08-01', stem: 'DSCF' },
      ['the dates', 'the filename filter'],
    ],
  ])(
    'falls back to a frozen selection when %s is active — a live scope would ship a larger set',
    (_name, raw, dropped) => {
      const search = parse({ album: 'Ereignisse|Segeln 25', ...raw })
      expect(unshareableFilters(search)).toEqual(dropped)
      expect(shareActionOf(search)).toEqual({ mode: 'snapshot', dropped })
    },
  )

  test('the same holds for a folder scope', () => {
    expect(shareActionOf(parse({ dir: 'agent', captureTo: '2025-08-08' }))?.mode).toBe('snapshot')
  })

  test('minRating IS expressible, so it never forces a snapshot', () => {
    const action = shareActionOf(parse({ album: 'Ereignisse', minRating: 4 }))
    expect(action).toEqual({
      mode: 'scope',
      source: { type: 'album', root: 'fuji', album: 'Ereignisse', recursive: true, minRating: 4 },
    })
  })

  test('an empty stem is not a filter', () => {
    expect(shareActionOf(parse({ dir: 'agent', stem: '' }))?.mode).toBe('scope')
  })

  test('only the raws root has no button — nothing there is shareable at all', () => {
    expect(shareActionOf(parse({ root: 'raws' }))).toBeNull()
    expect(shareActionOf(parse({ root: 'raws', dir: '', captureFrom: '2025-08-01' }))).toBeNull()
  })

  // The regression: the button keyed off a scope source, so it VANISHED on the
  // two axes that cannot produce one — including the snapshot mode that works
  // there perfectly. ~1794 of 2352 JPEGs are untagged (design §3.1), so "the
  // trip I never tagged, narrowed to its week" was the one case with no button.
  test.each([
    ['the untagged bucket', { untagged: true }, ['the untagged bucket']],
    [
      'untagged narrowed to a date range',
      { untagged: true, captureFrom: '2025-08-01', captureTo: '2025-08-08' },
      ['the untagged bucket', 'the dates'],
    ],
    ['the All images axis', {}, ['the “All images” axis']],
    [
      'All images narrowed by a filename',
      { stem: 'DSCF' },
      ['the “All images” axis', 'the filename filter'],
    ],
    ['the "any album" bucket', { album: '' }, ['the “any album” bucket']],
  ])('%s offers a frozen snapshot, never nothing', (_name, raw, dropped) => {
    expect(unscopableAxis(parse(raw))).toBe(dropped[0]!)
    expect(shareActionOf(parse(raw))).toEqual({ mode: 'snapshot', dropped })
  })

  test('an album or folder axis is scopable, so it never reports an axis reason', () => {
    expect(unscopableAxis(parse({ album: 'Ereignisse|Segeln 25' }))).toBeNull()
    expect(unscopableAxis(parse({ dir: '' }))).toBeNull()
    // The raws root kills the button outright, so there is nothing to explain.
    expect(unscopableAxis(parse({ root: 'raws' }))).toBeNull()
  })

  test('a snapshot always carries at least one reason — the UI renders it as a sentence', () => {
    for (const raw of [{}, { untagged: true }, { album: '' }, { stem: 'DSCF' }]) {
      const action = shareActionOf(parse(raw))
      expect(action?.mode).toBe('snapshot')
      expect(action?.mode === 'snapshot' && action.dropped.length).toBeGreaterThan(0)
    }
  })
})

describe('shareRootOf', () => {
  test('raws can be browsed but never shared — every raws row is kind=raw', () => {
    expect(shareRootOf('raws')).toBeNull()
  })

  test('fuji and share are shareable roots', () => {
    expect(shareRootOf('fuji')).toBe('fuji')
    expect(shareRootOf('share')).toBe('share')
  })
})
