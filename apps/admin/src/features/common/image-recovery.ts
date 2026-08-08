// Recovery policy for a library `<img>` that failed to load.
//
// An expired asset token never reaches TanStack Query — it fails inside the
// browser's image loader — so the only recovery path is: re-mint once, let every
// URL change, and see whether the retry works. The hard part is knowing when to
// STOP, because a file that simply cannot be served (a RAF, a JPEG deleted from
// disk between index and view) fails again with the fresh token.
//
// Keying "already tried" on the TOKEN VALUE is what made the give-up branch
// unreachable: the re-mint itself changes the token, so the second failure
// always looked like a first failure for a new token, spent another (debounced,
// therefore no-op) re-mint, and returned — leaving the tile blank forever with
// no placeholder. It is keyed on the IMAGE instead, and re-armed by a successful
// load, so a token that expires again an hour later still recovers.

export type RemintState = {
  /** This image already spent its one re-mint since it last loaded. */
  attempted: boolean
}

export const FRESH_REMINT_STATE: RemintState = { attempted: false }

export function onImageError(
  state: RemintState,
  token: string | null,
): { action: 'remint' | 'broken'; next: RemintState } {
  if (token !== null && !state.attempted) {
    return { action: 'remint', next: { attempted: true } }
  }
  return { action: 'broken', next: state }
}

/** A successful load re-arms recovery — the next expiry has to be survivable too. */
export function onImageLoad(): RemintState {
  return FRESH_REMINT_STATE
}
