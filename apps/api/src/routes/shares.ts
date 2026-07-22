import { randomBytes } from 'node:crypto'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { shares, shareTokens, type ShareRow, type ShareTokenRow } from '../db/schema.js'
import { env } from '../env.js'
import { shareImageCount, setShareImages } from '../lib/share-auth.js'

// Share management (design §8, role-based rework). A share is either a
// `folder` (root+dir, live-filtered from the index) or a `selection`
// (explicit ordered image ids in share_images). Each token carries a role
// (view|download|full) governing which asset routes it can reach — see
// share/routes.ts for the enforcement.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// Slugs that would collide with a reserved bare path on share.jkrumm.com. The
// Caddy site block claims `/health`, `/s/*`, `/api/*`, `/admin*`, and `/openapi*`
// with plain handles BEFORE the slug rewrite, then rewrites every other
// `/<slug>` → `/s/<slug>`. A share slugged after any of those handles would be
// permanently shadowed by the passthrough (serving the liveness JSON, the API,
// the admin SPA, or the OpenAPI UI instead of the gallery). Reject them at the
// admin boundary rather than mint a dead link.
const RESERVED_SLUGS = new Set(['health', 's', 'api', 'admin', 'openapi'])

// Folder shares can only target roots that hold JPEG-kind rows. RAWS_ROOT is a
// flat `.RAF` tree (every row kind='raw'), and the folder content query
// hard-requires kind='jpeg' — a `root:'raws'` share can therefore never
// contain an image. RAW downloads ride along on a fuji/share-rooted share via
// a full-role token, never as the share's own root.
const ShareRootEnum = z.enum(['fuji', 'share'])

// Expiry must be a real ISO 8601 instant (with `Z` or an offset) or an ISO
// `YYYY-MM-DD` date (the admin date-picker emits the latter). Anything else —
// `31.12.2026`, `31/12/2026`, `2026-12-31 18:00 CET`, epoch seconds — is
// rejected here so a malformed value can't reach the read path, where
// `Date.parse` → NaN would otherwise make the share never expire.
const ExpiresAtSchema = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .nullable()
  .optional()

const TokenRoleEnum = z.enum(['view', 'download', 'full'])

function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

function mintUrl(slug: string, token: string): string {
  return `${env.SHARE_BASE_URL}/${slug}?token=${token}`
}

/** Lowercase/hyphenate a title into a slug base: non-alphanumerics collapse to
 * a single `-`, leading/trailing hyphens trim, result truncates to 64 chars
 * (re-trimming any hyphen the truncation exposed). Falls back to 'share' if
 * the title has no alphanumeric content at all. */
function deriveSlugBase(title: string): string {
  const collapsed = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const truncated = collapsed.slice(0, 64).replace(/-+$/g, '')
  return truncated.length > 0 ? truncated : 'share'
}

async function slugTaken(slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: shares.id })
    .from(shares)
    .where(eq(shares.slug, slug))
    .limit(1)
  return row !== undefined
}

/** Derive a unique slug from a title, appending `-2`, `-3`, … on collision
 * with an existing or reserved slug (design §8). */
async function deriveUniqueSlug(title: string): Promise<string> {
  const base = deriveSlugBase(title)
  let candidate = base
  let n = 2
  while (RESERVED_SLUGS.has(candidate) || (await slugTaken(candidate))) {
    const suffix = `-${n}`
    const truncatedBase = base.slice(0, 64 - suffix.length).replace(/-+$/g, '')
    candidate = `${truncatedBase}${suffix}`
    n++
  }
  return candidate
}

const TokenDto = z.object({
  id: z.number().int(),
  role: TokenRoleEnum,
  label: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  url: z.string().describe('Minted share URL: SHARE_BASE_URL/<slug>?token=<token>'),
})

function toTokenDto(slug: string, row: ShareTokenRow): z.infer<typeof TokenDto> {
  return {
    id: row.id,
    role: row.role as z.infer<typeof TokenDto>['role'],
    label: row.label,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    url: mintUrl(slug, row.token),
  }
}

const ShareDto = z.object({
  id: z.number().int(),
  slug: z.string(),
  title: z.string(),
  sourceType: z.enum(['folder', 'selection']),
  root: ShareRootEnum.nullable(),
  dir: z.string().nullable(),
  minRating: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  imageCount: z.number().int(),
  tokens: z.array(TokenDto),
})

async function toShareDto(
  row: ShareRow,
  tokens: ShareTokenRow[],
): Promise<z.infer<typeof ShareDto>> {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    sourceType: row.sourceType as z.infer<typeof ShareDto>['sourceType'],
    root: row.root as z.infer<typeof ShareDto>['root'],
    dir: row.dir,
    minRating: row.minRating,
    expiresAt: row.expiresAt,
    note: row.note,
    createdAt: row.createdAt,
    imageCount: await shareImageCount(row),
    tokens: tokens.toSorted((a, b) => a.id - b.id).map((t) => toTokenDto(row.slug, t)),
  }
}

const FolderSource = z.object({
  type: z.literal('folder'),
  root: ShareRootEnum,
  dir: z.string(),
  minRating: z.number().int().min(0).max(5).nullable().optional(),
})

const SelectionSource = z.object({
  type: z.literal('selection'),
  imageIds: z.array(z.number().int()).min(1),
})

const ShareSource = z.discriminatedUnion('type', [FolderSource, SelectionSource])

const CreateShareBody = z.object({
  slug: z.string().regex(SLUG_RE).optional().describe('Auto-derived from title when omitted'),
  title: z.string().min(1),
  note: z.string().nullable().optional(),
  expiresAt: ExpiresAtSchema.describe('ISO 8601 expiry (date or datetime), null for none'),
  source: ShareSource,
})

const UpdateShareBody = z.object({
  title: z.string().min(1).optional(),
  note: z.string().nullable().optional(),
  expiresAt: ExpiresAtSchema,
  minRating: z.number().int().min(0).max(5).nullable().optional(),
  imageIds: z
    .array(z.number().int())
    .optional()
    .describe('Replaces the image set (position = array order) — selection shares only'),
})

const CreateTokenBody = z.object({
  role: TokenRoleEnum,
  label: z.string().nullable().optional(),
})

export const sharesRoutes = new Elysia({ name: 'shares-admin' })
  .get(
    '/api/shares',
    async () => {
      const shareRows = await db.select().from(shares).orderBy(desc(shares.createdAt))
      const tokenRows = await db.select().from(shareTokens)
      const data = await Promise.all(
        shareRows.map((share) =>
          toShareDto(
            share,
            tokenRows.filter((t) => t.shareId === share.id),
          ),
        ),
      )
      return { data }
    },
    {
      response: { 200: z.object({ data: z.array(ShareDto) }) },
      detail: {
        tags: ['Shares'],
        summary: 'List shares with tokens, image counts, and minted URLs',
        description:
          'Returns every share (folder or selection) with its (active + revoked) tokens, each token’s role, and the minted SHARE_BASE_URL/<slug>?token=… links.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/shares',
    async ({ body, set, status }) => {
      let slug = body.slug
      if (slug !== undefined) {
        if (RESERVED_SLUGS.has(slug)) return status(400, `slug is reserved: ${slug}`)
        if (await slugTaken(slug)) return status(400, `slug already in use: ${slug}`)
      } else {
        slug = await deriveUniqueSlug(body.title)
      }

      const now = new Date().toISOString()
      const source = body.source

      const [share] = await db
        .insert(shares)
        .values({
          slug,
          title: body.title,
          sourceType: source.type,
          root: source.type === 'folder' ? source.root : null,
          dir: source.type === 'folder' ? source.dir : null,
          minRating: source.type === 'folder' ? (source.minRating ?? null) : null,
          expiresAt: body.expiresAt ?? null,
          note: body.note ?? null,
          createdAt: now,
        })
        .returning()
      if (!share) throw new Error('failed to create share')

      if (source.type === 'selection') {
        await setShareImages(share.id, source.imageIds)
      }

      const token = generateToken()
      const [tokenRow] = await db
        .insert(shareTokens)
        .values({ shareId: share.id, token, role: 'view', createdAt: now })
        .returning()
      if (!tokenRow) throw new Error('failed to create share token')

      set.status = 201
      return await toShareDto(share, [tokenRow])
    },
    {
      body: CreateShareBody,
      response: { 201: ShareDto, 400: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Create a share',
        description:
          'Creates a folder share (root+dir, optionally minRating-filtered) or a selection share (explicit ordered image ids), and mints the first token with role=view. `slug` auto-derives from `title` (with `-2`/`-3`… on collision) when omitted.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .patch(
    '/api/shares/:id',
    async ({ params, body, status }) => {
      const [existing] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!existing) return status(404, 'Share not found')

      if (body.imageIds !== undefined && existing.sourceType !== 'selection') {
        return status(400, 'imageIds can only be set on a selection share')
      }

      const updates: Partial<typeof shares.$inferInsert> = {}
      if (body.title !== undefined) updates.title = body.title
      if (body.minRating !== undefined) updates.minRating = body.minRating
      if (body.expiresAt !== undefined) updates.expiresAt = body.expiresAt
      if (body.note !== undefined) updates.note = body.note

      if (Object.keys(updates).length > 0) {
        await db.update(shares).set(updates).where(eq(shares.id, params.id))
      }
      if (body.imageIds !== undefined) {
        await setShareImages(params.id, body.imageIds)
      }

      const [updated] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!updated) throw new Error('share disappeared mid-update')
      const tokens = await db.select().from(shareTokens).where(eq(shareTokens.shareId, params.id))
      return await toShareDto(updated, tokens)
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      body: UpdateShareBody,
      response: { 200: ShareDto, 400: z.string(), 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Update a share',
        description:
          'Partial update of title/note/expiresAt/minRating. `imageIds` replaces a selection share’s image set (position = array order) — rejected on a folder share. Does not manage tokens — see POST /shares/:id/tokens, /roll, and /tokens/:tokenId/revoke.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .delete(
    '/api/shares/:id',
    async ({ params, status }) => {
      const [existing] = await db
        .select({ id: shares.id })
        .from(shares)
        .where(eq(shares.id, params.id))
        .limit(1)
      if (!existing) return status(404, 'Share not found')

      await db.delete(shareTokens).where(eq(shareTokens.shareId, params.id))
      await db.delete(shares).where(eq(shares.id, params.id))
      return { deleted: true }
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      response: { 200: z.object({ deleted: z.boolean() }), 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Delete a share',
        description:
          'Deletes a share, its tokens, and (via cascading FK) its share_images rows if it was a selection share. Existing links stop working immediately.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/shares/:id/roll',
    async ({ params, status }) => {
      const [existing] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!existing) return status(404, 'Share not found')

      const active = await db
        .select()
        .from(shareTokens)
        .where(and(eq(shareTokens.shareId, params.id), isNull(shareTokens.revokedAt)))

      const now = new Date().toISOString()
      const minted: ShareTokenRow[] = []
      for (const old of active) {
        await db.update(shareTokens).set({ revokedAt: now }).where(eq(shareTokens.id, old.id))
        const [replacement] = await db
          .insert(shareTokens)
          .values({
            shareId: params.id,
            token: generateToken(),
            role: old.role,
            label: old.label,
            createdAt: now,
          })
          .returning()
        if (!replacement) throw new Error('failed to mint replacement token')
        minted.push(replacement)
      }

      return { tokens: minted.map((t) => toTokenDto(existing.slug, t)) }
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      response: { 200: z.object({ tokens: z.array(TokenDto) }), 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Roll every active token on the share',
        description:
          'Revokes every currently-active token for the share and mints a same-role replacement for each — refreshes every outstanding link without changing who can do what. Returns the newly-minted tokens.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/shares/:id/tokens',
    async ({ params, body, set, status }) => {
      const [existing] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!existing) return status(404, 'Share not found')

      const now = new Date().toISOString()
      const [tokenRow] = await db
        .insert(shareTokens)
        .values({
          shareId: params.id,
          token: generateToken(),
          role: body.role,
          label: body.label ?? null,
          createdAt: now,
        })
        .returning()
      if (!tokenRow) throw new Error('failed to create share token')

      set.status = 201
      return toTokenDto(existing.slug, tokenRow)
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      body: CreateTokenBody,
      response: { 201: TokenDto, 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Mint an additional token on a share',
        description:
          'Mints an additional, non-revoking token with the given role (+ optional label) — for handing a differently-scoped or parallel link to another recipient of the same share.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/shares/:id/tokens/:tokenId/revoke',
    async ({ params, status }) => {
      const [tokenRow] = await db
        .select()
        .from(shareTokens)
        .where(and(eq(shareTokens.id, params.tokenId), eq(shareTokens.shareId, params.id)))
        .limit(1)
      if (!tokenRow) return status(404, 'Token not found')

      const now = new Date().toISOString()
      await db.update(shareTokens).set({ revokedAt: now }).where(eq(shareTokens.id, params.tokenId))

      const [share] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!share) throw new Error('share disappeared mid-revoke')
      return toTokenDto(share.slug, { ...tokenRow, revokedAt: now })
    },
    {
      params: z.object({ id: z.coerce.number().int(), tokenId: z.coerce.number().int() }),
      response: { 200: TokenDto, 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Revoke a single token',
        description: 'Revokes exactly one token on the share, leaving its siblings untouched.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
