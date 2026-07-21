# image-share — Design (v1)

Implementation contract for the PRD (`PRD.md`). Every implementer follows this file;
deviations get reported, not silently applied. Argo (`~/SourceRoot/argo`) is the
canonical pattern source for all Elysia/Drizzle/OTEL/basalt wiring.

## 1. Shape

One Bun monorepo (argo layout), one container on the HomeLab:

```
image-share/
├── package.json               # workspaces: ["apps/*"]
├── bunfig.toml tsconfig.base.json .oxlintrc.json .oxfmtrc.json lefthook.yml
├── scripts/{dev.sh,test.sh}
├── apps/api/                  # @image-share/api — Elysia + bun:sqlite + Drizzle + Zod + OTEL
│   ├── package.json tsconfig.json drizzle.config.ts Dockerfile .env.local.tpl
│   ├── drizzle/               # generated SQL migrations (committed)
│   └── src/
│       ├── index.ts           # plugin order: otel → onError → cors → openapi → public → authGuard → api routes
│       ├── env.ts telemetry.ts
│       ├── db/{schema.ts,index.ts}
│       ├── lib/{auth-guard.ts,traced-fetch.ts,paths.ts,share-auth.ts,s3.ts}
│       ├── indexer/{scan.ts,metadata.ts}
│       ├── renditions/{render.ts,cache.ts}
│       ├── share/{page.ts,routes.ts,zip.ts}
│       ├── routes/{health.ts,discovery.ts,library.ts,shares.ts,ingest.ts,publish.ts,b2.ts,stats.ts,index-admin.ts}
│       ├── cron/{jobs.ts,reindex.ts,b2-reconcile.ts,reverse-backup.ts,rendition-sweep.ts,db-snapshot.ts}
│       └── static.ts          # serves apps/admin/dist SPA fallback
└── apps/admin/                # @image-share/admin — Vite 8 + React 19 + basalt-ui SPA (argo dashboard clone)
```

Host (through the existing cloudflared wildcard → Caddy) — one public host, path-partitioned:
- `share.jkrumm.com` — friend share slugs at the root (`share.jkrumm.com/mallorca-2026?token=…`; Caddy handles `/health`, `/api/*`, `/openapi*`, `/admin*`, `/s/*` before rewriting every other `/{slug}` → `/s/{slug}`), the admin SPA under `/admin` (static), `/api/*` (bearer), and `/openapi`.

## 2. Dependencies (scaffold installs ALL of these; feature agents never run `bun add`)

apps/api (exact pins per dependency-hygiene):
`elysia ^1.4.26`, `@elysiajs/openapi ^1`, `@elysiajs/opentelemetry ^1.4.11`, `@elysiajs/cors ^1`,
`zod ^4`, `drizzle-orm 0.45.2` (`drizzle-orm/bun-sqlite` + `bun:sqlite`), devDep `drizzle-kit 0.31.10`,
`sharp 0.35.3`, `exifr 7.1.3`, `exiftool-vendored 37.0.0`, `client-zip 2.5.0`, `croner 9.1.0`,
`@opentelemetry/api ^1.9.1`, `@opentelemetry/api-logs ^0.217.0`, `@opentelemetry/sdk-logs ^0.217.0`,
`@opentelemetry/exporter-trace-otlp-proto ^0.217.0`, `@opentelemetry/exporter-logs-otlp-proto ^0.217.0`,
`@opentelemetry/resources ^2.0.0`, `@opentelemetry/sdk-trace-base ^2.7.1`.
NO `@kubiks/otel-drizzle` (Postgres-oriented; skip DB spans in v1 rather than fight sqlite support).
NO aws-sdk — B2 S3 via built-in `Bun.S3Client`.

apps/admin: `react/react-dom ^19.2.7`, `@mantine/{core,hooks,form,modals,notifications} ^9.3.0`,
`basalt-ui 1.1.1` (exact), `@tanstack/react-query ^5.101.0`, `@tanstack/react-router ^1.170.0` (+ vite plugin),
`@elysiajs/eden ^1.4.9`, `zustand ^5`, `vite ^8`, `@vitejs/plugin-react`.
Root devDeps: `typescript`, `oxlint`, `oxfmt`, `lefthook`, `bun-types`/`@types/bun`, `concurrently`.
bunfig.toml: `[install] minimumReleaseAgeExcludes = ["basalt-ui"]` (argo copy).

## 3. Filesystem contract (container paths; host mapping in §11)

| Env var | Container path | Mode | Content |
|-|-|-|-|
| `LIBRARY_ROOT` | `/photos/library` | ro | existing tree (`Bilder/`) — NEVER written |
| `RAWS_ROOT` | `/photos/raws` | ro | flat Fuji `.RAF` tree |
| `UPLOADS_DIR` | `/photos/uploads` | rw | service-owned ingest area (`root='uploads'`) |
| `B2_MIRROR_DIR` | `/photos/b2-mirror` | rw | reverse-backup target of B2 `img/` |
| `DATA_DIR` | `/data` | rw | `db/image-share.sqlite` + `renditions/` cache (rebuildable) |
| `SNAPSHOT_DIR` | `/backup` | rw | nightly `VACUUM INTO` sqlite snapshot (restic-covered) |

`INDEX_EXCLUDE_DIRS` (comma list, default `immich,Fotos-Mediathek.photoslibrary,Uploads,B2-Mirror`):
top-level dirs under LIBRARY_ROOT skipped by the indexer. Hidden files/dirs (`.` prefix) always skipped.

**Path safety (hard rule, everywhere):** every file access resolves `join(root, relPath)` and
asserts the resolved path starts with `root + sep` (lib/paths.ts `safeJoin(root, rel)`), throws 400 otherwise.
Image files are addressed by DB integer id in every route — raw paths never appear in URLs.

## 4. DB schema (SQLite, drizzle; snake_case columns; WAL mode on open)

```ts
images:      id int pk autoincrement; root text ('library'|'raws'|'uploads');
             rel_path text; dir text (posix dirname, '' at root); stem text; ext text (lower, no dot);
             kind text ('jpeg'|'raw'|'image'|'other'); file_size int; mtime_ms int;
             capture_at text? (ISO 8601); orientation int?; rating int?; width int?; height int?;
             raw_path text? (rel_path in RAWS_ROOT of the paired .RAF — set on jpeg rows only);
             indexed_at text; unique(root, rel_path); idx(dir), idx(capture_at), idx(rating)
b2_objects:  key text pk (full key incl. 'img/' prefix); size int; last_modified text; etag text?;
             mirrored_at text?; published_image_id int? (fk images.id, null for out-of-band uploads);
             first_seen_at text
shares:      id int pk; slug text unique (^[a-z0-9][a-z0-9-]{0,63}$); root text; dir text;
             min_rating int?; size_limit text ('medium'|'full'); include_raws int (0/1);
             password_hash text? (Bun.password argon2id PHC); expires_at text?; note text?; created_at text
share_tokens: id int pk; share_id int fk; token text unique; created_at text; revoked_at text?
```

The DB is a cache EXCEPT `shares`/`share_tokens` (not rebuildable) — hence the nightly snapshot cron.
Rebuild = delete file, boot, re-index, restore shares from snapshot if needed.

## 5. Indexer (`indexer/`)

- `scan.ts` — walks LIBRARY_ROOT (minus excludes), RAWS_ROOT, UPLOADS_DIR. For each image file
  (`jpg|jpeg|png|webp|avif|heic → 'jpeg'/'image'`, `raf → 'raw'`): upsert by `(root, rel_path)`;
  skip metadata re-extract when `file_size` and `mtime_ms` unchanged AND no newer `.xmp` sidecar;
  delete DB rows whose files vanished. Never writes outside the DB. Concurrency ~8 for metadata reads.
- `metadata.ts` — JPEG/PNG/WebP: `exifr.parse(path, { xmp: true, ... })` → capture date
  (DateTimeOriginal, fallback CreateDate, fallback filename `YYYY-MM-DD_HH-MM-SS_*` pattern, fallback mtime),
  orientation, `xmp:Rating`, width/height. RAF + `.xmp` sidecars: `exiftool-vendored` singleton
  (`exiftool.read`), `.end()` only on SIGTERM. Sidecar pairing by basename in same dir
  (`X.RAF` → `X.xmp` or `X.RAF.xmp`); sidecar rating wins for RAF, embedded wins for JPEG. Ignore `.photo` files.
- RAW pairing: after scan, for each `library` jpeg with stem matching a `raws` row stem → set `raw_path`.
- Single-flight: module-level `running` flag; concurrent rescan requests return `alreadyRunning`.
  Status object `{ running, startedAt, lastFinishedAt, lastCounts:{scanned,added,updated,removed}, lastError }`.

## 6. Renditions (`renditions/`)

sharp pipeline: `sharp(abs).autoOrient().resize({ width/height fit:'inside' }).webp()/jpeg()`.
Sizes: `thumb` = 480px webp q75 · `med` = 1600px webp q82 · `full` = 2560px jpeg q88.
RAF inputs are never rendered (renditions come from the paired JPEG; RAFs only download/zip).
Cache: `DATA_DIR/renditions/<sha256(root|rel_path|mtime_ms|size).hex[0..32]>.<webp|jpg>`;
on hit, `utimes` the file (mtime = LRU clock). In-process per-key single-flight dedup.
Sweep cron: delete cache files with mtime older than `RENDITION_MAX_AGE_DAYS` (default 90),
then oldest-first until under `RENDITION_CACHE_MAX_GB` (default 20).

## 7. Shares — the public surface (`share/`)

Auth model (no cookies): query `token` must match a non-revoked `share_tokens` row of a
non-expired share. If `password_hash` set, additionally query `k` must equal
`hmacSha256Hex(password_hash, token).slice(0,32)` (timing-safe compare). Wrong/rolled/expired/missing
→ single clean 404 HTML page ("This share does not exist or has been revoked") — never distinguish cases.
Unlock: password form POSTs to `/s/:slug/unlock` (body `password`, query `token`); on
`Bun.password.verify` success → 302 to `/s/:slug?token=…&k=…`; failure re-renders form with error.

Share content = images where `root=share.root AND (dir = share.dir OR dir LIKE share.dir || '/%')
AND kind='jpeg' AND (min_rating IS NULL OR rating >= min_rating)`, sorted by capture_at.

Routes (all under `/s`, public):
- `GET /s/:slug` — server-rendered HTML: responsive CSS grid (`<img loading="lazy">`, srcset thumb/med),
  `<dialog>` lightbox (prev/next/keyboard/swipe, uses `med`; `full` when size_limit='full'),
  header with count + date range + "Download all (.zip)" button (+ per-image download link in lightbox;
  RAW download links when include_raws). ALL CSS+JS inline, zero external requests; dark, minimal,
  styled with basalt tokens via `buildPaletteCss()` from `basalt-ui/tokens` (Mantine-free import). Mobile-first.
- `GET /s/:slug/img/:id?size=thumb|med|full` — rendition bytes, `Cache-Control: private, max-age=31536000, immutable`.
  `full` only when share.size_limit='full'; id must belong to the share (verify via share query) else 404.
- `GET /s/:slug/file/:id?raw=1` — attachment download. size_limit='full' → original JPEG bytes
  (`raw=1` → paired RAF, only when include_raws=1). size_limit='medium' → `full`-denied, streams `med`
  rendition as attachment.
- `GET /s/:slug/zip` — `makeZip` (client-zip) over an async generator: full → original files
  (+ RAFs when include_raws), with `predictLength` → Content-Length; medium → med renditions
  (generated lazily inside the generator, no Content-Length). Filename `<slug>.zip`.
  KNOWN CAVEAT (document in code + README): Bun.serve ReadableStream responses may ignore TCP
  backpressure (oven-sh/bun#32469) — acceptable single-user risk, re-check at upgrade time.

`token` and `k` are threaded into every asset URL by the page renderer.

## 8. Admin API (`routes/`, bearer `API_SECRET` via argo's onTransform scoped guard)

Public before guard: `GET /health` (no DB), `GET /api` (discovery JSON: name/version/docs/tags),
`/openapi` + `/openapi/json`, `/s/*`, SPA static. Everything else under `/api` is bearer-guarded.
Argo conventions apply wholesale: zod v4 + `mapJsonSchema: { zod: z.toJSONSchema }`, `z.coerce.number()`
for numeric params, `z.enum` never literal-unions, ISO date strings, `detail` with tags/summary/description
+ `security: [{ BearerAuth: [] }]`, `.get('', …)` at prefix root, `{ data, total }` pagination (limit ≤ 200).

- `GET /api/library/dirs` → `{ data: [{ root, dir, imageCount, ratedCounts: {r4plus…}, rawPairedCount, minCaptureAt, maxCaptureAt }] }`
- `GET /api/library/images?root&dir&recursive&minRating&page&limit&sort=captureAt|name&order` → `{ data: ImageDto[], total }`
- `GET /api/library/images/:id/file?size=thumb|med|full|orig` — bytes. Accepts bearer header OR
  `?access_token=<API_SECRET>` (browser `<img>` tags; this route only).
- `POST /api/index/rescan` → 202 `{ started }` · `GET /api/index/status`
- `GET /api/shares` (each with tokens + minted URLs `SHARE_BASE_URL/<slug>?token=…`) ·
  `POST /api/shares` `{ slug, root, dir, minRating?, sizeLimit, includeRaws, password?, expiresAt?, note? }`
  (hashes password, creates first token) · `PATCH /api/shares/:id` (same fields; password: string sets,
  null clears) · `DELETE /api/shares/:id` · `POST /api/shares/:id/roll` → revokes active tokens, mints new
  → `{ token, url }` · `POST /api/shares/:id/tokens` (additional token without revoking, for the
  "same folder, second recipient" case) — wait, per-recipient variants are separate shares; extra-token
  route is for parallel links to the SAME share. Keep both roll + add.
- `POST /api/images` multipart `{ file, dir? }` → saves to `UPLOADS_DIR/<yyyy>/<mm>/` (collision-safe name),
  indexes immediately → 201 `{ id, root, relPath, adminFileUrl }`
- `POST /api/publish` `{ imageIds: number[], prefix: 'fuji'|'blog'|'gen'|'misc' }` → for each: Bun.S3Client
  `.write('img/<prefix>/<filename>', file)` (skip+report if key exists), upsert b2_objects with
  published_image_id → `{ published: [{ id, key, cdnUrl }] }` where cdnUrl = `CDN_BASE/<key minus img/>`.
- `GET /api/b2?prefix=&page&limit` → b2_objects `{ data, total }` (flag `mirrored`, `publishedImageId`)
- `POST /api/b2/reconcile` → 202 (S3 list `img/` → upsert/remove b2_objects rows)
- `POST /api/backup/reverse-run` → 202 (download b2_objects lacking `mirrored_at` OR changed etag into
  `B2_MIRROR_DIR/<key minus img/>`, set mirrored_at; then GET `UPTIME_KUMA_PUSH_URL` if set — via tracedFetch)
- `GET /api/stats` → `{ images, jpegs, raws, uploads, shares, activeTokens, b2Objects, b2Unmirrored, renditionCacheBytes, dbSizeBytes, lastIndexAt, version }`

## 9. Crons (croner, each tick in fresh root span per argo's cron pattern; `CRON_ENABLED` env, default true)

| Job | Schedule | What |
|-|-|-|
| db-snapshot | `0 3 * * *` | `VACUUM INTO SNAPSHOT_DIR/image-share-<weekday>.sqlite` (7 rotating) — before restic 03:30 |
| reindex | `15 5 * * *` + on boot when images table empty (background) | full scan |
| b2-reconcile | `45 5 * * *` | S3 list → b2_objects |
| reverse-backup | `0 6 * * *` | mirror unmirrored keys + heartbeat |
| rendition-sweep | `30 4 * * 0` | age + size cap eviction |

## 10. Telemetry / env / errors

telemetry.ts, traced-fetch.ts, plugin order, `checkIfShouldTrace` (skip /, /health, /openapi, SPA assets),
onError span recorder: copy argo verbatim (adapted service name `image-share`). `OTEL_EXPORTER_OTLP_ENDPOINT`
default `http://clickstack:4319` in prod compose, unset locally = no-op exporter guard like argo.
env.ts: single Zod object, fail-fast, defaults for local dev (paths under `.dev/`), heavily commented.
Errors: throw + bubble; guard throws `status(401)`; share routes catch-all → the clean 404 page.

## 11. Deployment (changes in ~/SourceRoot/homelab — prepared by the homelab agent, pushed after review)

- Server clone: `/home/jkrumm/image-share` (GitHub `jkrumm/image-share`, direct-to-master).
- compose service `image-share`: `build: { context: /home/jkrumm/image-share/apps/api/../.. }` → actually
  `context: /home/jkrumm/image-share`, `dockerfile: apps/api/Dockerfile`; container_name `image-share`;
  networks `[cloudflared]`; mem limit 1G; healthcheck curl `/health` (port 7720); labels: glance
  (`glance.name: Image Share`, `si:imgproxy`… pick a sensible simpleicon, `glance.url: https://share.jkrumm.com/admin`),
  `com.centurylinklabs.watchtower.enable: 'false'` (local build).
  Volumes: `/home/jkrumm/ssd/SSD/Bilder:/photos/library:ro`, `/mnt/hdd/fuji/RAWs:/photos/raws:ro`,
  `/home/jkrumm/ssd/SSD/Bilder/Uploads:/photos/uploads`, `/home/jkrumm/ssd/SSD/Bilder/B2-Mirror:/photos/b2-mirror`,
  `/home/jkrumm/ssd/image-share:/data`, `/home/jkrumm/ssd/SSD/Dev/image-share:/backup`, `/etc/localtime:/etc/localtime:ro`.
  Env: `API_SECRET=${IMAGE_SHARE_API_SECRET}`, B2 five-pack (reuse `${IMGCLI-style}` refs from
  op://common/b2-images-write + op://common/backblaze-s3), `SHARE_BASE_URL=https://share.jkrumm.com`,
  `CDN_BASE=https://img.jkrumm.com`, `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty until ClickStack exists on homelab —
  homelab agent verifies; if no clickstack container there, leave unset), `TZ=Europe/Berlin`.
- Caddyfile: single `share.jkrumm.com` site block — plain `reverse_proxy image-share:7720`
  handles for `/health`, `/api/*`, `/openapi*`, `/admin*`, `/s/*`, then a catch-all handle with
  `rewrite * /s{uri}` + `reverse_proxy` for the friend share slugs.
- `.env.tpl`: `IMAGE_SHARE_API_SECRET=op://homelab/image-share/API_SECRET` + B2 refs.
- Makefile: `image-share-deploy` (pull ~/image-share + build --no-cache + up -d), `-restart`, `-logs`.
- uptime-kuma monitors.yaml: Image Share subgroup — docker monitor + `https://share.jkrumm.com/health`
  (cloudflare_bypass).
- restic: NO changes (Uploads/B2-Mirror land inside the Bilder source; live DB + renditions live
  outside all sources; snapshots land in the Dev source).
- Dockerfile: `oven/bun:1.3` (Debian, NOT alpine — perl + glibc sharp prebuilds), two-stage:
  builder installs workspaces + `vite build` admin; runner: `apt-get install -y curl perl libjemalloc2`,
  `ENV LD_PRELOAD=/usr/lib/<arch>/libjemalloc.so.2` (arch-detect at build), non-root user with access to
  mounted volumes (match host uid 1000), `CMD bun run apps/api/src/index.ts`, HEALTHCHECK like argo.
- DNS (deploy-time, /cloudflare skill): proxied CNAME `share` → `<TUNNEL_ID>.cfargotunnel.com`.

## 12. Admin SPA (apps/admin — argo dashboard patterns exactly)

basaltViteConfig (port 7721, apiTarget http://localhost:7720), Vite `base: '/admin/'` +
TanStack Router `basepath: '/admin'` (the SPA is served under `/admin` — see §1), main.tsx layer-css
order, BasaltProvider dark, Eden treaty typed on `App` from `@image-share/api` alias (baseUrl = bare
`window.location.origin`, so `/api/*` resolves on the same host), zustand persisted bearer + AuthGate,
createBasaltQueryClient, TanStack Router file-based. Pages (router paths, relative to the `/admin`
basepath):
- **Library** `/` — left dir tree (from /api/library/dirs), grid (SimpleGrid + AspectRatio + Image,
  thumb via access_token URL), rating filter (Rating component), sort, pagination; lightbox = Modal
  fullScreen with med rendition + prev/next/keyboard; selection mode → actions: "Publish to CDN…"
  (prefix picker modal → notifyPromise), "Create share from this folder…" (prefills share form).
- **Shares** `/shares` — BasaltDataTable of shares (slug, folder, filter, size, raws, expiry, tokens);
  create/edit modal (useBasaltForm + zod); per-share: copy URL, roll token (confirm modal), add token,
  delete (DangerZone-style confirm); show minted URLs with CopyButton.
- **Activity** `/activity` — StatCards from /api/stats, index status + "Rescan now", b2 objects table
  (mirrored badge), buttons for reconcile/reverse-backup (notifyPromise).
- **Uploads** — FileButton multi-upload to POST /api/images with progress notifications.

## 13. Testing (bun:test; fixtures generated in test setup — never touch real trees)

- Unit: paths.safeJoin traversal cases · share-auth (token/k/expiry/revocation/timing) · rendition cache
  key + sweep logic · filename-date fallback parser · RAW pairing.
- Route/integration: build app with `:memory:` drizzle db (run migrations programmatically) + temp dirs;
  fixture JPEGs generated with sharp (+ EXIF orientation via `.withMetadata({orientation})`, rating via
  exiftool-vendored write on the temp fixture only); cover: index → library list → create share → fetch
  share page HTML → fetch rendition with token → 404 on rolled token/expired/wrong-k → zip streams non-zero
  Zip64 bytes → upload → publish (S3 mocked via injected client port) → reconcile with mocked list.
- S3: `lib/s3.ts` exposes a tiny port interface (`list/put/get`) wrapping Bun.S3Client — injected fake in tests.
- `bun run check` = oxlint + oxfmt --check + tsc both apps + bun test (root script; CI-less for now).

## 14. Out of scope v1 (per PRD)

Search/tags/timeline, video, photos.jkrumm.com takeover, Immich removal (separate, human-gated),
signed imgproxy URLs, analytics, friend uploads, multi-user.
