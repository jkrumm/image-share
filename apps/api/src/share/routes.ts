import { Elysia } from 'elysia'
import { z } from 'zod'
import {
  getShareImageById,
  listShareImages,
  resolveShareAccess,
  shareImageSummary,
  shareRawPaths,
  type ShareTokenRole,
} from '../lib/share-auth.js'
import { rootBaseDir, safeJoin } from '../lib/paths.js'
import type { ShareRow } from '../db/schema.js'
import { env } from '../env.js'
import { attachment } from './attachment.js'
import { parseAcceptLanguage, type Locale } from './page/i18n.js'
import {
  render404Page,
  renderShareTiles,
  renderSharePage,
  renderZipTooLargePage,
  SHARE_PAGE_SIZE,
  type SharePageSummary,
} from './page/index.js'
import {
  buildShareZip,
  estimateShareZipBytes,
  isZipSpoolAborted,
  isZipTooLarge,
  keepRequestAlive,
} from './zip.js'
import { renderRendition } from '../renditions/render.js'

// Initial locale (design §E) — parsed purely from the request header, same
// input every denial page and the share page itself resolve from. Never
// depends on share/token state, so it cannot become a distinguishing oracle.
function localeFromRequest(request: Request): Locale {
  return parseAcceptLanguage(request.headers.get('accept-language'))
}

type ResponseSet = { status?: number | string; headers: Record<string, string | number> }

/**
 * `Referrer-Policy: no-referrer` on EVERY share response, including the denial
 * page. The access token lives in the query string, so any outbound navigation
 * from a share page (a link in the note, a RAW download opened elsewhere) would
 * otherwise hand the full tokenised URL to a third party in the `Referer`
 * header — a silent, permanent grant of the share to whoever received it.
 */
function shareSecurityHeaders(set: ResponseSet): void {
  set.headers['referrer-policy'] = 'no-referrer'
}

// Serve the opaque 404 page. Every denial cause funnels through here so the
// public surface never distinguishes an unknown slug from a revoked token,
// an out-of-share id, or a size/route the token does not permit.
function notFound(set: ResponseSet, locale: Locale): string {
  set.status = 404
  set.headers['content-type'] = 'text/html; charset=utf-8'
  shareSecurityHeaders(set)
  return render404Page(locale)
}

// Role gating (design §7 rework): `view` sees thumb/small/med renditions only;
// `download` adds full-size renditions + original JPEG download/zip;
// `full` adds paired RAF download/zip on top of `download`.
//
// `small` (900px) sits with `thumb`/`med` in every role: it exists purely as an
// intermediate srcset candidate so a retina phone in grid/bento view stops
// pulling the 1600px one, and it is a smaller rendition than `med`, which every
// role already reaches. Withholding it from `view` would leak nothing and cost
// those visitors the bandwidth win.
const IMG_SIZES_BY_ROLE: Record<ShareTokenRole, ReadonlySet<string>> = {
  view: new Set(['thumb', 'small', 'med']),
  download: new Set(['thumb', 'small', 'med', 'full']),
  full: new Set(['thumb', 'small', 'med', 'full']),
}

function canDownloadFile(role: ShareTokenRole): boolean {
  return role === 'download' || role === 'full'
}

function canDownloadRaw(role: ShareTokenRole): boolean {
  return role === 'full'
}

/**
 * Aggregate header facts + the predicted ZIP size for the download label.
 * `withZipBytes` is false for the progressive-reveal fragment, which renders
 * no header and must not re-pay the RAF stat pass on every scroll page.
 */
async function pageSummary(
  share: ShareRow,
  role: ShareTokenRole,
  withZipBytes: boolean,
): Promise<SharePageSummary> {
  const summary = await shareImageSummary(share)
  const wantsZip = withZipBytes && canDownloadFile(role)
  const rawPaths = wantsZip && role === 'full' ? await shareRawPaths(share) : []
  const zipBytes = wantsZip
    ? await estimateShareZipBytes({ totalFileSize: summary.totalFileSize, role, rawPaths })
    : 0
  const zipOverCap = wantsZip && zipBytes > env.SHARE_ZIP_MAX_BYTES
  // Only meaningful for a `full` role: its own JPEG total (`summary.totalFileSize`,
  // already computed above with zero extra syscalls) is smaller than `zipBytes`
  // exactly when the paired RAFs are what pushed it over the cap. A `download`
  // role's zip already IS the JPEG total, so there is nothing smaller to offer.
  const zipSmallerBytes =
    zipOverCap && role === 'full' && summary.totalFileSize <= env.SHARE_ZIP_MAX_BYTES
      ? summary.totalFileSize
      : null
  return {
    total: summary.total,
    firstCaptureAt: summary.firstCaptureAt,
    lastCaptureAt: summary.lastCaptureAt,
    zipBytes,
    zipOverCap,
    zipSmallerBytes,
  }
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
  .onError(({ error, set, request }) => {
    // NotImplemented and every denial alike render the same page — the public
    // surface must never distinguish cases.
    void error
    set.status = 404
    set.headers['content-type'] = 'text/html; charset=utf-8'
    set.headers['referrer-policy'] = 'no-referrer'
    return render404Page(localeFromRequest(request))
  })
  .get(
    '/s/:slug',
    async ({ params, query, set, request }) => {
      const locale = localeFromRequest(request)
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      // Invalid token / unknown slug / expired share → opaque 404.
      if (!access) return notFound(set, locale)
      const isFragment = query.frag === 1
      const summary = await pageSummary(access.share, access.role, !isFragment)
      const outOfRange = query.from >= summary.total
      // An out-of-range `from` (hand-edited, or a stale link after the share
      // shrank) falls back to the first window rather than an empty gallery —
      // but ONLY for the non-fragment (full document) case. A fragment request
      // is `loadMore()` walking forward from a client-cached `total` that may
      // now be stale (nightly reindex / PATCH / keyword edit shrank the share
      // mid-session); resetting `from` to 0 there would re-serve tiles the
      // client already appended, duplicating them indefinitely as it keeps
      // advancing past a `total` the server no longer agrees with. The
      // fragment must instead return an empty window so the client stops.
      const from = outOfRange && !isFragment ? 0 : query.from
      const images =
        outOfRange && isFragment
          ? []
          : await listShareImages(access.share, { limit: SHARE_PAGE_SIZE, offset: from })
      const input = {
        share: access.share,
        images,
        from,
        summary,
        token: access.token,
        role: access.role,
        locale,
      }
      set.headers['content-type'] = 'text/html; charset=utf-8'
      // The URL contains the token, so a shared cache must never keep the body.
      set.headers['cache-control'] = 'private, no-store'
      shareSecurityHeaders(set)
      // `frag=1` is the progressive-reveal fragment: the same window of tiles
      // with no surrounding document, appended client-side by the page script.
      return isFragment ? renderShareTiles(input) : renderSharePage(input)
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({
        token: z.string().optional(),
        from: z.coerce.number().int().min(0).default(0),
        frag: z.coerce.number().int().min(0).max(1).default(0),
      }),
      detail: {
        tags: ['Shares'],
        summary: 'Public share gallery page',
        description:
          'Server-rendered responsive gallery + lightbox for a share, in windows of 60 tiles (`from` offsets the window, `frag=1` returns just the tiles for progressive reveal). Requires a valid `token`. Any invalid/rolled/expired/missing case renders the same opaque 404 page.',
      },
    },
  )
  .get(
    '/s/:slug/img/:id',
    async ({ params, query, set, request }) => {
      const locale = localeFromRequest(request)
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      if (!access) return notFound(set, locale)
      // The requested size must be permitted for the token's role (design §7).
      if (!IMG_SIZES_BY_ROLE[access.role].has(query.size)) return notFound(set, locale)
      // The id must belong to the share, else opaque 404.
      const image = await getShareImageById(access.share, params.id)
      if (!image) return notFound(set, locale)
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
      shareSecurityHeaders(set)
      return Bun.file(rendition.path)
    },
    {
      params: z.object({ slug: z.string(), id: z.coerce.number().int() }),
      query: z.object({
        token: z.string().optional(),
        size: z.enum(['thumb', 'small', 'med', 'full']).default('med'),
      }),
      detail: {
        tags: ['Shares'],
        summary: 'Share rendition bytes',
        description:
          'Returns rendition bytes (thumb/small/med/full) for an image belonging to the share, cached immutably for a year. `full` is only served to download/full-role tokens; the id must belong to the share or the request 404s.',
      },
    },
  )
  .get(
    '/s/:slug/file/:id',
    async ({ params, query, set, request }) => {
      const locale = localeFromRequest(request)
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      if (!access) return notFound(set, locale)
      // view-role tokens can never download a file (design §7).
      if (!canDownloadFile(access.role)) return notFound(set, locale)
      const image = await getShareImageById(access.share, params.id)
      if (!image) return notFound(set, locale)
      shareSecurityHeaders(set)

      if (query.raw === 1) {
        // Paired RAF — only a full-role token, and only when a pairing exists.
        if (!canDownloadRaw(access.role) || !image.rawPath) return notFound(set, locale)
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
    async ({ params, query, set, request, server }) => {
      const locale = localeFromRequest(request)
      const access = await resolveShareAccess({ slug: params.slug, token: query.token })
      if (!access) return notFound(set, locale)
      if (!canDownloadFile(access.role)) return notFound(set, locale)
      const images = await listShareImages(access.share)
      // The archive is spooled to disk before a byte is served (zip.ts), so this
      // handler is silent for the whole build — and `idleTimeout` (index.ts) is a
      // time-to-NEXT-BYTE cap that Bun refuses to set above 255 s. Without a
      // heartbeat the origin kills a multi-GB build on its own, no matter what
      // the tunnel's origin timeout says.
      const releaseSocket = keepRequestAlive({ server, request })
      try {
        const response = await buildShareZip({
          share: access.share,
          images,
          role: access.role,
          // `request.signal` fires while we are still inside the handler
          // (measured on Bun 1.3.14: 505 ms after the socket died), which is
          // exactly the phase the spool runs in — but only because the spool
          // loop yields to the event loop; a disconnect cannot be delivered to a
          // starved loop.
          signal: request.signal,
        })
        response.headers.set('referrer-policy', 'no-referrer')
        return response
      } catch (err) {
        // The visitor hung up mid-spool. Nobody is listening, so this is not an
        // error to bubble into the unhandled-error log — answer with the same
        // opaque 404 every other non-answer uses and keep the surface uniform.
        if (isZipSpoolAborted(err)) return notFound(set, locale)
        // Predicted archive over SHARE_ZIP_MAX_BYTES (design §7): a 413, never
        // the opaque 404 — the token and role are both valid, this is a
        // capacity limit, not a denial, and conflating the two would tell a
        // legitimate visitor with a real link that it is dead. Reachable only
        // via a direct/bookmarked hit — the share page's own control never
        // links to an archive it cannot deliver (see `zipControlHtml`).
        if (isZipTooLarge(err)) {
          set.status = 413
          set.headers['content-type'] = 'text/html; charset=utf-8'
          shareSecurityHeaders(set)
          // A `download`-role zip already IS the JPEG-only total, so it is
          // never smaller than what just failed to fit — only a `full` role
          // whose JPEGs alone clear the cap gets the "smaller" hint, and it
          // never references any other token or role, only this share's own
          // photos, which this same token can already see one by one.
          const jpegOnlyBytes = images.reduce((sum, image) => sum + image.fileSize, 0)
          const zipSmallerBytes =
            access.role === 'full' && jpegOnlyBytes <= env.SHARE_ZIP_MAX_BYTES
              ? jpegOnlyBytes
              : null
          return renderZipTooLargePage({
            locale,
            slug: access.share.slug,
            token: access.token,
            zipBytes: err.predictedBytes,
            zipSmallerBytes,
          })
        }
        throw err
      } finally {
        releaseSocket()
      }
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({ token: z.string().optional() }),
      detail: {
        tags: ['Shares'],
        summary: 'ZIP of the whole share',
        description:
          "Serves a `<slug>.zip` of original files (+ RAFs for full-role tokens) with a real Content-Length. This route implements no `Range` support of its own (see zip.ts); a syntactically valid single-range header may still get a 206/416 from Bun's own native, unsuppressible dispatch, but it can no longer diverge from the real archive bytes the way the removed per-request implementation could. A dropped download restarts from zero rather than resuming, though a retry is served from the spool cache rather than rebuilt. view-role tokens 404. A predicted archive over `SHARE_ZIP_MAX_BYTES` answers 413 with an explanatory HTML page instead of building it — never the opaque 404, since the token and role are both valid.",
      },
    },
  )
