import { basename } from 'node:path'
import { Elysia } from 'elysia'
import { z } from 'zod'
import {
  getShareImageById,
  listShareImages,
  resolveShareAccess,
  resolveShareForPage,
  resolveShareToken,
  rootBaseDir,
  verifySharePassword,
} from '../lib/share-auth.js'
import { safeJoin } from '../lib/paths.js'
import { renderSharePage, renderUnlockPage, render404Page } from './page.js'
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
// wrong `k`, out-of-share id, or a size the share does not permit.
function notFound(set: {
  status?: number | string
  headers: Record<string, string | number>
}): string {
  set.status = 404
  set.headers['content-type'] = 'text/html; charset=utf-8'
  return render404Page()
}

// Public share surface, all under `/s` (design §7). No bearer auth — access is
// governed entirely by `token` (+ `k` for password shares). EVERY denial
// collapses to `render404Page()`; the scoped `onError` below guarantees no
// handler ever leaks a distinguishing error.

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
      const access = await resolveShareForPage({
        slug: params.slug,
        token: query.token,
        k: query.k,
      })
      // Invalid token / unknown slug / expired share → opaque 404.
      if (!access) return notFound(set)
      // Valid token on a password share without a valid `k` → the unlock form
      // (the recipient holds the token; the password is a second factor).
      if (access.needsUnlock) {
        set.headers['content-type'] = 'text/html; charset=utf-8'
        return renderUnlockPage({ slug: params.slug, token: access.token })
      }
      const images = await listShareImages(access.share)
      set.headers['content-type'] = 'text/html; charset=utf-8'
      return renderSharePage({ share: access.share, images, token: access.token, k: access.k })
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({
        token: z.string().optional(),
        k: z.string().optional().describe('Password capability (hmac of password_hash + token)'),
      }),
      detail: {
        tags: ['Shares'],
        summary: 'Public share gallery page',
        description:
          'Server-rendered responsive gallery + lightbox for a shared folder. Requires a valid `token` (and `k` for password-protected shares). Any invalid/rolled/expired/missing case renders the same opaque 404 page.',
      },
    },
  )
  .post(
    '/s/:slug/unlock',
    async ({ params, query, body, set }) => {
      // Token-only validation (never the password) — null collapses to the 404.
      const valid = await resolveShareToken({ slug: params.slug, token: query.token })
      if (!valid) return notFound(set)
      const k = await verifySharePassword({
        share: valid.share,
        token: valid.token,
        password: body.password,
      })
      if (!k) {
        set.headers['content-type'] = 'text/html; charset=utf-8'
        return renderUnlockPage({ slug: params.slug, token: valid.token, error: true })
      }
      // Success → redirect with token + minted k threaded into the URL.
      set.status = 302
      set.headers['location'] =
        `/s/${encodeURIComponent(params.slug)}?token=${encodeURIComponent(valid.token)}&k=${encodeURIComponent(k)}`
      return ''
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({ token: z.string().optional() }),
      body: z.object({ password: z.string() }),
      detail: {
        tags: ['Shares'],
        summary: 'Unlock a password-protected share',
        description:
          'Verifies the submitted password against the share (Bun.password.verify). On success 302-redirects to the gallery with `token` + a freshly-minted `k`; on failure re-renders the unlock form with an error.',
      },
    },
  )
  .get(
    '/s/:slug/img/:id',
    async ({ params, query, set }) => {
      const access = await resolveShareAccess({ slug: params.slug, token: query.token, k: query.k })
      if (!access) return notFound(set)
      // `full` is served only when the share allows it (design §7).
      if (query.size === 'full' && access.share.sizeLimit !== 'full') return notFound(set)
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
        k: z.string().optional(),
        size: z.enum(['thumb', 'med', 'full']).default('med'),
      }),
      detail: {
        tags: ['Shares'],
        summary: 'Share rendition bytes',
        description:
          'Returns rendition bytes (thumb/med/full) for an image belonging to the share, cached immutably for a year. `full` is served only when the share is size_limit=full; the id must belong to the share or the request 404s.',
      },
    },
  )
  .get(
    '/s/:slug/file/:id',
    async ({ params, query, set }) => {
      const access = await resolveShareAccess({ slug: params.slug, token: query.token, k: query.k })
      if (!access) return notFound(set)
      const image = await getShareImageById(access.share, params.id)
      if (!image) return notFound(set)

      if (access.share.sizeLimit === 'full') {
        if (query.raw === 1) {
          // Paired RAF — only when the share opted into raws AND a pairing exists.
          if (access.share.includeRaws !== 1 || !image.rawPath) return notFound(set)
          const rawAbs = safeJoin(rootBaseDir('raws'), image.rawPath)
          set.headers['content-type'] = 'application/octet-stream'
          set.headers['content-disposition'] = attachment(image.rawPath)
          return Bun.file(rawAbs)
        }
        // Original JPEG bytes as an attachment.
        const abs = safeJoin(rootBaseDir(image.root), image.relPath)
        set.headers['content-disposition'] = attachment(image.relPath)
        return Bun.file(abs)
      }

      // medium: `full` (and raw) are denied — stream the `med` rendition as an
      // attachment regardless of the `raw` flag.
      const abs = safeJoin(rootBaseDir(image.root), image.relPath)
      const rendition = await renderRendition({
        absPath: abs,
        size: 'med',
        root: image.root,
        relPath: image.relPath,
        mtimeMs: image.mtimeMs,
        fileSize: image.fileSize,
      })
      set.headers['content-type'] = rendition.contentType
      set.headers['content-disposition'] = attachment(`${image.stem}.webp`)
      return Bun.file(rendition.path)
    },
    {
      params: z.object({ slug: z.string(), id: z.coerce.number().int() }),
      query: z.object({
        token: z.string().optional(),
        k: z.string().optional(),
        raw: z.coerce.number().int().min(0).max(1).default(0),
      }),
      detail: {
        tags: ['Shares'],
        summary: 'Share file download (attachment)',
        description:
          'Attachment download for a share image. size_limit=full serves the original JPEG (raw=1 → the paired RAF, only when include_raws=1); size_limit=medium serves the `med` rendition as an attachment.',
      },
    },
  )
  .get(
    '/s/:slug/zip',
    async ({ params, query, set }) => {
      const access = await resolveShareAccess({ slug: params.slug, token: query.token, k: query.k })
      if (!access) return notFound(set)
      const images = await listShareImages(access.share)
      return buildShareZip({ share: access.share, images })
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({ token: z.string().optional(), k: z.string().optional() }),
      detail: {
        tags: ['Shares'],
        summary: 'Streaming ZIP of the whole share',
        description:
          'Streams a `<slug>.zip`. full shares zip original files (+ RAFs when include_raws) with a predicted Content-Length; medium shares zip lazily-generated `med` renditions with no Content-Length.',
      },
    },
  )
