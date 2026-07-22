import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Elysia } from 'elysia'
import { safeJoin } from './lib/paths.js'
import { renderLandingPage } from './share/page/index.js'

// Static SPA server for the admin app (design §1). Serves apps/admin/dist under
// the `/admin` path prefix with an index.html fallback for client-side routing.
// Mounted LAST so it only handles paths no earlier route claimed; it explicitly
// declines the API, share, openapi, and health surfaces so a miss there 404s
// instead of returning the SPA shell.
//
// The friend-facing root `/` no longer serves the SPA — it serves the Stage 3
// landing page (design §7/§I): a byte-identical static document for every
// visitor that reads the visitor's own `localStorage` client-side to remember
// (and redirect straight into) previously opened shares. It does zero server
// lookups, so it can never become an oracle over shares/tokens.
//
// The admin dist may not exist yet during early scaffolding — /admin requests
// then 404 cleanly (the Dockerfile builds it for prod).

const DEFAULT_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../admin/dist')

const RESERVED_PREFIXES = ['/api', '/s', '/openapi']

function isReserved(pathname: string): boolean {
  if (pathname === '/health') return true
  return RESERVED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

// Factory so tests can inject a temp dist dir; prod uses the default. Return
// type is inferred (the chained Elysia instance) — annotating it as the bare
// `Elysia` widens it and trips `exactOptionalPropertyTypes`.
export function createStaticPlugin(distDir: string = DEFAULT_DIST_DIR) {
  return new Elysia({ name: 'static' })
    .get(
      '/',
      ({ set }) => {
        set.headers['content-type'] = 'text/html; charset=utf-8'
        return renderLandingPage()
      },
      { detail: { hide: true } },
    )
    .get(
      '/*',
      async ({ request, status }) => {
        const { pathname } = new URL(request.url)
        if (isReserved(pathname)) return status(404)

        // The admin SPA lives under /admin (design §1). Only /admin and /admin/*
        // resolve into dist; every other path 404s (the root is handled above so
        // the friend-facing surface never serves the shell).
        if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return status(404)

        // Strip the /admin prefix to map into dist; bare /admin → index.html.
        const rel = pathname === '/admin' ? 'index.html' : pathname.slice('/admin/'.length)
        let filePath: string
        try {
          filePath = safeJoin(distDir, rel)
        } catch {
          return status(400)
        }

        const asset = Bun.file(filePath)
        if (await asset.exists()) return asset

        const indexHtml = Bun.file(join(distDir, 'index.html'))
        if (await indexHtml.exists()) return indexHtml

        return status(404)
      },
      {
        detail: {
          // Excluded from the agent-facing surface — it serves the human SPA.
          hide: true,
        },
      },
    )
}

export const staticPlugin = createStaticPlugin()
