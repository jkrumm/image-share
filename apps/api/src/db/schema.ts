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
  },
  (t) => [
    uniqueIndex('images_root_rel_path_uq').on(t.root, t.relPath),
    index('images_dir_idx').on(t.dir),
    index('images_capture_at_idx').on(t.captureAt),
    index('images_rating_idx').on(t.rating),
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

// ── shares ─────────────────────────────────────────────────────────────────
// A shared folder OR a hand-picked selection of images (design §7). NOT
// rebuildable — snapshotted nightly. `root`/`dir`/`recursive` are only
// meaningful when `source_type='folder'`; a `source_type='selection'` share's
// content lives in `share_images` instead.
export const shares = sqliteTable('shares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(), // ^[a-z0-9][a-z0-9-]{0,63}$
  title: text('title').notNull(),
  sourceType: text('source_type').notNull(), // 'folder' | 'selection'
  root: text('root'), // set only when source_type='folder'
  dir: text('dir'), // set only when source_type='folder'
  // Folder shares only: include images in sub-directories of `dir`. Defaults
  // to true so pre-existing rows keep the old unconditionally-recursive meaning.
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
export type B2ObjectRow = typeof b2Objects.$inferSelect
export type ShareRow = typeof shares.$inferSelect
export type ShareImageRow = typeof shareImages.$inferSelect
export type ShareTokenRow = typeof shareTokens.$inferSelect
