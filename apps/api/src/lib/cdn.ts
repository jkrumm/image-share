import { env } from '../env.js'

// CDN URL construction — the single source of truth for both publish.ts and
// the b2 listing route (design §8/§12 stage 4).
//
// Verified live against the real infra (2026-07-22), not assumed from
// docs/image-cdn.md alone: img.jkrumm.com's Traefik layer
// (~/SourceRoot/vps/apps/imgproxy/compose.yml) runs an `imgproxy-short`
// replacepathregex middleware in front of imgproxy that rewrites
// `/<opt:val/...><key>` into imgproxy's raw `/_/<opt:val/...>plain/img/<key>`
// form. Confirmed with curl against the live `img/misc/cdn-smoke-test.jpg`
// object: the bare short form serves the original, and prefixing a
// `rs:fit:<width>/` processing-options segment serves a resized rendition —
// both cache-busted to rule out a stale edge hit. So `${CDN_BASE}/<key minus
// img/ prefix>` (no processing options) is the CORRECT original-image URL,
// matching what publish.ts already emitted before this stage.

function keyWithoutPrefix(key: string): string {
  return key.startsWith(env.B2_PREFIX) ? key.slice(env.B2_PREFIX.length) : key
}

/** Original-bytes CDN URL: `${CDN_BASE}/<key minus img/ prefix>` (short form,
 * no processing options — Traefik's imgproxy-short middleware expands it). */
export function cdnOriginalUrl(key: string): string {
  return `${env.CDN_BASE}/${keyWithoutPrefix(key)}`
}

/** Resized-thumbnail CDN URL: same short form with a leading `rs:fit:<width>/`
 * processing-options segment (imgproxy's `rs:fit:N` bounds the longest side). */
export function cdnThumbUrl(key: string, width: number): string {
  return `${env.CDN_BASE}/rs:fit:${width}/${keyWithoutPrefix(key)}`
}
