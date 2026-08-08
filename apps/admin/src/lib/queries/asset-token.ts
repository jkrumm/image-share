import { queryOptions } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { isUnauthorizedError } from '../auth'
import { client } from '../eden'

export const assetTokenQueryKey = ['asset-token'] as const

/**
 * Re-mint interval. The server TTL is 1 h (apps/api/src/lib/asset-token.ts
 * ASSET_TOKEN_TTL_SECONDS = 3600); 20 min leaves 3× headroom.
 *
 * The old 45 min against a 60 min TTL only held while the tab was in the
 * foreground: browsers clamp `setTimeout` in hidden tabs (≥1 min, and much
 * worse under battery saver / after ~5 min of backgrounding), so a laptop that
 * slept overnight woke up with an expired token, every thumbnail 401'd, and
 * nothing re-minted.
 */
export const ASSET_TOKEN_REFRESH_MS = 20 * 60 * 1000

// Mints the short-lived token that authorizes the library byte route for
// browser <img> tags (see apps/api/src/lib/asset-token.ts).
//
// Four recovery paths, because a stale token is invisible to TanStack Query —
// it surfaces as an <img> load failure, not a query error:
//   1. refetchInterval + refetchIntervalInBackground — the timer keeps running
//      when the tab is hidden (clamped, but it fires).
//   2. refetchOnWindowFocus — a tab returning from a long sleep re-mints before
//      it repaints, which is the case the interval alone cannot cover.
//   3. refetchOnReconnect — a token minted before a network drop is usually
//      fine, but the re-mint is one cheap HMAC and removes the doubt.
//   4. refreshAssetToken() (lib/asset-token.ts), called by <LibraryImage> when
//      an image 401s — the only signal for "the token died between refetches".
// A 401 on the mint itself is terminal (the bearer is gone): don't retry it,
// let queryClient's onError clear the bearer and bounce back to the prompt.
export const assetTokenQuery = queryOptions({
  queryKey: assetTokenQueryKey,
  queryFn: () => unwrap(client.api.library['asset-token'].post()),
  staleTime: ASSET_TOKEN_REFRESH_MS,
  refetchInterval: ASSET_TOKEN_REFRESH_MS,
  refetchIntervalInBackground: true,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  // `error` is typed Error by TanStack's defaults; at runtime it is the raw
  // Eden `{ status, value }` envelope, which isUnauthorizedError handles.
  retry: (failureCount: number, error: Error) => {
    if (isUnauthorizedError(error)) return false
    return failureCount < 3
  },
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
})
