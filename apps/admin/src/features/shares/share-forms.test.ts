import { describe, expect, test } from 'bun:test'
import type { ShareSourceInput } from '../../lib/queries/shares'
import {
  CREATE_SHARE_INITIAL_VALUES,
  CreateShareFormSchema,
  deriveSlugPreview,
  isCreateShareBlocked,
  resolveShareSource,
  settingsInitialValues,
  shareScopeLabel,
  SettingsFormSchema,
  toUpdateSharePatch,
  type CreateShareFormValues,
  type SettingsFormValues,
} from './share-forms'

describe('deriveSlugPreview', () => {
  test.each([
    ['Segeln 25', 'segeln-25'],
    ['Ereignisse | Segeln 25', 'ereignisse-segeln-25'],
    ['  leading and trailing  ', 'leading-and-trailing'],
    ['Trip 2026!!!', 'trip-2026'],
    ['---dashes---', 'dashes'],
    ['MiXeD CaSe', 'mixed-case'],
    ['a___b', 'a-b'],
  ])('%p → %p', (title, expected) => {
    expect(deriveSlugPreview(title)).toBe(expected)
  })

  test('non-ASCII collapses rather than passing through into a URL', () => {
    expect(deriveSlugPreview('Grüße aus Marokko')).toBe('gr-e-aus-marokko')
  })

  test('a title with nothing sluggable in it falls back to "share"', () => {
    expect(deriveSlugPreview('')).toBe('share')
    expect(deriveSlugPreview('   ')).toBe('share')
    expect(deriveSlugPreview('!!!')).toBe('share')
    expect(deriveSlugPreview('日本語')).toBe('share')
  })

  test('truncates at 64 characters', () => {
    expect(deriveSlugPreview('a'.repeat(200))).toHaveLength(64)
  })

  test('a truncation landing on a separator does not leave a trailing dash', () => {
    const slug = deriveSlugPreview(`${'a'.repeat(63)} b`)
    expect(slug).toBe('a'.repeat(63))
    expect(slug.endsWith('-')).toBe(false)
  })

  test('is idempotent — running it on its own output changes nothing', () => {
    const slug = deriveSlugPreview('Ereignisse | Segeln 25')
    expect(deriveSlugPreview(slug)).toBe(slug)
  })
})

describe('CreateShareFormSchema', () => {
  test('the initial values are the empty form and pass once a title is typed', () => {
    // The form opens invalid on purpose — `title` is the one field the operator
    // must supply, and submit stays blocked until it is there.
    expect(CreateShareFormSchema.safeParse(CREATE_SHARE_INITIAL_VALUES).success).toBe(false)
    const filled = { ...CREATE_SHARE_INITIAL_VALUES, title: 'Segeln 25' }
    expect(CreateShareFormSchema.parse(filled)).toEqual(filled)
  })

  test('defaults to the album axis — the Fuji tree is one flat directory', () => {
    expect(CREATE_SHARE_INITIAL_VALUES.scope).toBe('album')
  })

  test('the first link defaults to the least-privileged role', () => {
    expect(CREATE_SHARE_INITIAL_VALUES.role).toBe('view')
  })

  test('an empty title is rejected with the message the field shows', () => {
    const result = CreateShareFormSchema.safeParse({ ...CREATE_SHARE_INITIAL_VALUES, title: '' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.message)).toContain('Required')
  })

  const invalid: [string, Partial<CreateShareFormValues>][] = [
    ['a rating above 5', { minRating: 6 }],
    ['a negative rating', { minRating: -1 }],
    ['a fractional rating', { minRating: 3.5 }],
    ['an unknown scope axis', { scope: 'selection' as never }],
    ['the raws root, which can never hold a shareable image', { root: 'raws' as never }],
    ['an unknown role', { role: 'admin' as never }],
    ['an unknown second-link role', { secondRole: 'owner' as never }],
  ]

  for (const [name, patch] of invalid) {
    test(`rejects ${name}`, () => {
      expect(() =>
        CreateShareFormSchema.parse({ ...CREATE_SHARE_INITIAL_VALUES, title: 'T', ...patch }),
      ).toThrow()
    })
  }

  test('rating 0 and 5 are the inclusive bounds', () => {
    for (const minRating of [0, 5]) {
      expect(
        CreateShareFormSchema.parse({ ...CREATE_SHARE_INITIAL_VALUES, title: 'T', minRating })
          .minRating,
      ).toBe(minRating)
    }
  })
})

describe('resolveShareSource', () => {
  const picker = { ...CREATE_SHARE_INITIAL_VALUES }

  test('an ambient source from the Library page wins over the picker values', () => {
    const ambient: ShareSourceInput = { type: 'selection', imageIds: [3, 1, 2] }
    expect(resolveShareSource({ ...picker, album: 'Ereignisse' }, ambient)).toBe(ambient)
  })

  test('nothing picked yet is null, not a scope meaning "every tagged image"', () => {
    expect(resolveShareSource({ ...picker, scope: 'album', album: '' })).toBeNull()
  })

  test('an album scope states recursive and minRating explicitly', () => {
    expect(
      resolveShareSource({
        ...picker,
        scope: 'album',
        album: 'Ereignisse|Segeln 25',
        recursive: false,
        minRating: 4,
      }),
    ).toEqual({
      type: 'album',
      root: 'fuji',
      album: 'Ereignisse|Segeln 25',
      recursive: false,
      minRating: 4,
    })
  })

  test('rating 0 becomes null — a literal 0 would mean rating >= 0 and drop nothing', () => {
    const source = resolveShareSource({ ...picker, scope: 'album', album: 'A', minRating: 0 })
    expect(source).toMatchObject({ minRating: null })
  })

  test('a folder scope with an empty dir is the whole root, and is a real scope', () => {
    expect(resolveShareSource({ ...picker, scope: 'folder', dir: '' })).toEqual({
      type: 'folder',
      root: 'fuji',
      dir: '',
      recursive: true,
      minRating: null,
    })
  })

  test('the share root is carried through', () => {
    expect(
      resolveShareSource({ ...picker, scope: 'folder', root: 'share', dir: 'agent/2026-08' }),
    ).toMatchObject({ root: 'share', dir: 'agent/2026-08' })
  })

  test('every scope field is stated, so no field is left to a server default', () => {
    // Preview-equals-reality: the same object feeds GET /api/library/images and
    // POST /api/shares. A missing key here is a place they can disagree.
    for (const scope of ['album', 'folder'] as const) {
      const source = resolveShareSource({ ...picker, scope, album: 'A', dir: 'd' })
      expect(source).not.toBeNull()
      expect(Object.keys(source ?? {}).toSorted()).toEqual(
        scope === 'album'
          ? ['album', 'minRating', 'recursive', 'root', 'type']
          : ['dir', 'minRating', 'recursive', 'root', 'type'],
      )
    }
  })

  test('is pure — the same values twice produce equal sources', () => {
    const values = { ...picker, scope: 'album' as const, album: 'A', minRating: 3 }
    expect(resolveShareSource(values)).toEqual(resolveShareSource(values))
  })
})

// ── A share is never minted against an unseen count ──────────────────────────
//
// The guard used to test `total === 0` and staleness only, so submit stayed
// ENABLED for the whole time the preview request was in flight or retrying
// (`total === undefined`) — including after the retries were exhausted and the
// "Could not verify the image count" alert was on screen. One click then minted
// a friend-facing link over a scope nobody had a number for.
describe('isCreateShareBlocked', () => {
  const album: ShareSourceInput = {
    type: 'album',
    root: 'fuji',
    album: 'Ereignisse|Segeln 25',
    recursive: true,
    minRating: null,
  }

  test('a known, non-zero count unblocks', () => {
    expect(isCreateShareBlocked(album, { total: 550, fresh: true })).toBe(false)
  })

  test('an unknown count blocks even though nothing is stale', () => {
    // `fresh` says "this count belongs to the current scope" — it says nothing
    // about there BEING one. Both the in-flight/retrying preview and the one
    // that has given up land here, and both used to leave submit enabled.
    expect(isCreateShareBlocked(album, { total: undefined, fresh: true })).toBe(true)
  })

  test('a settling debounce blocks even while an older count is on screen', () => {
    expect(isCreateShareBlocked(album, { total: 550, fresh: false })).toBe(true)
  })

  test('an empty scope blocks — a share of nothing is a dead link', () => {
    expect(isCreateShareBlocked(album, { total: 0, fresh: true })).toBe(true)
  })

  test('nothing picked yet blocks', () => {
    expect(isCreateShareBlocked(null, { total: 12, fresh: true })).toBe(true)
  })

  test('a selection carries its own count, so it never waits on the preview', () => {
    const selection: ShareSourceInput = { type: 'selection', imageIds: [1, 2, 3] }
    expect(isCreateShareBlocked(selection, { total: undefined, fresh: false })).toBe(false)
    expect(
      isCreateShareBlocked({ type: 'selection', imageIds: [] }, { total: 0, fresh: true }),
    ).toBe(true)
  })
})

describe('shareScopeLabel', () => {
  test.each<[string, ShareSourceInput]>([
    ['Selected images', { type: 'selection', imageIds: [1, 2] }],
    [
      'Album fuji/Ereignisse|Segeln 25 (incl. sub-albums)',
      {
        type: 'album',
        root: 'fuji',
        album: 'Ereignisse|Segeln 25',
        recursive: true,
        minRating: null,
      },
    ],
    [
      'Album fuji/Ereignisse (this album only)',
      { type: 'album', root: 'fuji', album: 'Ereignisse', recursive: false, minRating: null },
    ],
    [
      'Album fuji/Ereignisse (incl. sub-albums) · 4★ and up',
      { type: 'album', root: 'fuji', album: 'Ereignisse', recursive: true, minRating: 4 },
    ],
    [
      'Folder share/agent/2026-08 (incl. subfolders)',
      { type: 'folder', root: 'share', dir: 'agent/2026-08', recursive: true, minRating: null },
    ],
    [
      'Folder fuji (this folder only)',
      { type: 'folder', root: 'fuji', dir: '', recursive: false, minRating: null },
    ],
  ])('reads %p', (expected, source) => {
    expect(shareScopeLabel(source)).toBe(expected)
  })

  test('rating 0 reads as no rating filter, matching what is actually sent', () => {
    expect(
      shareScopeLabel({ type: 'folder', root: 'fuji', dir: '', recursive: true, minRating: 0 }),
    ).not.toContain('★')
  })
})

describe('SettingsFormSchema / settingsInitialValues', () => {
  test('server nulls become the empty form values a controlled input needs', () => {
    expect(
      settingsInitialValues({ note: null, expiresAt: null, minRating: null, recursive: true }),
    ).toEqual({ note: '', expiresAt: '', minRating: 0, recursive: true })
  })

  test('stored values are shown as-is', () => {
    expect(
      settingsInitialValues({
        note: 'For the crew',
        expiresAt: '2026-12-31',
        minRating: 4,
        recursive: false,
      }),
    ).toEqual({ note: 'For the crew', expiresAt: '2026-12-31', minRating: 4, recursive: false })
  })

  test('the derived initial values are valid', () => {
    const values = settingsInitialValues({
      note: null,
      expiresAt: null,
      minRating: null,
      recursive: false,
    })
    expect(SettingsFormSchema.parse(values)).toEqual(values)
  })

  test('rejects an out-of-range rating', () => {
    expect(() =>
      SettingsFormSchema.parse({ note: '', expiresAt: '', minRating: 9, recursive: true }),
    ).toThrow()
  })
})

describe('toUpdateSharePatch', () => {
  const values: SettingsFormValues = {
    note: 'For the crew',
    expiresAt: '2026-12-31',
    minRating: 4,
    recursive: false,
  }

  test('a folder share sends the scope fields', () => {
    expect(toUpdateSharePatch({ id: 7, sourceType: 'folder' }, values)).toEqual({
      id: 7,
      note: 'For the crew',
      expiresAt: '2026-12-31',
      minRating: 4,
      recursive: false,
    })
  })

  test('an album share sends them too — that gate used to exclude albums', () => {
    expect(toUpdateSharePatch({ id: 7, sourceType: 'album' }, values)).toMatchObject({
      minRating: 4,
      recursive: false,
    })
  })

  test('a selection share omits them rather than sending a payload PATCH rejects', () => {
    const patch = toUpdateSharePatch({ id: 7, sourceType: 'selection' }, values)
    expect('minRating' in patch).toBe(false)
    expect('recursive' in patch).toBe(false)
    expect(patch).toEqual({ id: 7, note: 'For the crew', expiresAt: '2026-12-31' })
  })

  test('cleared text fields become null, so the server unsets them', () => {
    expect(
      toUpdateSharePatch({ id: 7, sourceType: 'folder' }, { ...values, note: '', expiresAt: '' }),
    ).toMatchObject({ note: null, expiresAt: null })
  })

  test('rating 0 becomes null — storing 0 would mean rating >= 0', () => {
    expect(
      toUpdateSharePatch({ id: 7, sourceType: 'folder' }, { ...values, minRating: 0 }),
    ).toMatchObject({ minRating: null })
  })
})
