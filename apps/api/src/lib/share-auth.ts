import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../db/index.js'
import {
  images,
  shareImages,
  shares,
  shareTokens,
  type ImageRow,
  type ShareRow,
  type ShareTokenRow,
} from '../db/schema.js'

// Share access model (design §7, role-based rework). No cookies: a query
// `token` must match a non-revoked token of a non-expired share. The token
// carries a role (view|download|full) that governs which asset routes/sizes
// it can reach (enforced by share/routes.ts). Every denial on the public
// surface collapses to the single opaque 404 — the caller never learns which
// check failed (unknown slug, revoked/expired token, id outside the share, or
// a size/role the token doesn't permit).

export type ShareTokenRole = 'view' | 'download' | 'full'

// ── DB injection (tests) ─────────────────────────────────────────────────────
// Defaults to the process-wide singleton; unit tests inject an in-memory db.
let activeDb: Db = defaultDb

/** Override the db used by the share queries (tests). Pass the default to reset. */
export function setShareDb(database: Db): void {
  activeDb = database
}

// ── Share content query ──────────────────────────────────────────────────────

/**
 * WHERE predicate for a `source_type='folder'` share's images (design §7):
 * same root, dir at-or-below `share.dir`, kind='jpeg', rating >= min_rating.
 * An empty `share.dir` means the whole root (every dir). The `LIKE` wildcards
 * in the recursive branch are escaped so folder names containing `_`/`%`
 * can't over-match a sibling directory.
 */
function folderShareImageFilter(share: ShareRow) {
  const conds = [eq(images.root, share.root as string), eq(images.kind, 'jpeg')]
  if (share.dir) {
    const likePattern = share.dir.replace(/([\\%_])/g, '\\$1') + '/%'
    conds.push(or(eq(images.dir, share.dir), sql`${images.dir} LIKE ${likePattern} ESCAPE '\\'`)!)
  }
  if (share.minRating != null) {
    conds.push(gte(images.rating, share.minRating))
  }
  return and(...conds)
}

/**
 * List the images belonging to a share (design §7 rework): `source_type=
 * 'folder'` uses the folder membership filter, sorted by capture_at ascending;
 * `source_type='selection'` joins `share_images` and orders by `position`.
 */
export async function listShareImages(share: ShareRow): Promise<ImageRow[]> {
  if (share.sourceType === 'selection') {
    const rows = await activeDb
      .select({ image: images })
      .from(shareImages)
      .innerJoin(images, eq(images.id, shareImages.imageId))
      .where(eq(shareImages.shareId, share.id))
      .orderBy(asc(shareImages.position))
    return rows.map((r) => r.image)
  }
  return activeDb
    .select()
    .from(images)
    .where(folderShareImageFilter(share))
    .orderBy(asc(images.captureAt))
}

/**
 * Fetch a single image by id ONLY if it belongs to the share (design §7). Used
 * by the img/file routes for the per-share id-membership check — an id outside
 * the share resolves to null and the route 404s.
 */
export async function getShareImageById(share: ShareRow, id: number): Promise<ImageRow | null> {
  if (share.sourceType === 'selection') {
    const rows = await activeDb
      .select({ image: images })
      .from(shareImages)
      .innerJoin(images, eq(images.id, shareImages.imageId))
      .where(and(eq(shareImages.shareId, share.id), eq(shareImages.imageId, id)))
      .limit(1)
    return rows[0]?.image ?? null
  }
  const rows = await activeDb
    .select()
    .from(images)
    .where(and(eq(images.id, id), folderShareImageFilter(share)))
    .limit(1)
  return rows[0] ?? null
}

// ── Token / access resolution ────────────────────────────────────────────────

export interface ShareAccessQuery {
  slug: string
  token: string | undefined
}

export interface ResolvedShare {
  share: ShareRow
  token: string
  role: ShareTokenRole
}

/**
 * Validate slug + token + expiry + revocation and resolve the token's role.
 * Returns null for ANY failure (unknown slug, expired share, unknown/revoked
 * token) — every denial collapses to the single opaque 404 (design §7).
 */
async function lookupValidToken(query: ShareAccessQuery): Promise<ResolvedShare | null> {
  if (!query.token) return null
  const shareRows = await activeDb.select().from(shares).where(eq(shares.slug, query.slug)).limit(1)
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
  const tokenRows: ShareTokenRow[] = await activeDb
    .select()
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.token, query.token),
        eq(shareTokens.shareId, share.id),
        isNull(shareTokens.revokedAt),
      ),
    )
    .limit(1)
  const tokenRow = tokenRows[0]
  if (!tokenRow) return null
  return { share, token: query.token, role: tokenRow.role as ShareTokenRole }
}

/**
 * Resolve a share access request — shared by the PAGE surface (GET /s/:slug)
 * and the ASSET surface (img/file/zip). Returns null for ANY failure —
 * unknown slug, expired share, unknown/revoked token — so every denial
 * collapses to the single opaque 404. Role gating per route/size lives in
 * share/routes.ts.
 */
export function resolveShareAccess(query: ShareAccessQuery): Promise<ResolvedShare | null> {
  return lookupValidToken(query)
}

/**
 * Delete every `share_images` row for a share (used by PATCH's selection
 * replace-the-set semantics before re-inserting the new ordered set).
 */
export async function clearShareImages(shareId: number): Promise<void> {
  await activeDb.delete(shareImages).where(eq(shareImages.shareId, shareId))
}

/** Replace a selection share's image set, position = array order. */
export async function setShareImages(shareId: number, imageIds: number[]): Promise<void> {
  await clearShareImages(shareId)
  if (imageIds.length === 0) return
  await activeDb
    .insert(shareImages)
    .values(imageIds.map((imageId, position) => ({ shareId, imageId, position })))
}

/** Count of images in a share, for the admin list's `imageCount` (design §8). */
export async function shareImageCount(share: ShareRow): Promise<number> {
  if (share.sourceType === 'selection') {
    const rows = await activeDb
      .select({ imageId: shareImages.imageId })
      .from(shareImages)
      .where(eq(shareImages.shareId, share.id))
    return rows.length
  }
  const rows = await activeDb
    .select({ id: images.id })
    .from(images)
    .where(folderShareImageFilter(share))
  return rows.length
}
