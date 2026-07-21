import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../db/index.js'
import { images, shares, shareTokens, type ImageRow, type ShareRow } from '../db/schema.js'
import { env } from '../env.js'

// Share access model (design §7). No cookies: a query `token` must match a
// non-revoked token of a non-expired share. When the share is password
// protected, the query `k` must additionally equal
// `hmacSha256Hex(password_hash, token).slice(0, 32)` (timing-safe compared).
// Every denial on the ASSET surface collapses to the same opaque 404 — the
// caller never learns which check failed. The PAGE surface is the one exception:
// a valid token on a password share renders the unlock form (the recipient
// already holds the token; the password is a second factor), while an invalid
// token still collapses to the opaque 404.

// ── DB injection (tests) ─────────────────────────────────────────────────────
// Defaults to the process-wide singleton; unit tests inject an in-memory db.
let activeDb: Db = defaultDb

/** Override the db used by the share queries (tests). Pass the default to reset. */
export function setShareDb(database: Db): void {
  activeDb = database
}

// ── Capability derivation ────────────────────────────────────────────────────

/**
 * Derive the `k` capability value threaded into asset URLs after a successful
 * unlock. Keyed on the stored password hash so rolling the password (or the
 * token) invalidates every previously-minted `k`. Pure — safe to unit test.
 */
export function computeK(passwordHash: string, token: string): string {
  return createHmac('sha256', passwordHash).update(token).digest('hex').slice(0, 32)
}

/**
 * Constant-time comparison of two hex strings of equal length. Returns false
 * (never throws) on any length mismatch or malformed input so it collapses into
 * the opaque-404 path.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

// ── Filesystem roots ─────────────────────────────────────────────────────────

/** Absolute base directory for an image root (design §3). */
export function rootBaseDir(root: string): string {
  switch (root) {
    case 'library':
      return env.LIBRARY_ROOT
    case 'raws':
      return env.RAWS_ROOT
    case 'uploads':
      return env.UPLOADS_DIR
    default:
      throw new Error(`unknown image root: ${root}`)
  }
}

// ── Share content query ──────────────────────────────────────────────────────

/**
 * WHERE predicate for the images belonging to a share (design §7): same root,
 * dir at-or-below `share.dir`, kind='jpeg', rating >= min_rating. An empty
 * `share.dir` means the whole root (every dir). The `LIKE` wildcards in the
 * recursive branch are escaped so folder names containing `_`/`%` can't
 * over-match a sibling directory.
 */
function shareImageFilter(share: ShareRow) {
  const conds = [eq(images.root, share.root), eq(images.kind, 'jpeg')]
  if (share.dir !== '') {
    const likePattern = share.dir.replace(/([\\%_])/g, '\\$1') + '/%'
    conds.push(or(eq(images.dir, share.dir), sql`${images.dir} LIKE ${likePattern} ESCAPE '\\'`)!)
  }
  if (share.minRating != null) {
    conds.push(gte(images.rating, share.minRating))
  }
  return and(...conds)
}

/**
 * List the images belonging to a share, ordered by capture_at ascending (design
 * §7). `capture_at` may be null; SQLite sorts nulls first.
 */
export function listShareImages(share: ShareRow): Promise<ImageRow[]> {
  return activeDb
    .select()
    .from(images)
    .where(shareImageFilter(share))
    .orderBy(asc(images.captureAt))
}

/**
 * Fetch a single image by id ONLY if it belongs to the share (design §7). Used
 * by the img/file routes for the per-share id-membership check — an id outside
 * the share resolves to null and the route 404s.
 */
export async function getShareImageById(share: ShareRow, id: number): Promise<ImageRow | null> {
  const rows = await activeDb
    .select()
    .from(images)
    .where(and(eq(images.id, id), shareImageFilter(share)))
    .limit(1)
  return rows[0] ?? null
}

// ── Token / access resolution ────────────────────────────────────────────────

/**
 * Validate slug + token + expiry + revocation, ignoring any password. Returns
 * the share and echoed token, or null for ANY failure (unknown slug, expired
 * share, unknown/revoked token). This is the token-only gate shared by the page
 * and unlock flows; it never distinguishes cases.
 */
async function lookupValidToken(
  slug: string,
  token: string | undefined,
): Promise<{ share: ShareRow; token: string } | null> {
  if (!token) return null
  const shareRows = await activeDb.select().from(shares).where(eq(shares.slug, slug)).limit(1)
  const share = shareRows[0]
  if (!share) return null
  // Fail CLOSED on expiry: an unparseable `expires_at` (Date.parse → NaN) is
  // treated as expired, not as "never expires". `NaN <= Date.now()` is false, so
  // the naive gate would silently keep a malformed-expiry share public forever.
  // The admin schema now rejects malformed dates on write, but this also closes
  // the exposure for any pre-existing bad row.
  const expiresAtMs = share.expiresAt ? Date.parse(share.expiresAt) : null
  if (expiresAtMs !== null && (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now())) {
    return null
  }
  const tokenRows = await activeDb
    .select()
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.token, token),
        eq(shareTokens.shareId, share.id),
        isNull(shareTokens.revokedAt),
      ),
    )
    .limit(1)
  if (!tokenRows[0]) return null
  return { share, token }
}

export interface ShareAccessQuery {
  slug: string
  token: string | undefined
  k: string | undefined
}

export interface ResolvedShare {
  share: ShareRow
  token: string
  /** `k` to thread into asset URLs (empty for non-password shares). */
  k: string
}

/**
 * Resolve a share access request for the ASSET surface (img/file/zip). Returns
 * null for ANY failure — including a valid token on a password share with a
 * missing/wrong `k` — so every asset denial collapses to the single opaque 404.
 * The `k` compare is timing-safe (design §7).
 */
export async function resolveShareAccess(query: ShareAccessQuery): Promise<ResolvedShare | null> {
  const valid = await lookupValidToken(query.slug, query.token)
  if (!valid) return null
  const { share, token } = valid
  if (share.passwordHash) {
    const expected = computeK(share.passwordHash, token)
    if (!query.k || !timingSafeEqualHex(query.k, expected)) return null
    return { share, token, k: expected }
  }
  return { share, token, k: '' }
}

export interface PageAccess extends ResolvedShare {
  /** True when the token is valid but the password `k` is missing/wrong. */
  needsUnlock: boolean
}

/**
 * Resolve the GET /s/:slug PAGE request. Three outcomes:
 * - null → opaque 404: invalid/revoked/expired token, unknown slug, OR a
 *   password share where a `k` WAS supplied but is wrong (tamper → never
 *   distinguished from a bad link).
 * - `needsUnlock: true` → the token is valid but no `k` was supplied yet on a
 *   password share: render the unlock form (the recipient holds the token; the
 *   password is a second factor).
 * - `needsUnlock: false` → gallery, with the `k` to thread into asset URLs.
 * The `k` compare is timing-safe (design §7).
 */
export async function resolveShareForPage(query: ShareAccessQuery): Promise<PageAccess | null> {
  const valid = await lookupValidToken(query.slug, query.token)
  if (!valid) return null
  const { share, token } = valid
  if (share.passwordHash) {
    // No `k` yet → offer the unlock form; a supplied-but-wrong `k` → opaque 404.
    if (!query.k) return { share, token, k: '', needsUnlock: true }
    const expected = computeK(share.passwordHash, token)
    if (!timingSafeEqualHex(query.k, expected)) return null
    return { share, token, k: expected, needsUnlock: false }
  }
  return { share, token, k: '', needsUnlock: false }
}

/**
 * Token-only resolution for the unlock POST. Validates slug + token + expiry +
 * revocation (never the password); the caller then verifies the submitted
 * password. Null → opaque 404.
 */
export async function resolveShareToken(input: {
  slug: string
  token: string | undefined
}): Promise<{ share: ShareRow; token: string } | null> {
  return lookupValidToken(input.slug, input.token)
}

/**
 * Verify a share password on unlock. Returns the freshly-computed `k` on
 * success or null on failure (wrong password, or a share with no password set).
 */
export async function verifySharePassword(input: {
  share: ShareRow
  token: string
  password: string
}): Promise<string | null> {
  if (!input.share.passwordHash) return null
  const ok = await Bun.password.verify(input.password, input.share.passwordHash)
  if (!ok) return null
  return computeK(input.share.passwordHash, input.token)
}
