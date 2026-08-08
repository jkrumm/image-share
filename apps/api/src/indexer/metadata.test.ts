import { describe, expect, it } from 'bun:test'
import { extractKeywordPaths, keywordLeaf, parseFilenameDate } from './metadata.js'

// Pure unit tests for the filename capture-date fallback (design §5, §13).
describe('parseFilenameDate', () => {
  it('parses the YYYY-MM-DD_HH-MM-SS convention', () => {
    expect(parseFilenameDate('2026-07-21_14-30-05_foo.jpg')).toBe('2026-07-21T14:30:05')
  })

  it('parses the pattern with a space separator', () => {
    expect(parseFilenameDate('2026-07-21 14-30-05.RAF')).toBe('2026-07-21T14:30:05')
  })

  it('parses the pattern anywhere in the filename, not just the start', () => {
    expect(parseFilenameDate('IMG_2026-07-21_14-30-05.jpg')).toBe('2026-07-21T14:30:05')
  })

  it('returns null when no date pattern is present', () => {
    expect(parseFilenameDate('DSCF0001.RAF')).toBeNull()
    expect(parseFilenameDate('mallorca-sunset.jpg')).toBeNull()
  })

  it('returns null for an invalid calendar date (month 13)', () => {
    expect(parseFilenameDate('2026-13-21_14-30-05_foo.jpg')).toBeNull()
  })

  it('returns null for an invalid calendar date (day 32)', () => {
    expect(parseFilenameDate('2026-01-32_14-30-05_foo.jpg')).toBeNull()
  })
})

// Pure unit tests for the album-keyword extraction. The tag shapes below are
// the ones exifr actually returns for the real library — verified against
// /photos/fuji, where 558 of 2352 JPEGs carry Lightroom keywords and the rest
// carry none at all.
describe('extractKeywordPaths', () => {
  it('reads hierarchicalSubject in the shape the real library returns', () => {
    expect(
      extractKeywordPaths({
        hierarchicalSubject: ['Ereignisse|Segeln 25', 'Insta Post Segel 25'],
        subject: ['Segeln 25', 'Insta Post Segel 25'],
        Keywords: ['Segeln 25', 'Insta Post Segel 25'],
        Rating: 3,
      }),
    ).toEqual(['Ereignisse|Segeln 25', 'Insta Post Segel 25'])
  })

  it('prefers hierarchicalSubject over its flat mirrors rather than merging them', () => {
    // Merging would re-add 'Segeln 25' as a second, root-level album.
    expect(
      extractKeywordPaths({
        hierarchicalSubject: ['Ereignisse|Segeln 25'],
        subject: ['Segeln 25'],
      }),
    ).toEqual(['Ereignisse|Segeln 25'])
  })

  it('falls back to subject when hierarchicalSubject is absent', () => {
    expect(extractKeywordPaths({ subject: ['Segeln 25'], Keywords: ['Segeln 25'] })).toEqual([
      'Segeln 25',
    ])
  })

  it('falls back to IPTC Keywords when neither XMP tag is present', () => {
    expect(extractKeywordPaths({ Keywords: ['Marokko', 'Reise'] })).toEqual(['Marokko', 'Reise'])
  })

  it('accepts a bare string — exifr unwraps single-valued set tags', () => {
    expect(extractKeywordPaths({ hierarchicalSubject: 'Ereignisse|Segeln 25' })).toEqual([
      'Ereignisse|Segeln 25',
    ])
    expect(extractKeywordPaths({ subject: 'Solo' })).toEqual(['Solo'])
  })

  it('returns no paths for an untagged file, absent tags, or a failed parse', () => {
    expect(extractKeywordPaths({ Rating: 3 })).toEqual([])
    expect(extractKeywordPaths({})).toEqual([])
    expect(extractKeywordPaths(null)).toEqual([])
    expect(extractKeywordPaths(undefined)).toEqual([])
  })

  it('trims segments and drops empty ones without collapsing the path', () => {
    expect(extractKeywordPaths({ hierarchicalSubject: [' Ereignisse | Segeln 25 '] })).toEqual([
      'Ereignisse|Segeln 25',
    ])
    expect(extractKeywordPaths({ hierarchicalSubject: ['Ereignisse||Segeln 25'] })).toEqual([
      'Ereignisse|Segeln 25',
    ])
  })

  it('drops paths that normalize to nothing and falls through to the next tag', () => {
    expect(
      extractKeywordPaths({ hierarchicalSubject: ['', '  ', '|'], subject: ['Segeln 25'] }),
    ).toEqual(['Segeln 25'])
  })

  it('dedupes while preserving source order', () => {
    // Lightroom writes dc:subject twice on some files (via Subject AND
    // Keywords), so exifr hands back a duplicated array.
    expect(
      extractKeywordPaths({
        subject: ['Segeln 25', 'Insta Post Segel 25', 'Segeln 25', 'Insta Post Segel 25'],
      }),
    ).toEqual(['Segeln 25', 'Insta Post Segel 25'])
  })

  it('ignores non-string members of a mixed array', () => {
    expect(extractKeywordPaths({ hierarchicalSubject: ['Segeln 25', 42, null] })).toEqual([
      'Segeln 25',
    ])
  })
})

describe('keywordLeaf', () => {
  it('returns the last segment of a hierarchical path', () => {
    expect(keywordLeaf('Ereignisse|Segeln 25')).toBe('Segeln 25')
    expect(keywordLeaf('a|b|c')).toBe('c')
  })

  it('returns the whole string for a flat keyword', () => {
    expect(keywordLeaf('Insta Post Marokko')).toBe('Insta Post Marokko')
  })
})
