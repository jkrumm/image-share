import { describe, expect, test } from 'bun:test'
import type { TokenDto, TokenRole } from '../../lib/queries/shares'
import {
  activeTokens,
  ROLE_COLOR,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  ROLE_OPTIONS,
  sortTokens,
} from './token-role'

const ROLES: TokenRole[] = ['view', 'download', 'full']

function token(partial: Partial<TokenDto> & { id: number }): TokenDto {
  return {
    role: 'view',
    label: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    revokedAt: null,
    url: `https://share.example.com/segeln-25?token=t${partial.id}`,
    ...partial,
  }
}

describe('role presentation tables', () => {
  test.each(ROLES)('%s has a colour, a label and a description', (role) => {
    expect(ROLE_COLOR[role]).toBeTruthy()
    expect(ROLE_LABEL[role]).toBeTruthy()
    expect(ROLE_DESCRIPTION[role]).toBeTruthy()
  })

  test('every role is offered exactly once by the shared Select options', () => {
    expect(ROLE_OPTIONS.map((option) => option.value)).toEqual(ROLES)
  })

  test('the two token-minting surfaces cannot drift — they read one option list', () => {
    for (const option of ROLE_OPTIONS) {
      expect(option.label.startsWith(ROLE_LABEL[option.value])).toBe(true)
    }
  })

  test('the roles are colour-distinct, so a badge is readable at a glance', () => {
    expect(new Set(Object.values(ROLE_COLOR)).size).toBe(ROLES.length)
  })
})

describe('activeTokens', () => {
  test('keeps only links that have not been revoked', () => {
    const tokens = [
      token({ id: 1 }),
      token({ id: 2, revokedAt: '2026-08-02T10:00:00.000Z' }),
      token({ id: 3 }),
    ]
    expect(activeTokens(tokens).map((t) => t.id)).toEqual([1, 3])
  })

  test('an all-revoked share has no active links', () => {
    expect(activeTokens([token({ id: 1, revokedAt: '2026-08-02T10:00:00.000Z' })])).toEqual([])
  })

  test('does not mutate the input', () => {
    const tokens = [token({ id: 1 }), token({ id: 2, revokedAt: '2026-08-02T10:00:00.000Z' })]
    activeTokens(tokens)
    expect(tokens).toHaveLength(2)
  })
})

describe('sortTokens', () => {
  test('the link you just minted is at the top, not below two revoked ones', () => {
    // The API returns tokens in id order, which is exactly the case the display
    // order exists to fix.
    const apiOrder = [
      token({ id: 1, createdAt: '2026-08-01T10:00:00.000Z' }),
      token({
        id: 2,
        createdAt: '2026-08-02T10:00:00.000Z',
        revokedAt: '2026-08-03T10:00:00.000Z',
      }),
      token({
        id: 3,
        createdAt: '2026-08-03T10:00:00.000Z',
        revokedAt: '2026-08-04T10:00:00.000Z',
      }),
      token({ id: 4, createdAt: '2026-08-05T10:00:00.000Z' }),
    ]
    expect(sortTokens(apiOrder).map((t) => t.id)).toEqual([4, 1, 3, 2])
  })

  test('active always outranks revoked, even when the revoked one is newer', () => {
    const tokens = [
      token({
        id: 1,
        createdAt: '2026-08-09T10:00:00.000Z',
        revokedAt: '2026-08-09T11:00:00.000Z',
      }),
      token({ id: 2, createdAt: '2026-08-01T10:00:00.000Z' }),
    ]
    expect(sortTokens(tokens).map((t) => t.id)).toEqual([2, 1])
  })

  test('within a group it is newest first', () => {
    const tokens = [
      token({ id: 1, createdAt: '2026-08-01T10:00:00.000Z' }),
      token({ id: 2, createdAt: '2026-08-09T10:00:00.000Z' }),
      token({ id: 3, createdAt: '2026-08-05T10:00:00.000Z' }),
    ]
    expect(sortTokens(tokens).map((t) => t.id)).toEqual([2, 3, 1])
  })

  test('identical timestamps fall through to id, newest first', () => {
    const at = '2026-08-01T10:00:00.000Z'
    const tokens = [
      token({ id: 1, createdAt: at }),
      token({ id: 3, createdAt: at }),
      token({ id: 2, createdAt: at }),
    ]
    expect(sortTokens(tokens).map((t) => t.id)).toEqual([3, 2, 1])
  })

  test('an unparseable timestamp still yields a deterministic order via id', () => {
    const tokens = [
      token({ id: 1, createdAt: 'not a date' }),
      token({ id: 2, createdAt: 'also not a date' }),
    ]
    expect(sortTokens(tokens).map((t) => t.id)).toEqual([2, 1])
  })

  test('does not mutate the array the query cache handed it', () => {
    const tokens = [
      token({ id: 1, createdAt: '2026-08-01T10:00:00.000Z' }),
      token({ id: 2, createdAt: '2026-08-09T10:00:00.000Z' }),
    ]
    const sorted = sortTokens(tokens)
    expect(tokens.map((t) => t.id)).toEqual([1, 2])
    expect(sorted).not.toBe(tokens)
  })

  test('empty and single-token shares are handled', () => {
    expect(sortTokens([])).toEqual([])
    expect(sortTokens([token({ id: 1 })]).map((t) => t.id)).toEqual([1])
  })
})
