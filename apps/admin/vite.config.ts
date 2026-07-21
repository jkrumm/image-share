import { defineConfig, mergeConfig } from 'vite'
import { basaltViteConfig } from 'basalt-ui/vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf-8')) as {
  version: string
}

// VITE_API_TARGET lets a prod-api debugging run point the local UI at prod.
// Defaults to the bare local API on :7720 (no /api prefix on the target — the
// preset's proxy strips the leading /api from the source path before forwarding).
const apiTarget = process.env['VITE_API_TARGET'] ?? 'http://localhost:7720'

const basalt = basaltViteConfig({
  port: 7721,
  apiTarget,
  version: pkg.version,
})

export default defineConfig(
  mergeConfig(basalt, {
    plugins: [TanStackRouterVite({ target: 'react', autoCodeSplitting: true }), react()],
    resolve: {
      alias: {
        '@image-share/api': resolve(import.meta.dirname, '../api/src'),
      },
    },
    server: {
      proxy: {
        // Unlike argo's bare backend routes, image-share's Elysia routes carry
        // their own literal `/api/...` prefix (Caddy does not strip it in prod —
        // see design §10 divergence #2). The preset's default proxy strips the
        // leading /api before forwarding; override the rewrite to identity so
        // the dev proxy matches prod's un-rewritten passthrough.
        '/api': { rewrite: (path: string) => path },
      },
    },
  }),
)
