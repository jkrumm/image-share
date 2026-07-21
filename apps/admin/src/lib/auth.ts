import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type AuthState = {
  token: string | null
  setToken: (token: string) => void
  clearToken: () => void
}

// Persisted bearer token store (argo pattern) — the admin surface has no app-level
// login; the API_SECRET bearer entered here is reused on every Eden request.
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      setToken: (token) => set({ token }),
      clearToken: () => set({ token: null }),
    }),
    { name: 'image-share-auth' },
  ),
)

export const getToken = (): string | null => useAuthStore.getState().token
export const clearToken = (): void => useAuthStore.getState().clearToken()

export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  return status === 401
}
