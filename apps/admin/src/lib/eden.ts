import { treaty } from '@elysiajs/eden'
import type { App } from '@image-share/api'
import { toErrorMessage as basaltToErrorMessage } from 'basalt-ui/query'
import { getAssetToken } from './asset-token'
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

// ── Error surfacing ──────────────────────────────────────────────────────────
//
// `unwrap` (basalt-ui/query) throws the raw Eden envelope, which is a
// `{ status, value }` object — printing it directly gives `[object Object]`,
// which is why every call site historically fell back to a hardcoded string and
// swallowed the real reason ('slug already in use', 'recursive is rejected on a
// selection share', a 403 on deleting a fuji image). These two helpers are the
// only thing a page needs to show what actually happened.

/**
 * The HTTP status behind a thrown Eden envelope, when there is one. Use it to
 * branch (404 → "not found" copy) rather than to build a message — `toErrorMessage`
 * already folds the status into its text when the body carries nothing readable.
 */
export function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/**
 * The REAL server message for anything thrown by `unwrap` / a mutation, with a
 * caller-supplied fallback for the cases where the body genuinely says nothing.
 *
 * @example
 * notifyError(toErrorMessage(err, 'Could not create share'))
 */
export function toErrorMessage(err: unknown, fallback = 'Request failed'): string {
  if (err === null || err === undefined) return fallback
  const status = errorStatus(err)
  const message = basaltToErrorMessage(err).trim()
  const unusable =
    message === '' ||
    message === '{}' ||
    message === '[]' ||
    message === 'null' ||
    message === 'undefined' ||
    message === '[object Object]'
  if (unusable) return status === undefined ? fallback : `${fallback} (HTTP ${status})`
  return message
}

// ── Image bytes ──────────────────────────────────────────────────────────────

/**
 * Sizes accepted by `GET /api/library/images/{id}/file`. Deliberately NOT the
 * same union as the renditions module: the byte route still only enumerates
 * thumb|med|full|orig, so 'small' (a valid rendition size) is not addressable
 * here yet.
 */
export type ImageFileSize = 'thumb' | 'med' | 'full' | 'orig'

/**
 * Builds the byte-serving URL for a library image, carrying the short-lived
 * `assetToken` (the only route that accepts it — for browser `<img>` tags, which
 * cannot send an Authorization header).
 *
 * Pass `assetToken` explicitly from a component that subscribes to the token
 * store (`useImageFileUrl` / `<LibraryImage>` in features/common do exactly
 * that) so the URL is rebuilt when the token is re-minted. The no-argument form
 * reads the store non-reactively and is only correct OUTSIDE render — a click
 * handler opening a full-size image, an anchor href built at click time.
 */
export function imageFileUrl(id: number, size: ImageFileSize, assetToken?: string | null): string {
  const token = (assetToken === undefined ? getAssetToken() : assetToken) ?? ''
  const params = new URLSearchParams({ size, assetToken: token })
  return `${baseUrl}/api/library/images/${id}/file?${params.toString()}`
}
