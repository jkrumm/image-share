import { describe, expect, test } from 'bun:test'
import {
  B2SearchSchema,
  B2_PAGE_LIMIT,
  isB2Filtered,
  toB2ListParams,
  type B2SearchParams,
} from './search-params'

function parse(raw: Record<string, unknown>): B2SearchParams {
  return B2SearchSchema.parse(raw)
}

describe('B2SearchSchema — defaults', () => {
  test('a bare URL shows the whole bucket, newest first', () => {
    expect(parse({})).toEqual({
      prefix: 'all',
      q: '',
      page: 1,
      sort: 'lastModified',
      order: 'desc',
    })
  })

  test('the search box defaults to empty, not undefined — it is a controlled input', () => {
    expect(parse({}).q).toBe('')
  })
})

describe('B2SearchSchema — round-trip', () => {
  test('a fully specified search parses to itself', () => {
    const search: B2SearchParams = {
      prefix: 'gen',
      q: '2026/07',
      page: 2,
      sort: 'size',
      order: 'asc',
    }
    expect(parse(search)).toEqual(search)
  })

  test('every publishable prefix plus "all" is accepted', () => {
    for (const prefix of ['all', 'fuji', 'blog', 'gen', 'misc'] as const) {
      expect(parse({ prefix }).prefix).toBe(prefix)
    }
  })

  test('every sort column is accepted', () => {
    for (const sort of ['lastModified', 'key', 'size'] as const) {
      expect(parse({ sort }).sort).toBe(sort)
    }
  })
})

describe('B2SearchSchema — rejects invalid', () => {
  const invalid: [string, Record<string, unknown>][] = [
    ['an unknown prefix', { prefix: 'raws' }],
    ['a prefix that is only a CDN path segment', { prefix: 'img' }],
    ['page 0', { page: 0 }],
    ['a fractional page', { page: 2.5 }],
    ['a page as a string', { page: '2' }],
    ['an unknown sort column', { sort: 'etag' }],
    ['an unknown order', { order: 'up' }],
    ['a non-string query', { q: 42 }],
  ]

  for (const [name, raw] of invalid) {
    test(`rejects ${name}`, () => {
      expect(() => parse(raw)).toThrow()
    })
  }
})

describe('toB2ListParams', () => {
  test('an empty box is no filter at all, not q=""', () => {
    const params = toB2ListParams(parse({}))
    expect('q' in params).toBe(false)
    expect(params).toEqual({
      prefix: 'all',
      page: 1,
      limit: B2_PAGE_LIMIT,
      sort: 'lastModified',
      order: 'desc',
    })
  })

  test('a typed query is forwarded verbatim', () => {
    expect(toB2ListParams(parse({ q: 'DSCF' })).q).toBe('DSCF')
  })

  test('the limit is the shared page size unless overridden', () => {
    expect(toB2ListParams(parse({})).limit).toBe(B2_PAGE_LIMIT)
    expect(toB2ListParams(parse({}), 12).limit).toBe(12)
  })

  test('prefix, page, sort and order are carried through', () => {
    expect(
      toB2ListParams(parse({ prefix: 'blog', page: 3, sort: 'key', order: 'asc' })),
    ).toMatchObject({ prefix: 'blog', page: 3, sort: 'key', order: 'asc' })
  })
})

describe('isB2Filtered', () => {
  test.each([
    [false, {}],
    [true, { prefix: 'fuji' }],
    [true, { q: 'DSCF' }],
    [true, { prefix: 'gen', q: 'DSCF' }],
  ])('is %p for %o', (expected, raw) => {
    expect(isB2Filtered(parse(raw))).toBe(expected)
  })

  test('an explicit prefix=all with an empty box is still unfiltered', () => {
    expect(isB2Filtered(parse({ prefix: 'all', q: '' }))).toBe(false)
  })
})
