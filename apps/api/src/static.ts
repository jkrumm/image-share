import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Elysia } from 'elysia'
import { safeJoin } from './lib/paths.js'

// Static SPA server for the admin app (design §1). Serves apps/admin/dist with
// an index.html fallback for client-side routing. Mounted LAST so it only
// handles paths no earlier route claimed; it explicitly declines the API,
// share, openapi, and health surfaces so a miss there 404s instead of returning
// the SPA shell.
//
// The admin dist may not exist yet during early scaffolding — requests then
// 404 cleanly (the Dockerfile builds it for prod).

const distDir = join(dirname(fileURLToPath(import.meta.url)), '../../admin/dist')

const RESERVED_PREFIXES = ['/api', '/s', '/openapi']

function isReserved(pathname: string): boolean {
  if (pathname === '/health') return true
  return RESERVED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export const staticPlugin = new Elysia({ name: 'static' }).get(
  '/*',
  async ({ request, status }) => {
    const { pathname } = new URL(request.url)
    if (isReserved(pathname)) return status(404)

    // Try the requested asset (traversal-guarded), else fall back to index.html.
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
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
