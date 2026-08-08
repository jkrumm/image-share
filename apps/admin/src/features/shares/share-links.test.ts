import { describe, expect, test } from 'bun:test'
import type { ShareDto, TokenDto } from '../../lib/queries/shares'
import { deriveShareBaseUrl } from './share-links'

function share(id: number, urls: string[]): ShareDto {
  const tokens: TokenDto[] = urls.map((url, index) => ({
    id: id * 10 + index,
    role: 'view',
    label: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    revokedAt: null,
    url,
  }))
  return {
    id,
    slug: `share-${id}`,
    title: `Share ${id}`,
    sourceType: 'album',
    root: 'fuji',
    dir: null,
    album: 'Ereignisse',
    recursive: true,
    minRating: null,
    expiresAt: null,
    note: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    imageCount: 0,
    tokens,
  }
}

describe('deriveShareBaseUrl', () => {
  test('recovers the production base from a minted link', () => {
    expect(deriveShareBaseUrl([share(1, ['https://share.example.com/segeln-25?token=abc'])])).toBe(
      'https://share.example.com',
    )
  })

  test('keeps a path prefix, which is how dev is configured', () => {
    expect(deriveShareBaseUrl([share(1, ['http://localhost:7720/s/segeln-25?token=abc'])])).toBe(
      'http://localhost:7720/s',
    )
  })

  test('a token containing no slash cannot move the cut point', () => {
    // base64url has no '/', so the last slash is always the one before the slug.
    expect(deriveShareBaseUrl([share(1, ['https://share.example.com/a-b-c?token=x-Y_9z'])])).toBe(
      'https://share.example.com',
    )
  })

  test('skips a share that has no links yet', () => {
    expect(
      deriveShareBaseUrl([share(1, []), share(2, ['https://share.example.com/two?token=abc'])]),
    ).toBe('https://share.example.com')
  })

  test('the first usable link wins', () => {
    expect(
      deriveShareBaseUrl([
        share(1, ['https://first.example.com/a?token=1', 'https://second.example.com/b?token=2']),
      ]),
    ).toBe('https://first.example.com')
  })

  test('no shares yet → null, so the caller shows a slug-only preview', () => {
    expect(deriveShareBaseUrl([])).toBeNull()
  })

  test('a share with no tokens at all → null', () => {
    expect(deriveShareBaseUrl([share(1, [])])).toBeNull()
  })

  test('a URL with no path separator → null rather than an empty base', () => {
    expect(deriveShareBaseUrl([share(1, ['segeln-25?token=abc'])])).toBeNull()
  })

  test('a leading-slash-only URL → null, not the empty string', () => {
    // `cut > 0` is what rules this out; `cut >= 0` would return ''.
    expect(deriveShareBaseUrl([share(1, ['/segeln-25?token=abc'])])).toBeNull()
  })
})
