import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  min,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm'
import { db as defaultDb, type Db } from '../db/index.js'
import { albumAtOrBelow } from './album-scope.js'
import { dirAtOrBelow } from './dir-scope.js'
import {
  imageKeywords,
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
 * "This image carries a keyword at or below `album`" as a correlated EXISTS
 * sub-select, so an album scope composes into the same flat `images` WHERE
 * clause the folder scope already uses.
 *
 * Deliberately EXISTS and not an INNER JOIN on `image_keywords`: an image
 * tagged with two paths inside the same album ('Ereignisse|Segeln 25' AND
 * 'Ereignisse|Segeln 25|Tag 1') matches the scope twice, and a join would
 * therefore list — and count — that photo twice. EXISTS is a semi-join: at
 * most one row per image, and it still uses `image_keywords_path_idx` via the
 * sargable range inside `albumAtOrBelow`.
 */
function albumMembership(album: string, recursive: boolean): SQL {
  return sql`exists (select 1 from ${imageKeywords} where ${imageKeywords.imageId} = ${images.id} and ${albumAtOrBelow(album, recursive)})`
}

/**
 * WHERE predicate for a `source_type='folder'` OR `source_type='album'`
 * share's images (design §7). Common to both: kind='jpeg' and the
 * rating >= min_rating filter. The scope differs by source type:
 *
 * - `folder`: same root, plus a dir scope chosen by `share.recursive`:
 *   - `recursive=true` (the default, and the only pre-existing behaviour): dir
 *     at-or-below `share.dir`; an empty/null `share.dir` means the whole root.
 *     The subtree match is byte-exact (see lib/dir-scope) so neither a
 *     case-variant nor a `_`/`%`-matching sibling directory can leak in.
 *   - `recursive=false`: `dir` EXACTLY equal to `share.dir`, i.e. that folder's
 *     own images and nothing from any sub-directory. An empty/null `share.dir`
 *     therefore means the root's immediate children only (indexer rows at the
 *     root have `dir=''`), NOT the whole root.
 * - `album`: same root, plus a keyword scope at-or-below `share.album` (see
 *   lib/album-scope), with `recursive=false` narrowing to that album's own path
 *   exactly, no sub-albums. Root-scoped exactly like a folder share, and for a
 *   sharper reason: SHARE_ROOT is the only agent-WRITABLE root (POST
 *   /api/images stores the uploaded bytes verbatim), so a cross-root album
 *   predicate would publish any ingested file that happens to carry — or was
 *   crafted to carry — a matching XMP-lr:HierarchicalSubject to a friend-facing
 *   share. It would also be un-previewable: GET /api/library/albums reports one
 *   root at a time, so the count the operator approves could never equal the
 *   share's real membership.
 *
 * This single predicate backs listShareImages, getShareImageById and
 * shareImageCount — they MUST agree, or an image the page never lists would
 * still be fetchable by id.
 */
function shareImageFilter(share: ShareRow) {
  const conds: SQL[] = [eq(images.kind, 'jpeg')]
  if (share.sourceType === 'album') {
    // A missing root falls back to 'fuji' rather than to "every root": the only
    // other root an album share can name is the agent-writable SHARE_ROOT, and
    // a corrupt/legacy row must never silently widen into it.
    conds.push(eq(images.root, share.root ?? 'fuji'))
    // An album share with no album stored would otherwise degrade to "every
    // tagged image"; the admin schema requires a non-empty album, so a null
    // here is a corrupt row and must fail CLOSED (empty share, not everything).
    conds.push(share.album ? albumMembership(share.album, share.recursive) : sql`1 = 0`)
  } else {
    conds.push(eq(images.root, share.root as string))
    if (!share.recursive) {
      conds.push(eq(images.dir, share.dir ?? ''))
    } else if (share.dir) {
      conds.push(dirAtOrBelow(share.dir))
    }
  }
  // `minRating: 0` means "no filter", NOT `rating >= 0` — `images.rating` is
  // NULL for unrated images and `NULL >= 0` is NULL, so the naive predicate
  // would silently drop every unrated image from the share.
  if (share.minRating) {
    conds.push(gte(images.rating, share.minRating))
  }
  return and(...conds)
}

/**
 * WHERE predicate for a `source_type='selection'` share's images, applied to
 * the `share_images ⋈ images` join.
 *
 * `kind='jpeg'` is the same fail-closed rule the folder/album predicate carries,
 * and it is load-bearing on the PUBLIC surface: a rendition only ever comes from
 * a JPEG (design §6), so a `.RAF` row inside `share_images` makes every tile of
 * that image a sharp decode failure — a 500 on the friend's page. POST/PATCH
 * `/api/shares` now reject non-renderable ids outright (design §8), so this
 * guards exactly one case: a row written before that check existed. Such a row
 * disappears from the share (listing, by-id fetch, ZIP and count alike) instead
 * of erroring, which is the same "a denial is a 404, never a stack trace"
 * contract the rest of the share surface keeps.
 */
function selectionFilter(share: ShareRow): SQL | undefined {
  return and(eq(shareImages.shareId, share.id), eq(images.kind, 'jpeg'))
}

/** Optional window over a share's image list (`undefined` = the whole share). */
export interface ShareImageWindow {
  /** Max rows to return. Omit for "all". */
  limit?: number
  /** Rows to skip. Ignored unless `limit` is set. */
  offset?: number
}

/**
 * List the images belonging to a share (design §7 rework): `source_type=
 * 'folder'` and `source_type='album'` go through `shareImageFilter`;
 * `source_type='selection'` joins `share_images`. ALL THREE sort by
 * `capture_at` ascending, tie-broken by `id`.
 *
 * That the selection branch does NOT order by `share_images.position` is the
 * point: `position` is written in the order the admin's grid happened to be
 * sorted when the operator ticked the tiles, and that grid defaults to
 * captureAt/DESC — so ordering by it shipped the recipient a trip that scrolls
 * backwards, and flipping the admin's browse sort to Name silently re-ordered
 * a friend-facing gallery. A share's order is a property of the photos, not of
 * how the owner happened to be browsing; `position` survives only as the
 * insertion bookkeeping that keeps `share_images` rows unique and replayable.
 *
 * `window` pushes the page-size limit into SQL. The public share page renders
 * one window of tiles per document (progressive reveal) rather than 2000
 * `<figure>` blocks; the ZIP and the admin count still ask for everything and
 * simply omit the window. The ordering is total and stable in both branches,
 * which is what makes an OFFSET window safe — without the `id` tie-break, two
 * rows sharing a capture timestamp could swap between page 1 and page 2 and be
 * shown twice or never.
 */
export async function listShareImages(
  share: ShareRow,
  window: ShareImageWindow = {},
): Promise<ImageRow[]> {
  const base =
    share.sourceType === 'selection'
      ? activeDb
          .select({ image: images })
          .from(shareImages)
          .innerJoin(images, eq(images.id, shareImages.imageId))
          .where(selectionFilter(share))
          .orderBy(asc(images.captureAt), asc(images.id))
      : activeDb
          .select({ image: images })
          .from(images)
          .where(shareImageFilter(share))
          .orderBy(asc(images.captureAt), asc(images.id))
  const rows = await (window.limit === undefined
    ? base
    : base.limit(window.limit).offset(window.offset ?? 0))
  return rows.map((r) => r.image)
}

/** Aggregate facts about a share's images — one query, no row enumeration. */
export interface ShareImageSummary {
  /** Total image count (the share's real size, independent of any window). */
  total: number
  /** Earliest / latest `capture_at` (ISO strings) across the whole share. */
  firstCaptureAt: string | null
  lastCaptureAt: string | null
  /** Sum of `file_size` over every image — the ZIP's JPEG payload in bytes. */
  totalFileSize: number
}

/**
 * Count + capture-date bounds + total bytes for a share, as a SINGLE aggregate
 * query. The share page needs all three for its header and its ZIP size label
 * but only renders a window of tiles, so it must never pull every row just to
 * count them or to find the date range.
 *
 * Uses the same `shareImageFilter` / `share_images` join as `listShareImages` —
 * the predicate stays single-sourced (design §7: the page listing, the by-id
 * membership check and every count MUST agree).
 */
export async function shareImageSummary(share: ShareRow): Promise<ShareImageSummary> {
  const columns = {
    total: count(images.id),
    firstCaptureAt: min(images.captureAt),
    lastCaptureAt: max(images.captureAt),
    totalFileSize: sum(images.fileSize),
  }
  const rows =
    share.sourceType === 'selection'
      ? await activeDb
          .select(columns)
          .from(shareImages)
          .innerJoin(images, eq(images.id, shareImages.imageId))
          .where(selectionFilter(share))
      : await activeDb.select(columns).from(images).where(shareImageFilter(share))
  const row = rows[0]
  return {
    total: row?.total ?? 0,
    firstCaptureAt: row?.firstCaptureAt ?? null,
    lastCaptureAt: row?.lastCaptureAt ?? null,
    // SQLite `sum()` comes back as a string (or null on an empty set).
    totalFileSize: Number(row?.totalFileSize ?? 0),
  }
}

/**
 * The `raw_path`s of a share's images that have a paired RAF. Only the ZIP
 * size label for a `full`-role token needs these (RAF byte sizes are not
 * indexed — the raws root is read-only and RAFs are never rendered), so this
 * is a one-column query kept off the common path.
 */
export async function shareRawPaths(share: ShareRow): Promise<string[]> {
  const rows =
    share.sourceType === 'selection'
      ? await activeDb
          .select({ rawPath: images.rawPath })
          .from(shareImages)
          .innerJoin(images, eq(images.id, shareImages.imageId))
          .where(and(selectionFilter(share), isNotNull(images.rawPath)))
      : await activeDb
          .select({ rawPath: images.rawPath })
          .from(images)
          .where(and(shareImageFilter(share), isNotNull(images.rawPath)))
  return rows.map((r) => r.rawPath).filter((p): p is string => p !== null)
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
      .where(and(selectionFilter(share), eq(shareImages.imageId, id)))
      .limit(1)
    return rows[0]?.image ?? null
  }
  const rows = await activeDb
    .select()
    .from(images)
    .where(and(eq(images.id, id), shareImageFilter(share)))
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

/** What is wrong with a proposed selection-share image set (empty = nothing). */
export interface ShareImageIdReport {
  /** Ids with no `images` row at all. */
  missing: number[]
  /** Ids that exist but can never produce a rendition — `.RAF` originals. */
  unrenderable: number[]
}

/**
 * Vet image ids BEFORE they become a selection share (design §8).
 *
 * A share's images must be renderable: the public page asks
 * `/s/:slug/img/:id` for every tile, and a `.RAF` row has no JPEG to render
 * from (design §6) — sharp cannot decode it, so the tile 500s on the friend's
 * page. The raws root is a first-class browse axis in the admin (3661 files
 * that exist nowhere else), and "Select all N matching" happily selects 3661
 * `kind='raw'` rows, so this is one click away rather than exotic.
 *
 * It is checked HERE, at the API boundary, and not only in the admin: this
 * route is equally the agent contract, and an agent posting ids it read from
 * `GET /api/library/images?root=raws` deserves the same answer the UI gets.
 * Unknown ids are reported for the same reason — `share_images.image_id` is a
 * real FK, so they would fail the insert with an opaque constraint error.
 */
export async function checkShareImageIds(imageIds: number[]): Promise<ShareImageIdReport> {
  const unique = [...new Set(imageIds)]
  if (unique.length === 0) return { missing: [], unrenderable: [] }
  const rows = await activeDb
    .select({ id: images.id, kind: images.kind })
    .from(images)
    .where(inArray(images.id, unique))
  const kindById = new Map(rows.map((row) => [row.id, row.kind]))
  const report: ShareImageIdReport = { missing: [], unrenderable: [] }
  for (const id of unique) {
    const kind = kindById.get(id)
    if (kind === undefined) report.missing.push(id)
    else if (kind !== 'jpeg') report.unrenderable.push(id)
  }
  return report
}

/**
 * Replace a selection share's image set. `position` records the caller's array
 * order, but it is NOT the order the share ships in — every share, whatever its
 * source type, is listed capture-ascending (see `listShareImages`). Callers
 * must run `checkShareImageIds` first; this function trusts its input.
 */
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
    // Joins `images` rather than counting `share_images` alone: the count the
    // admin shows must be the count the share page renders, and
    // `selectionFilter` drops a legacy non-renderable row from both.
    const rows = await activeDb
      .select({ imageId: shareImages.imageId })
      .from(shareImages)
      .innerJoin(images, eq(images.id, shareImages.imageId))
      .where(selectionFilter(share))
    return rows.length
  }
  const rows = await activeDb.select({ id: images.id }).from(images).where(shareImageFilter(share))
  return rows.length
}
