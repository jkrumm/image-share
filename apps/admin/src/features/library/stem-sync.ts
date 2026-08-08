// The filename box is a debounced two-way binding against the URL, and that is
// the one place in this app where an effect pair can fight itself. Both
// directions live here as pure functions so the arbitration is testable without
// mounting the page — the failure it exists to prevent (a browser Back out of a
// filename filter immediately re-applying it) is a sequence, not a snapshot.
//
// The state is two values:
//   - `draft`   — what is in the box right now (user-owned, unnormalised)
//   - `pushed`  — the stem THIS component last wrote into the URL
//
// `pushed` is what tells "the URL moved because of me" apart from "the URL moved
// under me" (Back/Forward, a reset button, a pasted link).

/** URL form of a draft: trimmed, and empty means "no filter" rather than `LIKE '%%'`. */
export function normalizeStem(draft: string): string | undefined {
  const trimmed = draft.trim()
  return trimmed === '' ? undefined : trimmed
}

export type StemState = {
  draft: string
  pushed: string | undefined
}

/**
 * URL → box. Returns the new state, or null when the URL already says what this
 * component last pushed (i.e. it moved because of us — following it would rewind
 * the box to a stale value mid-keystroke).
 */
export function syncStemDown(
  current: Pick<StemState, 'pushed'>,
  stem: string | undefined,
): StemState | null {
  if (stem === current.pushed) return null
  return { draft: stem ?? '', pushed: stem }
}

/**
 * Box → URL. Returns the value to push, or null when there is nothing to do.
 *
 * Two guards, and the FIRST one is the fix:
 *
 *  1. `debounced !== draft` — the debounce has not settled on what is in the box.
 *     Without this, a URL change that resets the box (Back, "Reset filters")
 *     races the still-pending old debounce value and pushes the just-cleared
 *     filter straight back in, as a new history entry. The box is never allowed
 *     to publish a value it no longer holds.
 *  2. `next === pushed` — already in the URL; pushing again is a redundant
 *     navigation and refetch.
 */
export function pushStemUp(
  current: StemState,
  debounced: string,
): { pushed: string | undefined } | null {
  if (debounced !== current.draft) return null
  const next = normalizeStem(current.draft)
  if (next === current.pushed) return null
  return { pushed: next }
}
