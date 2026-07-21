import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { render404Page } from './share/page.js'
import { createStaticPlugin } from './static.js'

// Injected temp dist so the test is hermetic — it does not depend on a prior
// `vite build` of apps/admin.
const INDEX_HTML =
  '<!doctype html><html><head><script type="module" src="/admin/assets/index.js"></script></head><body></body></html>'

const distDir = mkdtempSync(join(tmpdir(), 'image-share-dist-'))
writeFileSync(join(distDir, 'index.html'), INDEX_HTML)

const app = new Elysia().use(createStaticPlugin(distDir))

const get = (path: string): Promise<Response> => app.handle(new Request(`http://localhost${path}`))

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true })
})

describe('static SPA plugin', () => {
  it('serves the opaque share 404 page at the friend-facing root', async () => {
    const res = await get('/')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe(render404Page())
  })

  it('serves the SPA index at /admin', async () => {
    const res = await get('/admin')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('/admin/assets/index.js')
  })

  it('falls back to the SPA index for a deep /admin client route', async () => {
    const res = await get('/admin/shares')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('/admin/assets/index.js')
  })

  it('declines the API, share, openapi, and health surfaces', async () => {
    for (const path of [
      '/api',
      '/api/stats',
      '/s',
      '/s/x',
      '/openapi',
      '/openapi/json',
      '/health',
    ]) {
      const res = await get(path)
      expect(res.status).toBe(404)
    }
  })

  it('does not serve the SPA outside /admin', async () => {
    const res = await get('/favicon.ico')
    expect(res.status).toBe(404)
  })
})
