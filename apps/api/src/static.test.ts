import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { render404Page } from './share/page/index.js'
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
  it('serves the byte-identical landing page at the friend-facing root, with no share data', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    // No slug/token/share knowledge of any kind — every bit of behavior is
    // resolved client-side from the visitor's own localStorage (design §I).
    // (the inline JS *builds* a `?token=` query string client-side — that's
    // template code, not a leaked value — so we only assert no literal share
    // path is baked into the response.)
    expect(html).not.toMatch(/\/s\/[a-z0-9-]+/)
    expect(html).toContain('id="landing-empty"')
    expect(html).toContain('id="landing-section"')
    // Fully deterministic across requests.
    expect(html).toBe(await (await get('/')).text())
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

describe('unmatched paths get the designed opaque 404 page', () => {
  const OPAQUE = render404Page()

  it('serves the identical opaque page for every unmatched /s shape', async () => {
    // These reach the static plugin only because no share route claimed them.
    // A bare plain-text Elysia 404 here is visibly different from a DENIED
    // share, which is precisely the distinction the public surface must not
    // make (design §7).
    for (const path of ['/s', '/s/x', '/s/x/unlock', '/s/x/img/1/extra']) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(await res.text()).toBe(OPAQUE)
    }
  })

  it('serves the opaque page for an arbitrary unmatched path', async () => {
    const res = await get('/favicon.ico')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })

  it('keeps the machine surfaces on a bare status 404', async () => {
    for (const path of ['/api/nope', '/openapi/nope', '/health']) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toBe(OPAQUE)
    }
  })
})

describe('landing page is not an oracle', () => {
  it('is byte-identical regardless of Accept-Language', async () => {
    const bodies = await Promise.all(
      ['de-DE,de;q=0.9', 'es-ES,es;q=0.9', 'en-GB', 'zz'].map(async (accept) =>
        (
          await app.handle(
            new Request('http://localhost/', { headers: { 'accept-language': accept } }),
          )
        ).text(),
      ),
    )
    const plain = await get('/').then((r) => r.text())
    for (const body of bodies) expect(body).toBe(plain)
  })

  it('is byte-identical regardless of a token or any other query string', async () => {
    const plain = await get('/').then((r) => r.text())
    for (const qs of ['?token=whatever', '?token=', '?slug=gallery&token=abc']) {
      expect(await get('/' + qs).then((r) => r.text())).toBe(plain)
    }
  })
})
