import { sqliteTable, integer, text, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core'

// SQLite schema (design §4). snake_case columns; WAL is enabled on open in
// db/index.ts. The DB is a rebuildable cache EXCEPT `shares` / `share_tokens`
// (not derivable from the filesystem) — hence the nightly snapshot cron.

// ── images ───────────────────────────────────────────────────────────────────
// One row per indexed image file across all roots. Addressed by integer `id`
// everywhere — raw filesystem paths never appear in URLs.
export const images = sqliteTable(
  'images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    root: text('root').notNull(), // 'fuji' | 'raws' | 'share'
    relPath: text('rel_path').notNull(), // path relative to the root
    dir: text('dir').notNull(), // posix dirname of rel_path; '' at the root
    stem: text('stem').notNull(), // filename without extension
    ext: text('ext').notNull(), // lowercased extension, no leading dot
    kind: text('kind').notNull(), // 'jpeg' | 'raw' | 'image' | 'other'
    fileSize: integer('file_size').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    captureAt: text('capture_at'), // ISO 8601, nullable
    orientation: integer('orientation'),
    rating: integer('rating'),
    width: integer('width'),
    height: integer('height'),
    // rel_path in RAWS_ROOT of the paired .RAF — set on jpeg rows only.
    rawPath: text('raw_path'),
    indexedAt: text('indexed_at').notNull(),
    // When this row's `image_keywords` mirror was last reconciled. NULL means
    // "never" — which is exactly the state every row of an index built before
    // image_keywords existed is in, and what the scanner's skip-when-unchanged
    // fast path checks so those rows get one forced re-extract (see
    // indexer/scan.ts). Stays NULL for kind='raw': a RAF never carries album
    // keywords, so there is nothing to reconcile and nothing to backfill.
    keywordsIndexedAt: text('keywords_indexed_at'),
  },
  (t) => [
    uniqueIndex('images_root_rel_path_uq').on(t.root, t.relPath),
    index('images_dir_idx').on(t.dir),
    index('images_capture_at_idx').on(t.captureAt),
    index('images_rating_idx').on(t.rating),
  ],
)

// ── image_keywords ─────────────────────────────────────────────────────────
// The album hierarchy Lightroom/Camera Raw already wrote into the JPEGs
// (XMP-lr:HierarchicalSubject, mirrored into XMP-dc:Subject and IPTC:Keywords).
// The Fuji tree is completely flat, so this — not `images.dir` — is the axis
// the library is actually organized along.
//
// One row per (image, full hierarchical path). Ancestor rows are deliberately
// NOT materialized: 'Ereignisse|Segeln 25' does NOT also write 'Ereignisse'.
// Subtree queries are a sargable half-open range on `path` instead
// (lib/album-scope.ts), which keeps the table exactly as large as the tags on
// disk and makes re-indexing a delete+insert of one image's own rows.
// A keyword with no '|' is a valid single-segment path.
export const imageKeywords = sqliteTable(
  'image_keywords',
  {
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    path: text('path').notNull(), // full hierarchical path, e.g. 'Ereignisse|Segeln 25'
    leaf: text('leaf').notNull(), // last segment, e.g. 'Segeln 25'
  },
  (t) => [
    primaryKey({ columns: [t.imageId, t.path] }),
    index('image_keywords_path_idx').on(t.path),
  ],
)

// ── b2_objects ─────────────────────────────────────────────────────────────
// Mirror of the managed B2 bucket keyspace (design §8). `published_image_id`
// links a key back to the library image it was published from; null for
// out-of-band uploads (photoflow / rclone) discovered by reconciliation.
export const b2Objects = sqliteTable('b2_objects', {
  key: text('key').primaryKey(), // full key incl. 'img/' prefix
  size: integer('size').notNull(),
  lastModified: text('last_modified').notNull(),
  etag: text('etag'),
  mirroredAt: text('mirrored_at'), // set once pulled into B2_MIRROR_DIR
  publishedImageId: integer('published_image_id').references(() => images.id),
  firstSeenAt: text('first_seen_at').notNull(),
})

/**
 * What `shares.dir` holds on a `source_type='album'` row — a value the running
 * code never reads, and the API never returns (`toShareDto` reports `dir: null`
 * for album shares). It exists for exactly one reader: a container rolled BACK
 * to a binary that predates album shares.
 *
 * That binary has no `album` branch — its filter is `if (!recursive) dir = X
 * else if (dir) dirAtOrBelow(dir)`. With `dir` NULL (the honest value) an album
 * share degrades to "no dir predicate at all", i.e. the WHOLE root: a live
 * friend link minted for one album silently starts serving every JPEG in the
 * library. A rollback is the normal recovery move, so this must fail CLOSED.
 *
 * A leading `/` is what makes it provably inert: `images.dir` is always a
 * root-RELATIVE posix path (`''` at the root, `node.dirRel` otherwise), so no
 * indexed value can ever start with `/`. Under the legacy predicate both
 * branches therefore match nothing — `dir = '/album'` never holds, and the
 * `['/album/', '/album0')` subtree range excludes every real value (a first
 * byte below `/` falls under the lower bound, one above it over the upper).
 * The rolled-back container serves an EMPTY share instead of the library.
 *
 * Deliberately NOT a NUL-containing sentinel: bun:sqlite may bind text by
 * C-string length, which would truncate it to `''` — and `dir = ''` is the
 * root, i.e. fail-open, the exact bug this prevents.
 */
export const ALBUM_SHARE_LEGACY_DIR = '/album'

// ── shares ─────────────────────────────────────────────────────────────────
// A shared folder, a shared ALBUM (the Lightroom keyword hierarchy in
// `image_keywords` — the axis the flat Fuji tree is actually organized along),
// OR a hand-picked selection of images (design §7). NOT rebuildable —
// snapshotted nightly. `root`/`dir` are only meaningful when
// `source_type='folder'`, `album` only when `source_type='album'`; a
// `source_type='selection'` share's content lives in `share_images` instead.
// `root` is set for BOTH folder and album shares — an album share is scoped to
// one root as well, so an agent ingest into the writable SHARE_ROOT can never
// join a fuji-rooted album share by carrying a matching keyword.
export const shares = sqliteTable('shares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(), // ^[a-z0-9][a-z0-9-]{0,63}$
  title: text('title').notNull(),
  sourceType: text('source_type').notNull(), // 'folder' | 'selection' | 'album'
  root: text('root'), // set when source_type='folder' or 'album'
  // Set when source_type='folder'. On 'album' it carries ALBUM_SHARE_LEGACY_DIR
  // (see above) — a rollback poison pill, never read and never surfaced.
  dir: text('dir'),
  // Set only when source_type='album': the full hierarchical keyword path this
  // share is scoped to, e.g. 'Ereignisse|Segeln 25' (image_keywords.path).
  album: text('album'),
  // Folder AND album shares: include images below `dir` / `album` respectively.
  // Defaults to true so pre-existing rows keep the old unconditionally-recursive
  // meaning. Always true (and ignored) on a selection share.
  recursive: integer('recursive', { mode: 'boolean' }).notNull().default(true),
  minRating: integer('min_rating'),
  expiresAt: text('expires_at'), // ISO 8601, nullable
  note: text('note'), // markdown
  createdAt: text('created_at').notNull(),
})

// ── share_images ───────────────────────────────────────────────────────────
// Explicit image membership for a `source_type='selection'` share, ordered by
// `position` (design §7 rework). Cascades on either side deleting.
export const shareImages = sqliteTable(
  'share_images',
  {
    shareId: integer('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shareId, t.imageId] }),
    index('share_images_share_id_idx').on(t.shareId),
  ],
)

// ── share_tokens ───────────────────────────────────────────────────────────
// Rollable access tokens for a share (design §7). Each token carries a role
// (view|download|full) governing which asset routes it can reach. Revoking =
// setting revoked_at.
export const shareTokens = sqliteTable('share_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  shareId: integer('share_id')
    .notNull()
    .references(() => shares.id),
  token: text('token').notNull().unique(),
  role: text('role').notNull(), // 'view' | 'download' | 'full'
  label: text('label'),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
})

export type ImageRow = typeof images.$inferSelect
export type NewImageRow = typeof images.$inferInsert
export type ImageKeywordRow = typeof imageKeywords.$inferSelect
export type NewImageKeywordRow = typeof imageKeywords.$inferInsert
export type B2ObjectRow = typeof b2Objects.$inferSelect
export type ShareRow = typeof shares.$inferSelect
export type ShareImageRow = typeof shareImages.$inferSelect
export type ShareTokenRow = typeof shareTokens.$inferSelect
