import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
    root: text('root').notNull(), // 'library' | 'raws' | 'uploads'
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
// A shared folder (design §7). NOT rebuildable — snapshotted nightly.
export const shares = sqliteTable('shares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(), // ^[a-z0-9][a-z0-9-]{0,63}$
  root: text('root').notNull(),
  dir: text('dir').notNull(),
  minRating: integer('min_rating'),
  sizeLimit: text('size_limit').notNull(), // 'medium' | 'full'
  includeRaws: integer('include_raws').notNull().default(0), // 0 | 1
  passwordHash: text('password_hash'), // Bun.password argon2id PHC string
  expiresAt: text('expires_at'), // ISO 8601, nullable
  note: text('note'),
  createdAt: text('created_at').notNull(),
})

// ── share_tokens ───────────────────────────────────────────────────────────
// Rollable access tokens for a share (design §7). Revoking = setting revoked_at.
export const shareTokens = sqliteTable('share_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  shareId: integer('share_id')
    .notNull()
    .references(() => shares.id),
  token: text('token').notNull().unique(),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
})

export type ImageRow = typeof images.$inferSelect
export type NewImageRow = typeof images.$inferInsert
export type B2ObjectRow = typeof b2Objects.$inferSelect
export type ShareRow = typeof shares.$inferSelect
export type ShareTokenRow = typeof shareTokens.$inferSelect
