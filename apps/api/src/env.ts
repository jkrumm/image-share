import { z } from 'zod'

// Single fail-fast Zod env object (design §3, §10). Every default targets local
// dev so the service boots with no secrets: paths resolve under `.dev/`, the
// OTEL exporter no-ops when its endpoint is empty, and B2 credentials are only
// required by the publish/reconcile/backup paths (empty by default).
//
// All filesystem roots are container paths in prod (see design §3 + §11); the
// `.dev/` defaults mirror that layout on the laptop.
export const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // HTTP listen port. 7720 in every environment (Caddy reverse-proxies to it).
  PORT: z.coerce.number().int().default(7720),

  // Bearer secret for the admin `/api/*` surface. A weak default keeps local
  // boot working without secrets; prod injects the real value from 1Password.
  API_SECRET: z.string().min(1).default('dev-secret-change-me'),

  // ── Filesystem roots (design §3) ──────────────────────────────────────────
  // FUJI_ROOT + RAWS_ROOT are READ-ONLY — the service never writes there.
  // SHARE_ROOT is service-owned read-write (ingest lands here, root='share').
  FUJI_ROOT: z.string().default('./.dev/fuji'),
  RAWS_ROOT: z.string().default('./.dev/raws'),
  SHARE_ROOT: z.string().default('./.dev/share'),
  B2_MIRROR_DIR: z.string().default('./.dev/b2-mirror'),
  // DATA_DIR holds db/image-share.sqlite + renditions/ (rebuildable cache).
  DATA_DIR: z.string().default('./.dev/data'),
  // SNAPSHOT_DIR holds nightly VACUUM INTO snapshots (restic-covered in prod).
  SNAPSHOT_DIR: z.string().default('./.dev/backup'),

  // ── Share surface (design §7, §8) ─────────────────────────────────────────
  // Base for minted share URLs: `${SHARE_BASE_URL}/<slug>?token=…`. Prod =
  // https://share.jkrumm.com (Caddy rewrites /<slug> → /s/<slug>).
  SHARE_BASE_URL: z.string().default('http://localhost:7720/s'),

  // Cap on a share's PREDICTED ZIP size (design §7) — above this, `/s/:slug/zip`
  // refuses to build or spool the archive at all. 5 GiB by default: comfortably
  // above the verified-working 3.78 GB `segeln-25` download-role archive (550
  // JPEGs, spooled and served fine) and far below the verified-fatal 19 GB
  // full-role archive on the same share (JPEGs + paired RAFs) — SERVING that one
  // wedges the event loop hard enough that `/health` stops answering and the
  // Docker healthcheck restarts the container, reproduced repeatedly. This is a
  // property of THIS box (RAM, spinning-disk spool throughput), not a portable
  // constant, so unlike the sharp knobs below it is its own env var rather than
  // hardcoded — do not raise it without re-measuring on the actual deployment.
  SHARE_ZIP_MAX_BYTES: z.coerce
    .number()
    .int()
    .default(5 * 1024 ** 3),

  // ── Public CDN (design §8) ────────────────────────────────────────────────
  // Base for published-image URLs: `${CDN_BASE}/<key minus img/ prefix>`.
  CDN_BASE: z.string().default('https://img.jkrumm.com'),

  // ── Backblaze B2 (S3-compatible, via Bun.S3Client — design §2, §8) ────────
  // Empty defaults: only the publish/reconcile/reverse-backup paths need these.
  B2_ENDPOINT: z.string().default(''),
  B2_REGION: z.string().default(''),
  B2_BUCKET: z.string().default(''),
  B2_KEY_ID: z.string().default(''),
  B2_APP_KEY: z.string().default(''),
  // Key prefix all managed objects live under inside the bucket.
  B2_PREFIX: z.string().default('img/'),

  // Uptime Kuma push heartbeat pinged at the end of a successful reverse-backup
  // run (design §8). Empty disables the heartbeat.
  UPTIME_KUMA_PUSH_URL: z.string().default(''),

  // ── OpenTelemetry (design §10) ────────────────────────────────────────────
  // Empty endpoint = no-op exporters (see telemetry.ts guard). Prod compose
  // sets http://clickstack:4319 once ClickStack exists on the HomeLab.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  OTEL_SERVICE_NAME: z.string().default('image-share'),
  OTEL_SERVICE_VERSION: z.string().default(''),

  // ── Cron (design §9) ──────────────────────────────────────────────────────
  // Master switch for all scheduled jobs. 'false' disables; any other value
  // (incl. unset default) enables.
  CRON_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  // ── Rendition cache knobs (design §6) ─────────────────────────────────────
  // Sweep deletes cache files older than this, then evicts oldest-first until
  // under the size cap.
  RENDITION_MAX_AGE_DAYS: z.coerce.number().int().default(90),
  RENDITION_CACHE_MAX_GB: z.coerce.number().default(20),
  // Max sharp operations in flight process-wide (renditions/render.ts). The
  // HomeLab container has 4 CPU cores and a 1 GB memory limit, while one cold
  // 26 MP Fuji decode costs ~450 ms plus a large pixel buffer — so an unbounded
  // burst (the first visitor to a cold 100-photo share fires ~100 renders at
  // once) is an OOM-kill candidate. 3 keeps the box busy without starving the
  // event loop or stacking decode buffers past the memory limit. This is the
  // only rendition memory knob exposed via env — sharp's own libvips thread
  // pool and operation cache are hardcoded, not tunable (render.ts `loadSharp`).
  RENDITION_CONCURRENCY: z.coerce.number().int().min(1).default(3),
})

export type EnvShape = z.infer<typeof Env>

export const env = Env.parse(process.env)
