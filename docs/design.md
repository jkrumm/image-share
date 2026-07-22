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
│       ├── share/{page/,routes.ts,zip.ts}   # page/ = index,styles,client,i18n,markdown,layout
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

Three explicit roots (stage 1 rework — replaces the old LIBRARY_ROOT-with-denylist model):

| root value | Env var | Container path | Mode | Content |
|-|-|-|-|-|
| `fuji` | `FUJI_ROOT` | `/photos/fuji` | ro | the Fuji JPEG tree — NEVER written |
| `raws` | `RAWS_ROOT` | `/photos/raws` | ro | flat Fuji `.RAF` tree |
| `share` | `SHARE_ROOT` | `/photos/share` | rw | service-owned ingest area (`root='share'`) |

Plus, not image roots:

| Env var | Container path | Mode | Content |
|-|-|-|-|
| `B2_MIRROR_DIR` | `/photos/b2-mirror` | rw | reverse-backup target of B2 `img/` |
| `DATA_DIR` | `/data` | rw | `db/image-share.sqlite` + `renditions/` cache (rebuildable) |
| `SNAPSHOT_DIR` | `/backup` | rw | nightly `VACUUM INTO` sqlite snapshot (restic-covered) |

`lib/paths.ts` exports the single `rootBaseDir(root)` helper mapping a root value to its base
dir — every route/module resolves through it rather than re-deriving the mapping. Hidden
files/dirs (`.` prefix) are always skipped by the indexer; there is no longer a top-level
exclude-dirs denylist (INDEX_EXCLUDE_DIRS is gone).

**Path safety (hard rule, everywhere):** every file access resolves `join(root, relPath)` and
asserts the resolved path starts with `root + sep` (lib/paths.ts `safeJoin(root, rel)`), throws 400 otherwise.
Image files are addressed by DB integer id in every route — raw paths never appear in URLs.

## 4. DB schema (SQLite, drizzle; snake_case columns; WAL mode on open)

```ts
images:      id int pk autoincrement; root text ('fuji'|'raws'|'share');
             rel_path text; dir text (posix dirname, '' at root); stem text; ext text (lower, no dot);
             kind text ('jpeg'|'raw'|'image'|'other'); file_size int; mtime_ms int;
             capture_at text? (ISO 8601); orientation int?; rating int?; width int?; height int?;
             raw_path text? (rel_path in RAWS_ROOT of the paired .RAF — set on jpeg rows only);
             indexed_at text; unique(root, rel_path); idx(dir), idx(capture_at), idx(rating)
b2_objects:  key text pk (full key incl. 'img/' prefix); size int; last_modified text; etag text?;
             mirrored_at text?; published_image_id int? (fk images.id, null for out-of-band uploads);
             first_seen_at text
shares:      id int pk; slug text unique (^[a-z0-9][a-z0-9-]{0,63}$); title text;
             source_type text ('folder'|'selection'); root text? (set iff source_type='folder');
             dir text? (set iff source_type='folder'); min_rating int?;
             expires_at text?; note text? (markdown); created_at text
share_images: share_id int fk→shares.id (cascade); image_id int fk→images.id (cascade);
             position int; pk(share_id, image_id); idx(share_id)
             — only populated when a share's source_type='selection'
share_tokens: id int pk; share_id int fk; token text unique;
             role text ('view'|'download'|'full'); label text?; created_at text; revoked_at text?
```

The DB is a cache EXCEPT `shares`/`share_images`/`share_tokens` (not rebuildable) — hence the
nightly snapshot cron. Rebuild = delete file, boot, re-index, restore shares from snapshot if needed
(a selection share's `share_images` rows reference `images.id`, which is only stable across a
rebuild if the filesystem hasn't changed in the meantime — a known limitation of the cache model).

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

Auth model (no cookies, no passwords — role-based rework, stage 1): query `token` must match a
non-revoked `share_tokens` row of a non-expired share; the matched token's `role`
(`view`|`download`|`full`) governs which sizes/routes it can reach (table below). Wrong/rolled/
expired/missing token, unknown slug, an id outside the share, or a size/route the role doesn't
permit → single opaque 404 HTML page ("This share does not exist or has been revoked") — never
distinguish cases. There is no unlock flow; a request to `/s/:slug/unlock` 404s like everything else.

| role | `/s/:slug/img/:id` sizes | `/s/:slug/file/:id` | `?raw=1` | `/s/:slug/zip` |
|-|-|-|-|-|
| `view` | `thumb`, `med` | 404 | 404 | 404 |
| `download` | `thumb`, `med`, `full` | original JPEG bytes | 404 | original JPEGs |
| `full` | `thumb`, `med`, `full` | original JPEG bytes | paired RAF | original JPEGs + RAFs |

Share content depends on `source_type`:
- `folder`: images where `root=share.root AND (dir = share.dir OR dir LIKE share.dir || '/%')
  AND kind='jpeg' AND (min_rating IS NULL OR rating >= min_rating)`, sorted by capture_at.
- `selection`: images joined through `share_images` on `share_id`, ordered by `position`.

Routes (all under `/s`, public):
- `GET /s/:slug` — server-rendered HTML (Stage 3 redesign, ported from the user's own
  `photo-flow` gallery: whitespace/restraint, no cards/shadows/border-radius). Page assembly lives
  in `share/page/` (split out of the old single `page.ts`): `index.ts` orchestrates, `styles.ts`
  holds the CSS strings, `client.ts` holds the two inline `<script>` bodies (`headScript` — tiny,
  runs in `<head>`, applies stored view/theme/lang before first paint; `mainScript` — segmented
  controls, lightbox, i18n swap, remembered-share bookkeeping; `landingScript` — the `/` page's own
  behavior), `i18n.ts` holds the de/en/es catalogues + `Accept-Language` parsing, `markdown.ts` is
  the hand-written escape-then-transform renderer for `share.note`, `layout.ts` computes bento tile
  spans. ALL CSS+JS is inline, zero external requests, `render404Page`/`renderLandingPage`/
  `renderSharePage` all exported from `share/page/index.ts`.
  - Three views (`view` setting, persisted client-side): `stream` (default; single column, the
    ported `--pad-x/--pad-y/--vh-deduct` geometry, `object-fit: contain`, no crop), `grid` (uniform
    1:1 `object-fit: cover` tiles, 2/3/4 responsive columns), `bento` (`grid-auto-flow: dense` with
    per-tile spans from `layout.ts`: landscape → 2 columns, portrait → 2 rows, every 7th tile → 2×2,
    else 1×1 — deterministic from index + aspect ratio so server and client always agree). Switching
    views uses the View Transitions API (`document.startViewTransition`, plain-callback form) with a
    CSS opacity/scale crossfade fallback when unsupported, skipped under `prefers-reduced-motion`.
  - One sticky control bar: three segmented groups (view / theme=light|dark|system / lang=de|en|es)
    with a sliding pill indicator, each persisted to `localStorage` (`image-share.{view,theme,lang}`)
    and applied pre-paint by `headScript`.
  - Header: title, a client-recomputed meta line (`Intl.DateTimeFormat`-based capture-date range +
    localized photo count, so it follows a language switch without a round-trip), the note rendered
    through `markdown.ts`, and a quiet text-button "Download all (.zip)" (download/full roles only).
  - `<dialog>` lightbox unchanged in spirit (prev/next/keyboard/swipe, `med` or `full` per role,
    per-image + RAW download links per role) with an opacity/scale open animation and body-scroll lock.
  - Every element with visible copy carries `data-i18n`/`data-i18n-aria`; the full de/en/es
    catalogue is always embedded for reload-free client-side language switching — its presence in
    the page is not itself a role signal, only the presence of the actual gated DOM elements is.
- `GET /` — the landing page (`renderLandingPage`, Stage 3, `apps/api/src/static.ts`), replacing the
  old always-404 root. Byte-identical for every visitor: no server lookup, no request-derived state
  of any kind (not even `Accept-Language` — its own client-side script resolves the initial language
  from `localStorage`/`navigator.language`). All behavior is client-side against
  `localStorage['image-share.shares']` (an array the share page's own script maintains: `{slug,
  token, title, count, savedAt}`, deduped by slug, appended/refreshed on every successful share page
  load): 0 remembered → a quiet neutral message; exactly 1 → immediate `location.replace` into it;
  more than 1 → a list (title, photo count, last-opened, localized) linking to each with a per-entry
  remove action. No endpoint anywhere validates or enumerates slugs/tokens for this page — it cannot
  become an oracle. The share page header gets a share switcher (same localStorage list, current
  slug excluded) once more than one share is remembered.
- `GET /s/:slug/img/:id?size=thumb|med|full` — rendition bytes, `Cache-Control: private, max-age=31536000, immutable`.
  Size must be permitted for the token's role (table above); id must belong to the share else 404.
- `GET /s/:slug/file/:id?raw=1` — attachment download of the original JPEG (download/full roles only;
  `raw=1` → paired RAF, full role only). view-role tokens 404 entirely.
- `GET /s/:slug/zip` — `makeZip` (client-zip) over a generator: original files (+ RAFs for full-role
  tokens) with `predictLength` → Content-Length. view-role tokens 404. Filename `<slug>.zip`.
  KNOWN CAVEAT (document in code + README): Bun.serve ReadableStream responses may ignore TCP
  backpressure (oven-sh/bun#32469) — acceptable single-user risk, re-check at upgrade time.

`token` is threaded into every asset URL by the page renderer.

## 8. Admin API (`routes/`, bearer `API_SECRET` via argo's onTransform scoped guard)

Public before guard: `GET /health` (no DB), `GET /api` (discovery JSON: name/version/docs/tags),
`/openapi` + `/openapi/json`, `/s/*`, SPA static. Everything else under `/api` is bearer-guarded.
Argo conventions apply wholesale: zod v4 + `mapJsonSchema: { zod: z.toJSONSchema }`, `z.coerce.number()`
for numeric params, `z.enum` never literal-unions, ISO date strings, `detail` with tags/summary/description
+ `security: [{ BearerAuth: [] }]`, `.get('', …)` at prefix root, `{ data, total }` pagination (limit ≤ 200).

- `GET /api/library/dirs` → `{ data: [{ root, dir, imageCount, ratedCounts: {r4plus…}, rawPairedCount, minCaptureAt, maxCaptureAt }] }`
  (root ∈ `fuji`|`raws`|`share`)
- `GET /api/library/images?root&dir&recursive&minRating&page&limit&sort=captureAt|name&order` → `{ data: ImageDto[], total }`
- `GET /api/library/images/:id/file?size=thumb|med|full|orig` — bytes. Accepts bearer header OR
  `?access_token=<API_SECRET>` (browser `<img>` tags; this route only).
- `POST /api/index/rescan` → 202 `{ started }` · `GET /api/index/status`
- Shares (role-based rework, stage 1; admin-UX rework, stage 2): `GET /api/shares` (each with tokens
  `{id, role, label, url, createdAt, revokedAt}` + `imageCount` + minted URLs
  `SHARE_BASE_URL/<slug>?token=…`) · `GET /api/shares/:id` → the same shape plus `images: ImageDto[]`
  (folder: live-filtered, capture_at ascending; selection: `share_images` in position order) — powers
  the admin share detail page ·
  `POST /api/shares { slug?, title, note?, expiresAt?, source: {type:'folder', root, dir, minRating?} |
  {type:'selection', imageIds} }` — `slug` auto-derives from `title` (lowercased, non-alphanumerics →
  `-`, collapsed/trimmed, `-2`/`-3`… on collision) when omitted; mints one initial token, role=`view` ·
  `PATCH /api/shares/:id { title?, note?, expiresAt?, minRating?, imageIds? }` (imageIds replaces a
  selection share's set, position = array order; rejected on a folder share) · `DELETE /api/shares/:id` ·
  `POST /api/shares/:id/roll` → revokes every active token, mints a same-role replacement for each →
  `{ tokens: TokenDto[] }` · `POST /api/shares/:id/tokens { role, label? }` → mints an additional
  non-revoking token → `TokenDto` · `POST /api/shares/:id/tokens/:tokenId/revoke` → revokes exactly
  that token → `TokenDto`.
- `POST /api/images` multipart `{ file, dir? }` → saves to `SHARE_ROOT/<yyyy>/<mm>/` (collision-safe name),
  indexes immediately (`root='share'`) → 201 `{ id, root, relPath, adminFileUrl }`
- `POST /api/publish` `{ imageIds: number[], prefix: 'fuji'|'blog'|'gen'|'misc' }` → for each: Bun.S3Client
  `.write('img/<prefix>/<filename>', file)` (skip+report if key exists), upsert b2_objects with
  published_image_id → `{ published: [{ id, key, cdnUrl }] }` where `cdnUrl` comes from `lib/cdn.ts`
  (below) — the single place both this route and `GET /api/b2` mint CDN URLs from.
- **CDN URL shape (`lib/cdn.ts`, stage 4 — verified live against the real bucket, not assumed from
  `~/SourceRoot/vps/docs/image-cdn.md` alone)**: `img.jkrumm.com`'s Traefik layer runs an
  `imgproxy-short` `replacepathregex` middleware in front of imgproxy
  (`~/SourceRoot/vps/apps/imgproxy/compose.yml`) that rewrites a short public path into imgproxy's raw
  `/_/.../plain/img/<key>` form. `cdnOriginalUrl(key)` → `${CDN_BASE}/<key minus img/ prefix>` (no
  processing-options segment — confirmed live to serve the original bytes; this is what `publish.ts`
  already emitted pre-stage-4 and it was correct). `cdnThumbUrl(key, width)` →
  `${CDN_BASE}/rs:fit:<width>/<key minus img/ prefix>` (confirmed live to serve a resized rendition,
  longest side bounded to `width`).
- `GET /api/b2?prefix=all|fuji|blog|gen|misc&page&limit&sort=lastModified|key|size&order` → b2_objects
  `{ data: [{ ...row, mirrored, publishedImageId, cdnUrl, thumbUrl }], total, totalBytes,
  unmirroredCount, lastReconcileAt }` — `total` is filtered by `prefix`/paginated; `totalBytes`,
  `unmirroredCount`, and `lastReconcileAt` are always bucket-wide (ignore the filter) so the admin
  Public page's header strip reads consistently regardless of the active filter. `thumbUrl` uses a
  480px width (matches the renditions 'thumb' size, design §6). `lastReconcileAt` comes from an
  in-memory status object in `cron/b2-reconcile.ts` (mirrors the indexer's status pattern, design §5)
  — not persisted, resets on restart.
- `POST /api/b2/upload` multipart `{ file, prefix: 'fuji'|'blog'|'gen'|'misc' }` → uploads straight to
  B2 under `img/<prefix>/<sanitized filename>` (never touches a local disk root), skips (does not
  overwrite) a pre-existing key, upserts b2_objects on success → `{ uploaded, key, cdnUrl, reason? }`.
- `DELETE /api/b2/:key` — `key` is a single URL-encoded path segment (slashes included, e.g.
  `img%2Ffuji%2Fx.jpg`). Rejects (400) unless the decoded key starts with `B2_PREFIX` and contains no
  `..`/NUL traversal segment — the only guard between this route and the bucket, since `backups/`
  lives in the same bucket as `img/` (see `~/SourceRoot/vps/docs/image-cdn.md`). Deletes via
  `S3Port.delete` then removes the b2_objects row. Destructive and irreversible.
- `POST /api/b2/reconcile` → 202 (S3 list `img/` → upsert/remove b2_objects rows)
- `POST /api/backup/reverse-run` → 202 (download b2_objects lacking `mirrored_at` OR changed etag into
  `B2_MIRROR_DIR/<key minus img/>`, set mirrored_at; then GET `UPTIME_KUMA_PUSH_URL` if set — via tracedFetch)
- `GET /api/stats` → `{ images, jpegs, raws, share, shares, activeTokens, b2Objects, b2Unmirrored, renditionCacheBytes, dbSizeBytes, lastIndexAt, version }`

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
Nav mental model (stage 4): **Library = private, on disk** vs **Public = published, on the CDN** —
two peer nav items (labeled "Library (Private)" and "Public (CDN)") rather than the CDN state being
buried in Activity.

- **Library** `/` — left dir tree (from /api/library/dirs), grid (SimpleGrid + AspectRatio + Image,
  thumb via access_token URL), rating filter (Rating component), sort, pagination; lightbox = Modal
  fullScreen with med rendition + prev/next/keyboard; selection mode → actions: "Publish to CDN…"
  (prefix picker modal → notifyPromise), "Create share" (selection share, capture-display order, via
  `CreateShareModal`); folder toolbar → "Share whole folder" (folder share carrying the active
  minRating, via the same modal) — hidden for `root='raws'`.
- **Public** `/public` (stage 4) — a browser for what actually lives on `img.jkrumm.com`, peer of
  Library. Header strip (StatCards): object count, total bytes, not-mirrored count, last reconcile
  time (all bucket-wide, from `GET /api/b2`'s aggregate fields) + Reconcile/Reverse-backup buttons
  (`notifyPromise`) — moved off Activity. An upload control (prefix `Select` + `FileButton multi` →
  `POST /api/b2/upload`, `notifyPromise` per file). A prefix filter (all/fuji/blog/gen/misc) + sort
  (lastModified/key/size) + order + pagination, mirroring the Library page's search-param + zod
  pattern. Thumbnail grid (SimpleGrid + AspectRatio + Image) loading `thumbUrl` **directly from
  img.jkrumm.com** — never proxied through this API. Per tile: size + last-modified, a "not mirrored"
  badge, a `CopyButton` for `cdnUrl`, and a delete action behind `modals.openConfirmModal` naming the
  key (`DELETE /api/b2/:key`). `EmptyState` when nothing is published yet.
- **Shares** `/shares` — admin-UX rework, stage 2: a pure navigation table (title, slug, source,
  image count, active-token count, created) whose rows link to the detail route; "New share" opens
  `CreateShareModal` in its root/dir-picker mode (the only entry point without ambient folder/selection
  context). `create-share-modal.tsx` asks only for title (autofocus, server-derived slug previewed
  client-side) + an optional markdown note — never re-asks for a folder/selection the caller already
  resolved.
- **Shares detail** `/shares/:id` — header (inline-editable title, slug, source line), Links section
  (per-token role badge/label/URL/CopyButton/created date, revoke-with-confirm, a "show revoked" toggle,
  "Add link" via the adapted `add-token-modal.tsx`, "Roll all links" replacing every active token),
  Images section (thumbnail grid; selection shares get a per-tile remove action patching `imageIds`,
  folder shares are read-only), a collapsed Settings section (note/expiry/minRating via PATCH), and a
  DangerZone delete action navigating back to `/shares`.
- **Activity** `/activity` — StatCards from /api/stats, index status + "Rescan now". The b2 objects
  table and the reconcile/reverse-backup buttons moved to **Public** (stage 4) — Activity keeps only
  the stats cards and the indexer control.
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
