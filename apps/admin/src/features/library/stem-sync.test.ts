import { describe, expect, test } from 'bun:test'
import { normalizeStem, pushStemUp, syncStemDown, type StemState } from './stem-sync'

describe('normalizeStem', () => {
  test('empty and whitespace-only mean "no filter", not an empty LIKE', () => {
    expect(normalizeStem('')).toBeUndefined()
    expect(normalizeStem('   ')).toBeUndefined()
  })

  test('a typed value is trimmed', () => {
    expect(normalizeStem('  DSCF12 ')).toBe('DSCF12')
  })
})

describe('syncStemDown — URL to box', () => {
  test('follows a URL that moved on its own (Back, a pasted link)', () => {
    expect(syncStemDown({ pushed: undefined }, 'DSCF')).toEqual({ draft: 'DSCF', pushed: 'DSCF' })
  })

  test('ignores the URL when it says exactly what we pushed', () => {
    // Otherwise our own push rewinds the box to a stale value mid-keystroke.
    expect(syncStemDown({ pushed: 'DSCF' }, 'DSCF')).toBeNull()
  })

  test('an externally cleared stem empties the box', () => {
    expect(syncStemDown({ pushed: 'DSCF' }, undefined)).toEqual({ draft: '', pushed: undefined })
  })
})

describe('pushStemUp — box to URL', () => {
  test('pushes once the debounce has settled on what is in the box', () => {
    expect(pushStemUp({ draft: 'DSCF', pushed: undefined }, 'DSCF')).toEqual({ pushed: 'DSCF' })
  })

  test('does nothing while the debounce still holds an older value', () => {
    expect(pushStemUp({ draft: 'DSCF12', pushed: undefined }, 'DSCF')).toBeNull()
  })

  test('does not re-push a value already in the URL', () => {
    expect(pushStemUp({ draft: 'DSCF', pushed: 'DSCF' }, 'DSCF')).toBeNull()
  })

  test('clearing the box pushes undefined exactly once', () => {
    expect(pushStemUp({ draft: '', pushed: 'DSCF' }, '')).toEqual({ pushed: undefined })
    expect(pushStemUp({ draft: '', pushed: undefined }, '')).toBeNull()
  })

  test('trailing whitespace does not count as a new value', () => {
    expect(pushStemUp({ draft: 'DSCF ', pushed: 'DSCF' }, 'DSCF ')).toBeNull()
  })
})

/** Drives the two effects the way React does, so the test IS the sequence. */
function drive(initial: StemState) {
  let state = initial
  const pushes: (string | undefined)[] = []
  return {
    get state() {
      return state
    },
    pushes,
    /** The URL changed under us (Back/Forward, "Reset filters"). */
    urlSays(stem: string | undefined) {
      const next = syncStemDown(state, stem)
      if (next !== null) state = next
    },
    /** The 300 ms debounce emitted a value. */
    debounceEmits(debounced: string) {
      const next = pushStemUp(state, debounced)
      if (next === null) return
      state = { ...state, pushed: next.pushed }
      pushes.push(next.pushed)
    },
    /** A keystroke. */
    types(draft: string) {
      state = { ...state, draft }
    },
  }
}

describe('the Back / "Reset filters" sequence', () => {
  // The regression: the two effects run in the SAME commit when the parent hands
  // FilterBar a fresh `onChange`, and the push-up effect then re-applied the
  // still-undebounced old value — so Back never got past a filename filter and
  // the empty state's "Reset filters" visibly undid itself.

  test('Back out of a filename filter is not undone', () => {
    const box = drive({ draft: 'DSCF', pushed: 'DSCF' })

    // Same commit: sync-down empties the box, then the push-up effect runs while
    // the debounce still holds 'DSCF'.
    box.urlSays(undefined)
    expect(box.state.draft).toBe('')
    box.debounceEmits('DSCF')
    expect(box.pushes).toEqual([])

    // …and when the debounce finally settles on the empty box, there is still
    // nothing to push: the URL already says what the box says.
    box.debounceEmits('')
    expect(box.pushes).toEqual([])
    expect(box.state).toEqual({ draft: '', pushed: undefined })
  })

  test('typing still reaches the URL exactly once per settled value', () => {
    const box = drive({ draft: '', pushed: undefined })
    box.types('D')
    box.types('DS')
    box.debounceEmits('D') // stale: the box moved on
    box.debounceEmits('DS')
    box.debounceEmits('DS') // a re-render, not a new value
    expect(box.pushes).toEqual(['DS'])
  })

  test('a URL carrying a filename filter can be arrived at and left again', () => {
    const box = drive({ draft: '', pushed: undefined })
    box.urlSays('DSCF')
    expect(box.state.draft).toBe('DSCF')
    box.debounceEmits('DSCF')
    box.urlSays(undefined)
    box.debounceEmits('DSCF')
    box.debounceEmits('')
    expect(box.pushes).toEqual([])
  })
})
