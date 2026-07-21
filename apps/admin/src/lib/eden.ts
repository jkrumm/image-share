import { treaty } from '@elysiajs/eden'
import type { App } from '@image-share/api'
import { getToken } from './auth'

// Unlike argo's bare backend routes (baseUrl = `${origin}/api`), image-share's
// Elysia routes carry their own literal `/api/...` prefix (design §10, divergence
// #2 — Caddy does not strip it in prod). The Eden baseUrl is therefore the bare
// origin; the dev proxy (vite.config.ts) forwards `/api/*` to :7720 unchanged.
const baseUrl = import.meta.env.VITE_API_URL ?? window.location.origin
// Named `client` (not `api`) because every route already carries a literal
// `/api/...` path segment — calls read as `client.api.library.dirs.get()`.
export const client = treaty<App>(baseUrl, {
  parseDate: false,
  headers: () => {
    const token = getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  },
})

// `unwrap`/`toErrorMessage` for the { data, error } Eden envelope live in
// basalt-ui/query — import from there rather than duplicating.

/** Builds the byte-serving URL for a library image, carrying the bearer as
 * `access_token` (the only route that accepts it — for browser <img> tags,
 * which cannot send an Authorization header). */
export function imageFileUrl(id: number, size: 'thumb' | 'med' | 'full' | 'orig'): string {
  const token = getToken() ?? ''
  const params = new URLSearchParams({ size, access_token: token })
  return `${baseUrl}/api/library/images/${id}/file?${params.toString()}`
}
