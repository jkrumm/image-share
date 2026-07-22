import { basename } from 'node:path'
import { Elysia } from 'elysia'
import { z } from 'zod'
import {
  getShareImageById,
  listShareImages,
  resolveShareAccess,
  type ShareTokenRole,
} from '../lib/share-auth.js'
import { rootBaseDir, safeJoin } from '../lib/paths.js'
import { render404Page, renderSharePage } from './page.js'
import { buildShareZip } from './zip.js'
import { renderRendition } from '../renditions/render.js'

// Content-Disposition attachment header with an ASCII-safe fallback filename
// plus an RFC 5987 UTF-8 variant. `basename` strips any directory component.
function attachment(name: string): string {
  const safe = basename(name)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

// Serve the opaque 404 page. Every denial cause funnels through here so the
// public surface never distinguishes an unknown slug from a revoked token,
// an out-of-share id, or a size/role the token does not permit.
function notFound(set: {
  status?: number | string
  headers: Record<string, string | number>
}): string {
  set.status = 404
  set.headers['content-type'] = 'text/html; charset=utf-8'
  return render404Page()
}

// Role gating (design §7 rework): `view` sees thumb/med renditions only;
// `download` adds full-size renditions + original JPEG download/zip;
// `full` adds paired RAF download/zip on top of `download`.
const IMG_SIZES_BY_ROLE: Record<ShareTokenRole, ReadonlySet<string>> = {
  view: new Set(['thumb', 'med']),
  download: new Set(['thumb', 'med', 'full']),
  full: new Set(['thumb', 'med', 'full']),
}

function canDownloadFile(role: ShareTokenRole): boolean {
  return role === 'download' || role === 'full'
}

function canDownloadRaw(role: ShareTokenRole): boolean {
  return role === 'full'
}

// Public share surface, all under `/s` (design §7). No bearer auth — access is
// governed entirely by `token`, which carries a role. EVERY denial collapses
// to `render404Page()`; the scoped `onError` below guarantees no handler ever
// leaks a distinguishing error.

export const shareRoutes = new Elysia({ name: 'shares' })
  // Any error inside a share route → the single opaque 404 page (design §10).
  // Default (local) scope: applies to this plugin's own routes ONLY. It must
  // NOT be `as: 'scoped'` — a scoped onError leaks to sibling plugins mounted
  // after this one and breaks their route registration (verified on Elysia
  // 1.4.29). Local scope already covers every route defined here.
  .onError(({ error, set }) => {
    // NotImplemented and every denial alike render the same page — the public
    // surface must never distinguish cases.
    void error
    set.status = 404
    set.headers['content-type'] = 'text/html; charset=utf-8'
    return render404Page()
  })
  .get(
    '/s/:slug',
    async ({ params, query, set }) => {
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      // Invalid token / unknown slug / expired share → opaque 404.
      if (!access) return notFound(set)
      const images = await listShareImages(access.share)
      set.headers['content-type'] = 'text/html; charset=utf-8'
      return renderSharePage({
        share: access.share,
        images,
        token: access.token,
        role: access.role,
      })
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({ token: z.string().optional() }),
      detail: {
        tags: ['Shares'],
        summary: 'Public share gallery page',
        description:
          'Server-rendered responsive gallery + lightbox for a share. Requires a valid `token`. Any invalid/rolled/expired/missing case renders the same opaque 404 page.',
      },
    },
  )
  .get(
    '/s/:slug/img/:id',
    async ({ params, query, set }) => {
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      if (!access) return notFound(set)
      // The requested size must be permitted for the token's role (design §7).
      if (!IMG_SIZES_BY_ROLE[access.role].has(query.size)) return notFound(set)
      // The id must belong to the share, else opaque 404.
      const image = await getShareImageById(access.share, params.id)
      if (!image) return notFound(set)
      const absPath = safeJoin(rootBaseDir(image.root), image.relPath)
      const rendition = await renderRendition({
        absPath,
        size: query.size,
        root: image.root,
        relPath: image.relPath,
        mtimeMs: image.mtimeMs,
        fileSize: image.fileSize,
      })
      set.headers['cache-control'] = 'private, max-age=31536000, immutable'
      set.headers['content-type'] = rendition.contentType
      return Bun.file(rendition.path)
    },
    {
      params: z.object({ slug: z.string(), id: z.coerce.number().int() }),
      query: z.object({
        token: z.string().optional(),
        size: z.enum(['thumb', 'med', 'full']).default('med'),
      }),
      detail: {
        tags: ['Shares'],
        summary: 'Share rendition bytes',
        description:
          'Returns rendition bytes (thumb/med/full) for an image belonging to the share, cached immutably for a year. `full` is only served to download/full-role tokens; the id must belong to the share or the request 404s.',
      },
    },
  )
  .get(
    '/s/:slug/file/:id',
    async ({ params, query, set }) => {
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      if (!access) return notFound(set)
      // view-role tokens can never download a file (design §7).
      if (!canDownloadFile(access.role)) return notFound(set)
      const image = await getShareImageById(access.share, params.id)
      if (!image) return notFound(set)

      if (query.raw === 1) {
        // Paired RAF — only a full-role token, and only when a pairing exists.
        if (!canDownloadRaw(access.role) || !image.rawPath) return notFound(set)
        const rawAbs = safeJoin(rootBaseDir('raws'), image.rawPath)
        set.headers['content-type'] = 'application/octet-stream'
        set.headers['content-disposition'] = attachment(image.rawPath)
        return Bun.file(rawAbs)
      }

      // Original JPEG bytes as an attachment.
      const abs = safeJoin(rootBaseDir(image.root), image.relPath)
      set.headers['content-disposition'] = attachment(image.relPath)
      return Bun.file(abs)
    },
    {
      params: z.object({ slug: z.string(), id: z.coerce.number().int() }),
      query: z.object({
        token: z.string().optional(),
        raw: z.coerce.number().int().min(0).max(1).default(0),
      }),
      detail: {
        tags: ['Shares'],
        summary: 'Share file download (attachment)',
        description:
          'Attachment download of the original JPEG for a share image (download/full-role tokens only; raw=1 → the paired RAF, full-role tokens only). view-role tokens 404.',
      },
    },
  )
  .get(
    '/s/:slug/zip',
    async ({ params, query, set }) => {
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      if (!access) return notFound(set)
      if (!canDownloadFile(access.role)) return notFound(set)
      const images = await listShareImages(access.share)
      return buildShareZip({ share: access.share, images, role: access.role })
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({ token: z.string().optional() }),
      detail: {
        tags: ['Shares'],
        summary: 'Streaming ZIP of the whole share',
        description:
          'Streams a `<slug>.zip` of original files (+ RAFs for full-role tokens) with a predicted Content-Length. view-role tokens 404.',
      },
    },
  )
