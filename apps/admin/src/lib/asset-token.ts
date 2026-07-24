import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { create } from 'zustand'
import { assetTokenQuery } from './queries/asset-token'

type AssetTokenState = {
  token: string | null
  setToken: (token: string) => void
}

// Deliberately NOT persisted (unlike useAuthStore) — the asset token is
// short-lived (1h) and re-minted every session, so caching it across reloads
// in localStorage would just resurrect an expired value.
export const useAssetTokenStore = create<AssetTokenState>()((set) => ({
  token: null,
  setToken: (token) => set({ token }),
}))

/** Sync accessor for `imageFileUrl`, which builds URLs inline during render. */
export function getAssetToken(): string | null {
  return useAssetTokenStore.getState().token
}

/**
 * Mints (and quietly re-mints, well inside the 1h TTL) the asset token and
 * keeps the store in sync. Mount once, near the auth gate, so every
 * `imageFileUrl` call downstream sees a live token.
 */
export function useAssetToken() {
  const setToken = useAssetTokenStore((s) => s.setToken)
  const query = useQuery(assetTokenQuery)

  useEffect(() => {
    if (query.data) setToken(query.data.token)
  }, [query.data, setToken])

  return query
}
