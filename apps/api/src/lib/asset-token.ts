import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../env.js'

// Short-lived, HMAC-signed token scoped to the library byte route (design §8
// rework). Minted per admin session via POST /api/library/asset-token (bearer-
// guarded) so a browser `<img>` tag can load thumbnails without ever putting
// the all-powerful API_SECRET in a URL that rides through Cloudflare/logs.
//
// Format: `${exp}.${hmacSha256Hex('asset-token:v1:' + exp)}`, keyed by
// API_SECRET. Stateless (no DB/cache row) — verification just recomputes the
// signature and checks `exp` against the clock.

export const ASSET_TOKEN_TTL_SECONDS = 3600

function sign(exp: number): string {
  return createHmac('sha256', env.API_SECRET).update(`asset-token:v1:${exp}`).digest('hex')
}

export function mintAssetToken(): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ASSET_TOKEN_TTL_SECONDS
  const token = `${exp}.${sign(exp)}`
  return { token, expiresAt: new Date(exp * 1000).toISOString() }
}

/**
 * Fails CLOSED on any malformed input — a token that doesn't parse cleanly
 * into exactly `<exp>.<sig>` is rejected, never partially trusted.
 */
export function verifyAssetToken(token: string | undefined | null): boolean {
  if (!token) return false
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return false
    const [expPart, sigPart] = parts
    if (!expPart || !sigPart) return false
    const exp = Number.parseInt(expPart, 10)
    if (!Number.isFinite(exp) || !Number.isInteger(exp)) return false
    if (exp <= Math.floor(Date.now() / 1000)) return false

    const expected = Buffer.from(sign(exp), 'utf8')
    const actual = Buffer.from(sigPart, 'utf8')
    // timingSafeEqual throws on unequal-length buffers — guard first so a
    // wrong-length signature fails closed rather than throwing past the caller.
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
