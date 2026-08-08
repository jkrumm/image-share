import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useEffect } from 'react'
import { create } from 'zustand'
import { assetTokenQuery, assetTokenQueryKey } from './queries/asset-token'
import { queryClient } from './query-client'

type AssetTokenState = {
  token: string | null
  expiresAt: string | null
  setToken: (token: string, expiresAt: string) => void
}

// Deliberately NOT persisted (unlike useAuthStore) — the asset token is
// short-lived (1h) and re-minted every session, so caching it across reloads
// in localStorage would just resurrect an expired value.
export const useAssetTokenStore = create<AssetTokenState>()((set) => ({
  token: null,
  expiresAt: null,
  setToken: (token, expiresAt) => set({ token, expiresAt }),
}))

/**
 * Sync, NON-REACTIVE accessor. Correct outside render (a click handler opening
 * an original, a download href built on click). Inside render use
 * `useAssetTokenValue` — a component that reads this one keeps whatever token
 * was live when it painted, forever.
 */
export function getAssetToken(): string | null {
  return useAssetTokenStore.getState().token
}

/** Reactive token: the component re-renders whenever the token is re-minted. */
export function useAssetTokenValue(): string | null {
  return useAssetTokenStore((s) => s.token)
}

// Debounce window for forced re-mints. A grid of 60 thumbnails all 401 at once
// when a token expires; without this every one of them would fire its own mint.
const REFRESH_DEBOUNCE_MS = 10_000
let lastForcedRefreshAt = 0

/**
 * Forces an out-of-band re-mint. Call it when something OTHER than a query
 * failed on the token — in practice an `<img>` that 401'd, which TanStack Query
 * never sees. Debounced to at most one mint per 10 s so a whole failing grid
 * still costs a single request.
 */
export function refreshAssetToken(): void {
  const now = Date.now()
  if (now - lastForcedRefreshAt < REFRESH_DEBOUNCE_MS) return
  lastForcedRefreshAt = now
  void queryClient.refetchQueries({ queryKey: assetTokenQueryKey })
}

/**
 * Mints (and quietly re-mints, well inside the 1h TTL) the asset token and
 * keeps the store in sync. Mount once, near the auth gate, so every
 * `imageFileUrl` call downstream sees a live token.
 */
export function useAssetToken(): UseQueryResult<{ token: string; expiresAt: string }> {
  const setToken = useAssetTokenStore((s) => s.setToken)
  const query = useQuery(assetTokenQuery)

  useEffect(() => {
    if (query.data) setToken(query.data.token, query.data.expiresAt)
  }, [query.data, setToken])

  return query
}
