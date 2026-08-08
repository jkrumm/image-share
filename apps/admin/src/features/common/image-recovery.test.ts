import { describe, expect, test } from 'bun:test'
import { FRESH_REMINT_STATE, onImageError, onImageLoad, type RemintState } from './image-recovery'

/** Drives the same sequence `LibraryImage` drives, so the test IS the lifecycle. */
function tile() {
  let state: RemintState = FRESH_REMINT_STATE
  const actions: ('remint' | 'broken')[] = []
  return {
    actions,
    fails(token: string | null) {
      const { action, next } = onImageError(state, token)
      state = next
      actions.push(action)
      return action
    },
    loads() {
      state = onImageLoad()
    },
  }
}

describe('onImageError', () => {
  test('the first failure spends one re-mint — an expired token is invisible to react-query', () => {
    expect(tile().fails('T1')).toBe('remint')
  })

  test('with no token minted yet there is nothing to re-mint', () => {
    expect(tile().fails(null)).toBe('broken')
  })

  test('a second failure gives up even though the token changed', () => {
    // The regression: "already tried" was keyed on the token VALUE, but the
    // re-mint is what changes the token — so the second failure looked like a
    // first failure for a new token, spent another (debounced, therefore no-op)
    // re-mint and returned. `src` never changed again, the browser never
    // re-fired `onError`, and the "Unavailable" placeholder was unreachable: a
    // permanently broken tile stayed a blank box forever.
    const t = tile()
    t.fails('T1') // → remint
    t.fails('T2') // ← the fresh token the re-mint produced
    expect(t.actions).toEqual(['remint', 'broken'])
  })

  test('it never re-mints more than once per failure episode', () => {
    const t = tile()
    for (const token of ['T1', 'T2', 'T3', 'T4']) t.fails(token)
    expect(t.actions.filter((a) => a === 'remint')).toHaveLength(1)
  })

  test('a successful load re-arms recovery, so the next expiry is survivable too', () => {
    const t = tile()
    t.fails('T1') // token expired → re-mint
    t.loads() // the retry with the fresh token worked
    expect(t.fails('T2')).toBe('remint') // an hour later it expires again
  })
})
