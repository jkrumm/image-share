import { randomBytes } from 'node:crypto'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { shares, shareTokens, type ShareRow, type ShareTokenRow } from '../db/schema.js'
import { env } from '../env.js'

// Share management (design §8). Passwords are hashed with Bun.password
// (argon2id); the response never echoes the hash. Minted URLs use SHARE_BASE_URL.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// Slugs that would collide with a reserved bare path on share.jkrumm.com. The
// Caddy site block passes `/health` straight through to the container probe and
// rewrites every other `/<slug>` → `/s/<slug>`; a share slugged "health" would
// be permanently shadowed by the passthrough and serve the liveness JSON instead
// of the gallery. Reject it at the admin boundary rather than mint a dead link.
const RESERVED_SLUGS = new Set(['health'])

// Shares can only target roots that hold JPEG-kind rows. RAWS_ROOT is a flat
// `.RAF` tree (every row kind='raw'), and the share content query hard-requires
// kind='jpeg' — a `root:'raws'` share can therefore never contain an image.
// RAW downloads ride along on a library-rooted share via `includeRaws`, never as
// the share's own root (design §7, PRD.md). Accept only library/uploads.
const ShareRootEnum = z.enum(['library', 'uploads'])

// Expiry must be a real ISO 8601 instant (with `Z` or an offset) or an ISO
// `YYYY-MM-DD` date (the admin date-picker emits the latter). Anything else —
// `31.12.2026`, `31/12/2026`, `2026-12-31 18:00 CET`, epoch seconds — is
// rejected here so a malformed value can't reach the read path, where
// `Date.parse` → NaN would otherwise make the share never expire.
const ExpiresAtSchema = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .nullable()
  .optional()

function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

function mintUrl(slug: string, token: string): string {
  return `${env.SHARE_BASE_URL}/${slug}?token=${token}`
}

const TokenDto = z.object({
  id: z.number().int(),
  token: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  url: z.string().describe('Minted share URL: SHARE_BASE_URL/<slug>?token=<token>'),
})

function toTokenDto(slug: string, row: ShareTokenRow): z.infer<typeof TokenDto> {
  return {
    id: row.id,
    token: row.token,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    url: mintUrl(slug, row.token),
  }
}

const ShareDto = z.object({
  id: z.number().int(),
  slug: z.string(),
  root: z.enum(['library', 'raws', 'uploads']),
  dir: z.string(),
  minRating: z.number().int().nullable(),
  sizeLimit: z.enum(['medium', 'full']),
  includeRaws: z.boolean(),
  hasPassword: z.boolean(),
  expiresAt: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  tokens: z.array(TokenDto),
})

function toShareDto(row: ShareRow, tokens: ShareTokenRow[]): z.infer<typeof ShareDto> {
  return {
    id: row.id,
    slug: row.slug,
    root: row.root as z.infer<typeof ShareDto>['root'],
    dir: row.dir,
    minRating: row.minRating,
    sizeLimit: row.sizeLimit as z.infer<typeof ShareDto>['sizeLimit'],
    includeRaws: row.includeRaws === 1,
    hasPassword: row.passwordHash !== null,
    expiresAt: row.expiresAt,
    note: row.note,
    createdAt: row.createdAt,
    tokens: tokens.toSorted((a, b) => a.id - b.id).map((t) => toTokenDto(row.slug, t)),
  }
}

const CreateShareBody = z.object({
  slug: z.string().regex(SLUG_RE),
  root: ShareRootEnum,
  dir: z.string(),
  minRating: z.number().int().min(0).max(5).nullable().optional(),
  sizeLimit: z.enum(['medium', 'full']),
  includeRaws: z.boolean().default(false),
  password: z.string().min(1).nullable().optional(),
  expiresAt: ExpiresAtSchema.describe('ISO 8601 expiry (date or datetime), null for none'),
  note: z.string().nullable().optional(),
})

// PATCH: same fields, all optional; password: string sets, null clears.
const UpdateShareBody = z.object({
  slug: z.string().regex(SLUG_RE).optional(),
  root: ShareRootEnum.optional(),
  dir: z.string().optional(),
  minRating: z.number().int().min(0).max(5).nullable().optional(),
  sizeLimit: z.enum(['medium', 'full']).optional(),
  includeRaws: z.boolean().optional(),
  password: z.string().min(1).nullable().optional(),
  expiresAt: ExpiresAtSchema,
  note: z.string().nullable().optional(),
})

const MintedToken = z.object({
  token: z.string(),
  url: z.string(),
})

export const sharesRoutes = new Elysia({ name: 'shares-admin' })
  .get(
    '/api/shares',
    async () => {
      const shareRows = await db.select().from(shares).orderBy(desc(shares.createdAt))
      const tokenRows = await db.select().from(shareTokens)
      const data = shareRows.map((share) =>
        toShareDto(
          share,
          tokenRows.filter((t) => t.shareId === share.id),
        ),
      )
      return { data }
    },
    {
      response: { 200: z.object({ data: z.array(ShareDto) }) },
      detail: {
        tags: ['Shares'],
        summary: 'List shares with tokens and minted URLs',
        description:
          'Returns every share with its (active + revoked) tokens and the minted SHARE_BASE_URL/<slug>?token=… links. Password hashes are never returned — `hasPassword` reflects whether one is set.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/shares',
    async ({ body, set, status }) => {
      if (RESERVED_SLUGS.has(body.slug)) return status(400, `slug is reserved: ${body.slug}`)
      const [slugTaken] = await db
        .select({ id: shares.id })
        .from(shares)
        .where(eq(shares.slug, body.slug))
        .limit(1)
      if (slugTaken) return status(400, `slug already in use: ${body.slug}`)

      const now = new Date().toISOString()
      const passwordHash = body.password ? await Bun.password.hash(body.password) : null

      const [share] = await db
        .insert(shares)
        .values({
          slug: body.slug,
          root: body.root,
          dir: body.dir,
          minRating: body.minRating ?? null,
          sizeLimit: body.sizeLimit,
          includeRaws: body.includeRaws ? 1 : 0,
          passwordHash,
          expiresAt: body.expiresAt ?? null,
          note: body.note ?? null,
          createdAt: now,
        })
        .returning()
      if (!share) throw new Error('failed to create share')

      const token = generateToken()
      const [tokenRow] = await db
        .insert(shareTokens)
        .values({ shareId: share.id, token, createdAt: now })
        .returning()
      if (!tokenRow) throw new Error('failed to create share token')

      set.status = 201
      return toShareDto(share, [tokenRow])
    },
    {
      body: CreateShareBody,
      response: { 201: ShareDto, 400: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Create a share',
        description:
          'Creates a share for a folder (root+dir), hashes the optional password (argon2id), and mints the first token. sizeLimit=medium serves med renditions only; full unlocks originals (+ RAFs when includeRaws). Returns the created share with its first token + URL.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .patch(
    '/api/shares/:id',
    async ({ params, body, status }) => {
      const [existing] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!existing) return status(404, 'Share not found')

      if (body.slug !== undefined && body.slug !== existing.slug) {
        if (RESERVED_SLUGS.has(body.slug)) return status(400, `slug is reserved: ${body.slug}`)
        const [slugTaken] = await db
          .select({ id: shares.id })
          .from(shares)
          .where(eq(shares.slug, body.slug))
          .limit(1)
        if (slugTaken) return status(400, `slug already in use: ${body.slug}`)
      }

      const updates: Partial<typeof shares.$inferInsert> = {}
      if (body.slug !== undefined) updates.slug = body.slug
      if (body.root !== undefined) updates.root = body.root
      if (body.dir !== undefined) updates.dir = body.dir
      if (body.minRating !== undefined) updates.minRating = body.minRating
      if (body.sizeLimit !== undefined) updates.sizeLimit = body.sizeLimit
      if (body.includeRaws !== undefined) updates.includeRaws = body.includeRaws ? 1 : 0
      if (body.password !== undefined) {
        updates.passwordHash =
          body.password === null ? null : await Bun.password.hash(body.password)
      }
      if (body.expiresAt !== undefined) updates.expiresAt = body.expiresAt
      if (body.note !== undefined) updates.note = body.note

      if (Object.keys(updates).length > 0) {
        await db.update(shares).set(updates).where(eq(shares.id, params.id))
      }

      const [updated] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!updated) throw new Error('share disappeared mid-update')
      const tokens = await db.select().from(shareTokens).where(eq(shareTokens.shareId, params.id))
      return toShareDto(updated, tokens)
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      body: UpdateShareBody,
      response: { 200: ShareDto, 400: z.string(), 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Update a share',
        description:
          'Partial update of a share. `password: "<value>"` sets/replaces the password; `password: null` clears it; omitting it leaves it unchanged. Does not roll tokens — use POST /shares/:id/roll for that.',
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
        description: 'Deletes a share and all its tokens. Existing links stop working immediately.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/shares/:id/roll',
    async ({ params, status }) => {
      const [existing] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!existing) return status(404, 'Share not found')

      const now = new Date().toISOString()
      await db
        .update(shareTokens)
        .set({ revokedAt: now })
        .where(and(eq(shareTokens.shareId, params.id), isNull(shareTokens.revokedAt)))

      const token = generateToken()
      await db.insert(shareTokens).values({ shareId: params.id, token, createdAt: now })

      return { token, url: mintUrl(existing.slug, token) }
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      response: { 200: MintedToken, 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Roll the share token',
        description:
          'Revokes all active tokens for the share and mints a new one — revokes access without changing the slug. Returns the new token + URL. For an additional parallel link to the SAME share (without revoking), use POST /shares/:id/tokens.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/shares/:id/tokens',
    async ({ params, set, status }) => {
      const [existing] = await db.select().from(shares).where(eq(shares.id, params.id)).limit(1)
      if (!existing) return status(404, 'Share not found')

      const now = new Date().toISOString()
      const token = generateToken()
      await db.insert(shareTokens).values({ shareId: params.id, token, createdAt: now })

      set.status = 201
      return { token, url: mintUrl(existing.slug, token) }
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      response: { 201: MintedToken, 404: z.string() },
      detail: {
        tags: ['Shares'],
        summary: 'Add an additional token to a share',
        description:
          'Mints an additional, non-revoking token for the same share — for handing a second parallel link to another recipient of the same folder. Distinct from POST /shares/:id/roll, which revokes the existing tokens.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
