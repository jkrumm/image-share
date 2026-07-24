import { queryOptions } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'

// Mints the short-lived (1h) token that authorizes the library byte route for
// browser <img> tags (see apps/api/src/lib/asset-token.ts). Refetch well
// inside the 1h TTL so the store never holds an expired token; window-focus
// refetch is off — nothing about a tab regaining focus makes the current
// token stale.
export const assetTokenQuery = queryOptions({
  queryKey: ['asset-token'] as const,
  queryFn: () => unwrap(client.api.library['asset-token'].post()),
  staleTime: 45 * 60 * 1000,
  refetchInterval: 45 * 60 * 1000,
  refetchOnWindowFocus: false,
})
