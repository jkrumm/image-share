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
│       ├── lib/{auth-guard.ts,traced-fetch.ts,paths.ts,share-auth.ts,s3.ts,dir-scope.ts,album-scope.ts}
│       ├── indexer/{scan.ts,metadata.ts}
│       ├── renditions/{render.ts,cache.ts}
│       ├── share/{page/,routes.ts,zip.ts,attachment.ts}   # page/ = index,styles,client,i18n,markdown,layout
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

### 3.1 The browse axis is Lightroom's keyword tree, NOT the directory tree (architectural decision)

Measured against the live library, not assumed: **the Fuji tree is completely flat** — ONE directory,
2365 JPEGs; RAWS is flat too (3661 `.RAF`). `GET /api/library/dirs` returns 3 rows TOTAL, one per
root. A directory tree with no branches is not a browse axis, so `images.dir` stops being the
primary one for `root='fuji'` (it stays the mechanism for `root='share'`, where ingest writes
`<yyyy>/<mm>/`).

The hierarchy that actually exists is already in the files: Lightroom / Adobe Camera Raw on the Mac
writes `XMP-lr:HierarchicalSubject` (`'Ereignisse|Segeln 25'`) into every exported JPEG.
**image-share READS it into `image_keywords` (§4) and never writes metadata into an image file.**

| Alternative | Verdict |
|-|-|
| image-share writes/edits keywords itself | **Rejected.** A second writer racing Photomator/Lightroom over the same XMP fields loses metadata (last writer wins on a whole-packet rewrite), and the data is already there — writing adds nothing a read cannot give. It would also break the `FUJI_ROOT` ro contract. |
| Materialize the tree as directories on disk | **Rejected.** Same write, worse: it renames originals. |
| Read the keywords, treat them as the tree | **Shipped.** |

Coverage is the load-bearing number: **558 of 2352 JPEGs are tagged today** — 'Ereignisse|Segeln 25'
(550), 'Insta Post Segel 25' (37), 'Insta Post Marokko' (8) — so **~1794 images are UNTAGGED**.
The untagged bucket and the capture-date range are therefore **first-class browse surfaces, not edge
cases**: `/api/library/albums` always emits the synthetic `path=''` `(untagged)` node, and
`/api/library/images` carries `untagged` + `captureFrom`/`captureTo` as peers of `album` (§8). Any
UI that only offers the album tree reaches 24% of the library.

Ratings, for sizing filters: 1900 at 0, 238 at 3, 161 at 4, 6 at 5.

## 4. DB schema (SQLite, drizzle; snake_case columns; WAL mode on open)

```ts
images:      id int pk autoincrement; root text ('fuji'|'raws'|'share');
             rel_path text; dir text (posix dirname, '' at root); stem text; ext text (lower, no dot);
             kind text ('jpeg'|'raw'|'image'|'other'); file_size int; mtime_ms int;
             capture_at text? (ISO 8601); orientation int?; rating int?; width int?; height int?;
             raw_path text? (rel_path in RAWS_ROOT of the paired .RAF — set on jpeg rows only);
             indexed_at text; keywords_indexed_at text?;
             unique(root, rel_path); idx(dir), idx(capture_at), idx(rating)
image_keywords: image_id int fk→images.id (cascade); path text (FULL hierarchical keyword path,
             '|'-separated, e.g. 'Ereignisse|Segeln 25'); leaf text (last segment);
             pk(image_id, path), idx(path)
b2_objects:  key text pk (full key incl. 'img/' prefix); size int; last_modified text; etag text?;
             mirrored_at text?; published_image_id int? (fk images.id, null for out-of-band uploads);
             first_seen_at text
shares:      id int pk; slug text unique (^[a-z0-9][a-z0-9-]{0,63}$); title text;
             source_type text ('folder'|'selection'|'album');
             root text? (set for BOTH 'folder' and 'album'; null on 'selection');
             dir text? (set iff source_type='folder'; on 'album' it holds the
             ALBUM_SHARE_LEGACY_DIR poison pill — see below — and the API still reports null);
             album text? (set iff source_type='album'; a full image_keywords.path);
             recursive int not null default 1 (folder: sub-directories of dir; album: sub-albums
             below album; always 1 and ignored on a selection); min_rating int?;
             expires_at text?; note text? (markdown); created_at text
share_images: share_id int fk→shares.id (cascade); image_id int fk→images.id (cascade);
             position int; pk(share_id, image_id); idx(share_id)
             — only populated when a share's source_type='selection'
share_tokens: id int pk; share_id int fk; token text unique;
             role text ('view'|'download'|'full'); label text?; created_at text; revoked_at text?
```

`image_keywords` is the album tree (§3.1) — the axis the flat Fuji library is browsed and shared
along. Two non-obvious properties:

- **Ancestors are NOT materialized.** `'Ereignisse|Segeln 25'` stores exactly one row; there is no
  `'Ereignisse'` row. The table therefore stays exactly as large as the tags on disk and re-indexing
  one image is a delete+insert of its own rows. Subtree questions are a byte-exact half-open range
  on `path` instead (`lib/album-scope.ts albumAtOrBelow`, the keyword twin of `lib/dir-scope.ts`;
  same anti-`LIKE` reasoning as §7 — ASCII-case-insensitive `LIKE` would merge case-variant albums,
  and `%`/`_` would over-match). The prefix→node expansion happens only in the albums route (§8).
  A keyword with no `|` is a valid single-segment path.
- **`images.keywords_indexed_at` is a one-shot backfill marker, not a timestamp anyone reads.**
  NULL means "this row's keyword mirror was never reconciled", which is precisely the state of every
  row indexed before the table existed. The scanner's skip-when-unchanged fast path (§5) checks it,
  so those rows get one forced re-extract and the feature does not ship dead on the existing index —
  the migration creates `image_keywords` EMPTY, every already-indexed JPEG still matches on
  `file_size`/`mtime_ms`, so without the marker the scan would return before `extractMetadata`,
  `/api/library/albums` would report one giant untagged node forever, every album share would
  resolve empty, and the only way back would be deleting the sqlite file (which also destroys
  `shares`/`share_tokens`). It cannot be inferred from "has no keyword rows": ~76% of the library is
  *genuinely* untagged (§3.1) and would be re-extracted on every nightly scan. `kind='raw'` is
  exempt — a RAF carries no album keywords, so its marker stays NULL forever without dragging it
  into a re-read.
  **The marker is a skip-rule, not a trigger** — something still has to START a scan on a
  populated index, or the backfill waits for the nightly cron. That is `bootScanReason`
  (§9): `keywords_indexed_at IS NULL AND kind != 'raw'` on any row means "scan on boot", so a
  deploy backfills itself within minutes instead of showing an empty album tree until 05:15.
  `indexer/scan.ts` owns both halves of the predicate (`needsKeywordBackfill` and its SQL twin
  `keywordBackfillPending`) so the boot check and the scanner cannot disagree.
- **`shares.dir` on an album row is a rollback poison pill** (`ALBUM_SHARE_LEGACY_DIR = '/album'`,
  db/schema.ts), never read by this code and never returned by the API. A container rolled BACK to a
  binary predating album shares has no `album` branch — it reads every non-selection share through
  one folder filter, where a NULL `dir` means "no dir predicate at all", i.e. **the whole root**: a
  live friend link minted for one 550-image album would start serving all 2365 fuji JPEGs. Since
  `images.dir` is always a root-relative posix path, a leading `/` can match nothing in either
  legacy branch, so the rolled-back binary serves an EMPTY share instead. (NOT a NUL-based sentinel:
  bun:sqlite may bind text by C-string length, truncating it to `''` — the root, i.e. fail-open.)
  See §11 for what else a rollback breaks.

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
- **Album keywords (JPEG only)** — the same single `exifr.parse` call, now with `{ xmp: true,
  iptc: true }`, also yields the hierarchy of §3.1. Verified against the real files: exifr surfaces
  it as **lowercase `hierarchicalSubject: string[]`** (a bare string when the tag holds exactly one
  value — normalized through `toStringArray`). exiftool is **deliberately NOT in the JPEG hot path**:
  it is a per-file perl round-trip, and a 2365-file scan through it is crippling where exifr is one
  buffered read. It stays the RAF/sidecar reader only, and reads no keywords there at all (a RAF
  never carries them, and it would be a second round-trip).
  `extractKeywordPaths` takes the FIRST populated tag of `hierarchicalSubject` → `subject`
  (XMP-dc) → `Keywords` (IPTC) — never their union: the latter two are Lightroom's flat mirrors of
  the LEAF names, so merging them would flatten `'Ereignisse|Segeln 25'` back into a duplicate
  root-level `'Segeln 25'` album. They are the fallback for a file tagged outside Lightroom and land
  as valid single-segment paths. Segments are trimmed, empty segments/paths dropped, duplicates
  removed (Lightroom writes dc:subject twice on some files), source order preserved.
  `replaceKeywords` is an unconditional delete-then-insert of one image's rows — not a diff, because
  the delete is what handles "all tags removed in Lightroom" — and runs only where metadata was
  actually re-extracted, so the unchanged fast path stays a pure no-op. `keywords_indexed_at` is
  written in the same row update (§4); the backfill path is the `needsKeywordBackfill` clause in
  that fast path, which fires once per pre-existing row and never again — once a scan runs at all.
  Starting that first scan on an already-populated index is `bootScanReason`'s job (§9), through
  this module's `keywordBackfillPending` (the SQL twin of `needsKeywordBackfill`).
- RAW pairing: after scan, for each `library` jpeg with stem matching a `raws` row stem → set `raw_path`.
- Single-flight: module-level `running` flag; concurrent rescan requests return `alreadyRunning`.
  Status object `{ running, startedAt, lastFinishedAt, lastCounts:{scanned,added,updated,removed}, lastError }`.

## 6. Renditions (`renditions/`)

sharp pipeline: `sharp(abs).autoOrient().resize({ width/height fit:'inside' }).webp()/jpeg()`.
Sizes (FOUR): `thumb` = 480px webp q75 · `small` = 900px webp q80 · `med` = 1600px webp q82 ·
`full` = 2560px jpeg q88. `small` exists to close the 480→1600 srcset gap — a retina phone rendering
the share page's 2-column grid needs ~585w and otherwise pays for the 1600px candidate.
RAF inputs are never rendered (renditions come from the paired JPEG; RAFs only download/zip).
Cache: `DATA_DIR/renditions/<sha256(root|rel_path|mtime_ms|size).hex[0..32]>.<webp|jpg>`;
on hit, `utimes` the file (mtime = LRU clock). In-process per-key single-flight dedup.
Sweep cron: delete cache files with mtime older than `RENDITION_MAX_AGE_DAYS` (default 90),
then oldest-first until under `RENDITION_CACHE_MAX_GB` (default 20).

**Global concurrency gate (`withRenditionSlot`, `RENDITION_CONCURRENCY`, default 3).** The per-key
single-flight only dedupes *identical* requests; nothing bounded the total, so the first visitor to
a cold 100-photo share fired ~100 distinct keys — ~100 concurrent sharp decodes on a box with
**4 cores inside a 1 GB container limit**, i.e. an OOM-kill at exactly the worst moment. A
process-wide semaphore caps decodes in flight; everything past the cap queues instead of allocating
a decode buffer. Measured on the HomeLab: **~450 ms cold** for one 26 MP Fuji decode+encode,
**~35 ms warm** (cache hit). Only the decode/encode is gated — a cache hit costs no sharp memory and
must never queue behind cold renders. The permit is released on throw as well as on success (a
leaked permit narrows the gate to zero over time), and handed straight to the next waiter so the cap
can never be transiently exceeded. The limit is read per acquisition, not at module load, so tests
can override it (same pattern as the sweep knobs). `renditionSlotStats()` exposes in-use/queued/
acquired.

**sharp global configuration (`loadSharp` in `render.ts`).** Configured exactly once, the
first time sharp's native binding is actually loaded — lazily, inside the gated render path,
never at module scope, guarded by a promise-memoized singleton so N concurrent first-callers
still only run the configuration once. Two knobs:

- `sharp.concurrency(1)`. libvips defaults its own worker-thread pool to the physical core
  count (4 on the HomeLab container). `withRenditionSlot` already gates concurrent decodes
  process-wide (RENDITION_CONCURRENCY, default 3), so libvips' own pool was redundant
  multiplication on top of that gate, not extra throughput: worst case was 3 gated renders x 4
  libvips threads = up to 12 worker threads, each potentially holding tile buffers for a
  6240x4160 (26 MP) source, inside a 4-core / 1 GiB cgroup. Measured on the HomeLab: idle anon
  sits at 897-911 MiB of the 1 GiB limit (~89%), `memory.events: max` had fired 11258 times
  since boot, and `workingset_refault_anon`/`pgmajfault` (59396/24426) showed real anon reclaim
  thrashing — not page cache pressure. A 40-concurrent cold-render burst pegged memory at
  exactly 1024.0 MiB; it did **not** OOM-kill (`oom_kill 0`, `RestartCount 0`, all 88 requests
  returned 200) because the RENDITION_CONCURRENCY gate already caps decodes at 3, and CPU during
  a burst plateaus around 2.7-3.0 cores — the box is already CPU-bound at the width of our own
  gate, so a wider libvips pool bought no extra throughput, only more concurrent decode buffers.
  One libvips thread per gated render (1 x 3 = 3 worst-case threads, not 3 x 4 = 12) holds
  throughput while cutting peak decode-buffer count roughly 4x. (A later idle-to-burst
  measurement showed anon memory FALLING 863.9 -> 773.4 MiB under load — this was never a leak,
  just a high-water mark the process held onto once touched, which is exactly the pattern a
  smaller thread pool reduces.)
- `sharp.cache(false)`. libvips' operation cache defaults to 50 MB / 20 files / 100 cached
  operations, built for workloads that repeat the same operation graph against the same source.
  Ours never does: every rendition is content-addressed and cached forever on our own disk
  (above) the first time it's rendered, so a given source is decoded at most 4 times ever
  (thumb/small/med/full) before every future request is served straight off disk without
  touching sharp again. The in-memory operation cache buys real RSS for a structurally
  near-zero hit rate here, so it's disabled outright rather than tuned down.

Both are hardcoded constants, not env-tunable: they follow from facts that don't vary by
deployment ("we already gate concurrency ourselves", "we already cache renditions on disk
forever"), not from anything about the HomeLab box's specific core/memory shape that a future
deployment would need to override. RENDITION_CONCURRENCY remains the one exposed knob for the
actual pressure point (how many decodes run at once). The Dockerfile's jemalloc `LD_PRELOAD`
(tames sharp's long-run RSS via better glibc-malloc-arena behavior) is unaffected and stays.

## 7. Shares — the public surface (`share/`)

Auth model (no cookies, no passwords — role-based rework, stage 1): query `token` must match a
non-revoked `share_tokens` row of a non-expired share; the matched token's `role`
(`view`|`download`|`full`) governs which sizes/routes it can reach (table below). Wrong/rolled/
expired/missing token, unknown slug, an id outside the share, or a size/route the role doesn't
permit → single opaque 404 HTML page ("This share does not exist or has been revoked") — never
distinguish cases. There is no unlock flow; a request to `/s/:slug/unlock` 404s like everything else.

There are no exceptions to "no cookies" — the public surface sets nothing on a visitor's device,
full stop. One known, deliberately accepted consequence: tile 0 ships
`loading="eager" fetchpriority="high"` (below), so the browser's preload scanner fetches it
straight off the raw HTML bytes before any client script runs, and `headScript`'s
`MutationObserver` repair (which fixes the other 59 lazy tiles' `sizes` for a stored grid/bento
view before their fetch starts) cannot reach it in time. A returning visitor whose stored view
isn't `stream` gets tile 0 fetched at the wider STREAM candidate instead of the narrower one their
layout needs — one wasted ~450ms sharp decode. The browser never re-fetches a smaller candidate
once it has committed to one, so this is not even a double fetch, just a bigger single one. The
only server-side fix would be a cookie carrying the stored view; that trade was rejected — see the
`sizes` comment in `share/page/index.ts`'s `tileHtml`.

| role | `/s/:slug/img/:id` sizes | `/s/:slug/file/:id` | `?raw=1` | `/s/:slug/zip` |
|-|-|-|-|-|
| `view` | `thumb`, `small`, `med` | 404 | 404 | 404 |
| `download` | `thumb`, `small`, `med`, `full` | original JPEG bytes | 404 | original JPEGs |
| `full` | `thumb`, `small`, `med`, `full` | original JPEG bytes | paired RAF | original JPEGs + RAFs |

`small` (900px) sits with `thumb`/`med` in every role including `view`: it is a *smaller* rendition
than one `view` already reaches, so withholding it leaks nothing and only costs those visitors the
srcset bandwidth win.

The srcset `Nw` width descriptors are the ACTUAL pixel width `sharp`'s `fit:'inside'` resize
(`renditions/render.ts`) produces for that image, not the configured target — `renderedWidth`
(`share/page/index.ts`) derives it from the image's own `width`/`height`. A landscape/square photo
comes out exactly the target (480/900/1600); a portrait's HEIGHT hits the target first, so its
rendered WIDTH is proportionally smaller (a 2:3 portrait's `small` renders 600px wide, not 900) —
advertising the target instead would make the browser's density math wrong for every portrait.

Share content depends on `source_type`:
- `folder`: images where `root=share.root AND <dir scope> AND kind='jpeg' AND
  (min_rating IS NULL OR min_rating = 0 OR rating >= min_rating)`, sorted by capture_at. A
  `min_rating` of 0 means NO filter — `rating` is nullable and `NULL >= 0` is NULL, so applying it
  literally would silently drop every unrated image (all three admin surfaces send 0 as "any").
  The dir scope is chosen by `share.recursive` (a share is EITHER a selection OR a folder, and a
  folder share owns whether it reaches into subfolders):
  - `recursive=1` (default): `dir = share.dir OR (dir >= share.dir||'/' AND dir < share.dir||'0')` —
    a half-open range over the subtree (`'/'` 0x2F incremented to `'0'` 0x30); an empty `share.dir`
    means the whole root. Deliberately NOT `LIKE`: SQLite's `LIKE` is case-insensitive for ASCII and
    ignores `COLLATE`, so a `LIKE` subtree match would reach into a case-variant sibling directory
    (`trip/` under a share of `Trip/`) on the case-sensitive Linux filesystem. The range compares
    BINARY, needs no `%`/`_` escaping, and is sargable so it uses `images_dir_idx` rather than a full
    scan. The scope builder is `lib/dir-scope.ts dirAtOrBelow`, shared with the admin library browse
    so the create-share count preview can't diverge from real share membership.
  - `recursive=0`: `dir = share.dir` exactly — that folder's own images, nothing below it. An empty
    `share.dir` therefore means the root's immediate children only, not the whole root.
- `album` (§3.1): `root=share.root AND kind='jpeg' AND <keyword scope> AND <same min_rating rule>`,
  sorted by capture_at — the live-filtered twin of a folder share on the keyword axis.
  The scope is `lib/album-scope.ts albumAtOrBelow(share.album, share.recursive)` wrapped in a
  correlated `EXISTS` over `image_keywords`, deliberately not an INNER JOIN: an image tagged
  `'Ereignisse|Segeln 25'` AND `'Ereignisse|Segeln 25|Tag 1'` matches the scope twice, and a join
  would list and count that photo twice. `EXISTS` is a semi-join and still uses
  `image_keywords_path_idx` via the sargable range. `recursive=0` narrows to that album's own path
  exactly, no sub-albums.
  **An album share is root-scoped, exactly like a folder share — and for a sharper reason:**
  `SHARE_ROOT` is the only agent-WRITABLE root (`POST /api/images` stores uploaded bytes verbatim),
  so a cross-root album predicate would silently publish any ingested file that happens to carry —
  or was crafted to carry — a matching `XMP-lr:HierarchicalSubject` into a friend-facing share. It
  would also be un-previewable: `GET /api/library/albums` reports one root at a time, so the count
  the operator approves could never equal the share's real membership.
  Two fail-closed rules on corrupt/legacy rows: a missing `root` falls back to `'fuji'` (never "every
  root" — the only other root it could name is the writable one), and a NULL `album` resolves to
  `1 = 0` (empty share, never "every tagged image").
- `selection`: images joined through `share_images` on `share_id`, `AND kind='jpeg'`.

**Every share ships capture-ascending, whatever its source type** (`asc(capture_at), asc(id)`). The
selection branch deliberately does NOT order by `share_images.position`: `position` is written in
whatever order the admin grid happened to be sorted in when the tiles were ticked, and that grid
defaults to captureAt/**DESC** — so a selection share arrived at the friend scrolling the trip
backwards, and flipping the admin's sort to Name silently re-ordered a friend-facing gallery. The
browse sort is a browse preference; the order a gallery reads in is a property of the photos. The
admin now sends the same capture order (`features/library/selection.ts orderedSelection`), so the
review modal, the detail page, the share page and the ZIP all agree; `position` survives only as
insertion bookkeeping.

`kind='jpeg'` on the selection join is fail-closed for rows written before `POST /api/shares` vetted
its ids (§8): a `.RAF` has no rendition (§6), so it would make every one of its tiles a sharp decode
failure — a 500 on the friend's page, on a surface whose whole contract is that a denial is an
opaque 404 and never a stack trace. Such a row disappears from the listing, the by-id fetch, the
count and the ZIP alike.

One predicate (`shareImageFilter`, folder + album) backs the page listing, the by-id membership
check, `shareImageSummary` and the admin image count — they must never diverge, or an image the page
omits stays fetchable by id. `selectionFilter` is its selection-source twin, used by the same four.

`listShareImages(share, window?)` pushes the page-size limit into SQL for the windowed share page;
the ZIP and the admin count omit the window and get everything. Both branches order totally and
stably (`capture_at`, tie-broken by `id`) — without the tie-break two rows sharing a capture
timestamp could swap between windows and be shown twice or never.
`shareImageSummary(share)` is ONE aggregate query returning `{ total, firstCaptureAt, lastCaptureAt,
totalFileSize }`, so the page header never enumerates rows just to count them.

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
  `renderSharePage`/`renderShareTiles` all exported from `share/page/index.ts`.
  - **Windowed** (`SHARE_PAGE_SIZE = 60`): `?from=N` offsets the window, `?frag=1` returns just that
    window's tiles with no surrounding document. A 2352-image share must not ship 2352 `<figure>`
    blocks in the initial document. `mainScript` appends fragments on an IntersectionObserver
    sentinel; a visible "show more" link is the no-JS/failed-fetch fallback and is a real `href`
    (`?from=…`), so the whole gallery is reachable without JS. An out-of-range `from` on the
    non-fragment (full document) request (hand-edited, or stale after the share shrank) falls back
    to window 0 rather than an empty gallery; the SAME out-of-range `from` on a `frag=1` request
    returns an EMPTY window instead — that path is `loadMore()` walking forward from a client-cached
    `total` that may now be stale, and resetting to window 0 there re-serves already-appended tiles
    forever. Failed fragment fetches back off (1s × attempt, then give up) instead of re-firing at
    the observer's delivery rate — the sentinel stays intersecting after a failure, so a naive
    re-arm is a fetch loop for as long as the connection is down. The link/sentinel both carry
    visible feedback for a slow/failed fetch: `aria-busy` (dimmed, `cursor:progress`, mirroring the
    ZIP button) while in flight, and a `moreLoadFailed` message on rejection — a silent failure used
    to read as "the gallery is broken" even though one more successful tap already recovers it. The
    header's count/date-range/ZIP-size come from `shareImageSummary`, never from the rendered window.
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
    through `markdown.ts`, and a "Download all (.zip)" control (download/full roles only) that
    **carries its predicted size and photo count in its own label** ("1,9 GB · 84 Fotos", localized
    decimal units via `formatBytes`, mirrored in `mainScript` for language switches).
    WHY the label exists: **Bun DROPS the `Content-Length` we set on a `ReadableStream` response and
    sends `Transfer-Encoding: chunked`** — verified with curl at the origin INSIDE the container, so
    it is not a Cloudflare rewrite. The browser's own progress bar and ETA are therefore unavailable
    on a multi-GB download and nothing in `zip.ts` can restore them; surfacing the size in the UI is
    the only place left. `estimateShareZipBytes` sums the indexed `file_size` (zero syscalls) and
    adds a bounded-concurrency `stat` pass over paired RAFs only for a `full` role (RAF sizes are not
    indexed) — i.e. only on the owner's own link. Container overhead (~100 B/entry) is ignored at
    "1.9 GB" resolution. The fragment request skips this pass entirely.
  - `<dialog>` lightbox (prev/next/keyboard/swipe, `med` or `full` per role, per-image + RAW download
    links per role) with an opacity/scale open animation and body-scroll lock; it walks past the
    loaded window by pulling the next fragment (joining an in-flight one) and stays put on a failed
    fetch rather than bouncing a visitor 60 photos deep back to photo 1. The SAME "stay put" rule
    applies to a failed photo decode (a rolled token, a corrupt source JPEG, a container OOM): the
    preloaded `<img>`'s `onerror` never commits the failed url onto the visible frame — it leaves
    the current photo on screen and shows a `lightboxLoadFailed` message instead of a broken-image
    glyph on black with the spinner just gone.
  - **No-JS is a supported path, not a fallback ruin.** The tile click target is an `<a href>` to the
    largest rendition the role may open (`med`/`full`) — `mainScript` intercepts only unmodified
    left clicks, so modified clicks (new tab / save link as) keep working too. `headScript` sets
    `:root.js`, which gates every progressive-enhancement-only style so a script-less visitor never
    gets stuck with `opacity: 0` tiles or an invisible segmented selection; the segmented buttons
    ship their REAL default `aria-pressed` (view=stream, theme=system, lang=the page's locale)
    instead of nine identical greys; a `<noscript>` line points at the tile links.
  - Every element with visible copy carries `data-i18n`/`data-i18n-aria`; the full de/en/es
    catalogue is always embedded for reload-free client-side language switching — its presence in
    the page is not itself a role signal, only the presence of the actual gated DOM elements is.
  - **Link-preview metadata** (`metaHtml`, on the share page, the landing page and the 404 alike):
    `og:type`/`og:title`/`og:description` + `twitter:card=summary`, an inline data-URI SVG favicon
    (a real icon at zero external requests), and light/dark `theme-color`. The product is delivered
    by pasting a link into WhatsApp, so the recipient's first impression is that card.
    **DELIBERATELY NO `og:image`.** A crawler follows the FULL tokenised URL, so any advertised
    `og:image` would be fetched and then cached — indefinitely, outside our control — by Meta's and
    Apple's infrastructure, converting a private revocable share into a copy of the photo on a
    third-party CDN that rolling the token cannot reach. Text-only card, no image ever leaves the
    origin. `noindex, nofollow` on every public page for the same reason.
  - **`Referrer-Policy: no-referrer` on EVERY share response** (page, fragment, renditions, file
    downloads, the ZIP, and the 404), plus `<meta name="referrer" content="no-referrer">`. The token
    lives in the query string, so any outbound navigation — a link in the note, a RAW download opened
    elsewhere — would otherwise hand the full tokenised URL to a third party in `Referer`, a silent
    permanent grant of the share. The page body itself is `Cache-Control: private, no-store` (the URL
    contains the token, so no shared cache may keep it).
  - An unmatched non-machine path (`static.ts`) renders the **same opaque 404 page**, not Elysia's
    plain-text `NOT_FOUND` body — an unmatched `/s/...` shape would otherwise be visibly different
    from a denied one, which is exactly the distinction the public surface must never make.
    `/api`, `/openapi` and `/health` stay bare status 404s (an agent or probe has no use for HTML).
    The 404 also carries a tiny `notFoundScript` (client.ts) that swaps its two `[data-i18n]`
    strings to the visitor's stored `localStorage` language — `headScript` already rewrites
    `html[lang]` pre-paint on every page including this one, and without the matching text swap the
    404 was the one page on the site that ignored an explicit language choice. Still fully
    deterministic per `(locale, denial cause)` — the opaque-404 contract is unaffected, since this is
    client-only behavior with no new server-side signal.
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
- `GET /s/:slug/img/:id?size=thumb|small|med|full` — rendition bytes, `Cache-Control: private, max-age=31536000, immutable`.
  Size must be permitted for the token's role (table above); id must belong to the share else 404.
- `GET /s/:slug/file/:id?raw=1` — attachment download of the original JPEG (download/full roles only;
  `raw=1` → paired RAF, full role only). view-role tokens 404 entirely.
- `GET /s/:slug/zip` — `makeZip` (client-zip) over a generator: original files (+ RAFs for full-role
  tokens). view-role tokens 404. Filename `<slug>.zip`.
  Sizing is an async `stat` pass bounded to 32 in flight (`statAll`), never `statSync` in a loop
  (2000 blocking syscalls before the first ZIP byte stalls every other visitor's renditions) and
  never an unbounded `Promise.all` (2000 fds inside a 1 GB container). An indexed file missing from
  disk is skipped so the rest still downloads, but logged (`share.zip.missing_files`, sample capped
  at 10) — the page count and the archive's entry count now disagree with no other signal.
  `Content-Disposition` for both this route and `/file/:id` comes from the shared
  `share/attachment.ts` RFC 5987 builder — both interpolate user-controlled values (a slug, an
  indexed `rel_path`), where a raw `"`/newline is response splitting.

  **The archive is spooled to disk and served as a `Bun.file` — it is never a streamed
  `ReadableStream` response.** This replaces the old `new Response(makeZip(...))`, and it resolves
  both of the caveats this section used to carry.

  *Why.* Caveat 1 stopped being a theoretical risk and took the service down: pulling `segeln-25`'s
  550-image full-role archive (~19 GB) at ~5 MB/s drove the container to its cgroup ceiling and
  restarted it after only ~227 MB had reached the client — twice, at 1 GiB and again at 2 GiB, so
  raising the limit only moved the wall. The cause is oven-sh/bun#32469: `readStreamIntoSink`
  drains a JS body into uWS's unbounded buffer and discards `sink.write()`'s result, so the producer
  never learns the socket is backed up. Fixed upstream by PR #32553, merged 434 commits **after** the
  v1.3.14 tag — no released Bun contains it.

  *What was measured on 1.3.14* (raw TCP client that sends the request and then reads nothing).
  Every JS-body shape ran the producer free to the cap instead of applying backpressure:

  | body | produced | RSS |
  |-|-|-|
  | default `ReadableStream` (hwm 1) | 512 MiB (cap) | +1318 MiB |
  | `type:'bytes'` (BYOB) | 512 MiB (cap) | +512 MiB |
  | async-generator body | 512 MiB (cap) | +514 MiB |
  | `type:'direct'` + `await flush(true)` | 2048 MiB (cap) | 4.4 GiB |
  | **`new Response(Bun.file(p))`** | **kernel-paced** | **+8 MiB on a 3 GiB file** |

  `type:'direct'` is the decisive one: `controller.write()` returned the full positive chunk length
  on every call and never the negative backpressure sentinel, because Bun's `HTTPServerWritable`
  reports success unconditionally. There is no `desiredSize`, `drain`, or buffered-bytes signal for
  HTTP responses either (`backpressureLimit`/`getBufferedAmount()` are WebSocket-only). Wrapping
  client-zip is pointless for the same reason: it is already strictly pull-driven with a one-chunk
  lookahead, and the layer ignoring backpressure sits *above* whatever stream it is handed — any zip
  library hits the identical wall. `Bun.file` is bounded because Bun serves it with `sendfile(2)`:
  the kernel paces it against the socket and no JS sink exists. So memory is now bounded **by
  construction**, at any archive size and any client speed, because no part of the response is
  produced by JavaScript.

  *Mechanics.* `DATA_DIR/zip-spool/<key>.zip`, a content-addressed LRU cache with the same shape as
  the rendition cache (§6): key = `sha256(v1|slug|role|<entry name|size|mtime>…)` first 32 hex, mtime
  as the LRU clock, oldest-first eviction under a 40 GiB budget swept *before* each build, and
  `.part` files reaped after 6 h. Built via `rename(2)` from a `.part`, so a reader can only ever
  observe a complete archive. The spool loop flushes its sink before the next `read()`, so exactly
  one chunk is resident — measured 51 MiB RSS spooling 500 MiB at ~400 MiB/s. Concurrent requests for
  the same key join one build.

  **A build outlives its visitors.** A disconnect detaches the waiter and returns the same opaque 404
  as every other non-answer; it does not touch the build. This used to be refcounted — the last
  waiter out aborted the build, whose error path unlinks the `.part` — and that turns every timeout
  into an unrecoverable loop rather than a slow first attempt: cloudflared drops the 19 GB build at
  ~100 s, minutes of work are deleted, the retry starts from zero and 524s again, forever. A started
  build now always runs to completion and publishes, so attempt two is a `tryStat` hit and one
  `sendfile`. The work is bounded (a fixed file set), deduped by key, and swept under the same LRU
  budget as every other spool.

  **The spool loop yields to the event loop every 20 ms.** Nothing in it is a real suspension point —
  a page-cached `Bun.file` read and a `FileSink.flush()` both settle as microtasks, and the CRC32
  pass is pure CPU — so it used to drain the microtask queue for the whole build while the macrotask
  queue starved: measured over 400 MiB, a 50 ms `setInterval` ticked **zero** times in 967 ms. That
  starves `GET /health`, and the container `HEALTHCHECK` (10 s interval, 5 s timeout, 3 retries)
  restarts the container mid-build — the original "restarts during a big download" symptom by another
  route. It also queued every other visitor's page and rendition behind the archive, and made the
  disconnect above undeliverable. The yield costs nothing measurable (400 MiB: 967 → 975 ms, 434 →
  430 MB/s, 15 of an ideal 20 ticks) and everything time-based during a build depends on it.

  `request.signal` does fire in this phase (measured: 505 ms after the socket died) because the spool
  runs before a response exists; #17591's unreliable-abort applies to streaming responses, which this
  no longer is.

  **The origin's own idle timeout is a ceiling on the build, and needs a heartbeat.**
  `Bun.serve({ idleTimeout })` is time-to-*next*-byte, and a spooling request emits nothing until the
  archive is complete (the old streamed body reset that timer continuously). Bun refuses any value
  above 255 (`Bun.serve expects idleTimeout to be 255 or less`, measured), so raising the tunnel's
  origin timeout cannot lift it. The zip route therefore re-arms its own request's timer while it
  waits (`keepRequestAlive`, `server.timeout(request, 255)` every 30 s), leaving every other route on
  the global setting. Measured against `idleTimeout: 2`: a request silent for 20 s was still served
  when re-armed every 500 ms, and died at 4.1 s without. (`timeout(request, 0)` would disable the
  timer outright, but then a stalled client in the `sendfile` phase holds a socket forever. Trap
  worth recording: uWS's timer has a ~4 s granularity, so a re-arm of ≤4 s can still be swept at the
  next tick — irrelevant at 255.) The heartbeat is a timer, so it only fires because the spool loop
  yields.

  *Consequences.* Caveat 2 is gone — `Content-Length` is real again (a file response keeps it, so the
  browser gets its progress bar and ETA back). Re-downloading costs one `sendfile`. The
  `estimateShareZipBytes` label (§7 share page) is unchanged and still useful as an up-front size
  hint on the page itself.

  **`Range` was attempted twice and REMOVED — do not re-add it.** An earlier version of this section
  claimed "Bun answers a byte-range request against a `Bun.file` response with its own 206 +
  `Content-Range` natively (verified on 1.3.14)". True in isolation, false as deployment advice:
  `curl -r 100-200` against the live `segeln-25` archive (19 GB, spinning disk) got a 502 after 8.8 s
  with a 16-byte body; the identical request against `http://localhost:7720` *inside* the container —
  ruling out Cloudflare and Caddy both — never answered at all, and `GET /health` failed its 5 s
  timeout within seconds and kept failing until Docker restarted the container (~1m45s later,
  RestartCount 1→2, `ExitCode 0`, not OOM). That led to a second attempt: `Range` hand-parsed in
  `zip.ts` (RFC 7233 §2.1 single-range-spec grammar) and answered via an explicit
  `Bun.file(path).slice(start, end)`, on the theory that Bun's automatic dispatch — unconditional and
  unsuppressible from JS for a bare, un-sliced `Bun.file()` body — was the whole problem and a
  slice-based answer would sidestep it.

  **That second fix took the container down too.** The decisive measurement, taken at the origin
  inside the container (Cloudflare confirmed to return byte-identical numbers):

  ```
  curl -r 100-200 http://localhost:7720/s/prod-validation-fuji-5-star/zip?token=...
    HTTP/1.1 206 Partial Content
    Accept-Ranges: bytes
    Content-Range: bytes 100-200/191797795      <- our header, correct
    (NO Content-Length header at all)
    actual bytes transferred: 191,797,695       <- start -> EOF, not start -> end
  ```

  Our own `Content-Range` end was correct; the body still streamed to EOF regardless — the slice's
  upper bound was silently lost somewhere in Elysia's response mapping (the missing `Content-Length`
  is the tell: the body was being streamed, not served as a bounded file). Isolated on the same Linux
  container OUTSIDE Elysia, a sliced `BunFile` response is honored exactly
  (`Bun.serve({ fetch: () => new Response(Bun.file(p).slice(100, 201)) })` → 206,
  `content-length: 101`, 101 bytes received) — so `Bun.file(...).slice()` itself is not the bug, going
  through this Elysia route is. On the 191 MB archive that EOF-streaming was a survivable 14 s; on the
  19 GB `segeln-25` archive, a 100-byte range request became a 19 GB transfer to a client that had
  already gone away — the same wedge as before, on a different mechanism.

  **So the hand-rolled `Range` parsing/branching is gone.** `zip.ts` implements no `Range` handling of
  its own any more and `GET /s/:slug/zip` never sends `Accept-Ranges`. The body is still an *explicit*
  `Bun.file(path).slice(0, file.size)`, never the bare `file` object — that part of the design
  survives, as the same `sendfile`-backed, memory-flat body every other response on this route uses.

  **This does NOT mean every `Range` request gets a literal 200 — verify before repeating that claim.**
  An earlier draft of this fix assumed a full-span slice sidesteps Bun's automatic dispatch the way a
  bare file cannot. Directly measured against `buildShareZip` behind a real `Bun.serve`, both with and
  without Elysia in front of it (Bun 1.3.14): for a syntactically valid single-range header (`N-M`,
  `-N`, `N-`) Bun's OWN native dispatch still answers 206 — or 416 out of bounds — for *any*
  `Bun.file`/`Blob`-backed response body, full-span slice included, and this is unsuppressible from JS
  (an explicit `status: 200` is silently overridden; deleting the incoming header first changes
  nothing). Only Elysia's own `app.handle()` unit-test harness hides this, because it never reaches the
  real `Bun.serve`/uWS boundary where the dispatch happens — a test built on it alone would wrongly
  conclude `Range` is fully gone. A malformed, multi-range, or reversed `first > last` header — every
  case RFC 7233 says to ignore — still falls through to the ordinary whole-archive 200, because Bun's
  own parser ignores those too, matching the old hand-rolled `full` case exactly.

  **What is actually different, and why it's safe now:** the removed per-request slice's declared
  bounds (`Content-Range: bytes 100-200/…`) could diverge from what actually streamed
  (`start -> EOF`) — that mismatch is what wedged. A full-span slice cannot diverge like that: whatever
  sub-range Bun's own native dispatch serves out of it is always a true, in-bounds slice of the real,
  complete archive, with `Content-Length` matching the actual byte count exactly. A 206/416 from this
  route now is Bun's own correctly-bounded behavior, not a bug. `Bun.file(path).stream()` remains ruled
  out for the reason it always was: it is a `ReadableStream` body and inherits the exact backpressure
  bug (oven-sh/bun#32469) this whole archive-spooling design exists to route around — measured RSS to
  10+ GiB against a 3 GiB file and a stalled reader. If a literal 200 on every `Range` shape is a hard
  requirement rather than "no longer wedges", the fix is not more JS in this route — it is stripping
  `Range` at the edge (Caddy/Cloudflare, before the origin ever sees it) or a Bun upgrade that changes
  this dispatch.

  *The cost, paid honestly.* A download that dies partway now **restarts from zero** rather than
  resuming — that part of the original `Range` intent is gone. This is exactly why the spool cache
  matters: the retry is a `sendfile` of an already-built archive, not a rebuild, so a dropped
  connection costs a re-download, not a re-pack.

  *The cost.* Time-to-first-byte is the spool time, paid once per (share, role, file-set). A friend's
  download-role archive (~2.75 GB of JPEGs, SSD) spools in seconds. The share page tells the visitor
  to expect the wait for anything larger — the download control stays in its "preparing" state for an
  archive-sized window (`zipBytes` at a pessimistic 20 MB/s, clamped to 20 s…10 min) with a localized
  line saying the archive is being packed and will start on its own, instead of the fixed 20 s that
  used to un-busy the button while minutes of build were still to come.

  **`SHARE_ZIP_MAX_BYTES` (env.ts) — a hard cap on the predicted archive, below "slow" territory
  entirely.** The paragraph this replaced described the 19 GB `segeln-25` full-role archive (JPEGs +
  550 paired RAFs) as a *slow first attempt* that 524s against Cloudflare's ~100 s origin timeout and
  then serves from the spool on retry. That turned out to understate the problem: measured directly
  against the live box, SERVING that archive (not building it — the spool itself completes fine)
  wedges the event loop hard enough that `GET /health` stops answering, the Docker `HEALTHCHECK`
  times out three times in a row, and the container restarts — reproduced repeatedly, not a one-off.
  The same share's download-role archive (JPEGs only, no RAFs) has none of this problem:

  | role | entries | bytes | spool | serving |
  |-|-|-|-|-|
  | `download` (JPEGs only) | 550 | 3,781,140,298 (3.78 GB) | 31.4 s | **works** — ttfb 31.5 s, 0 restarts, RSS settles back to 66 MiB |
  | `full` (JPEGs + 550 RAFs) | 1100 | 19,101,542,662 (19 GB) | 170 s | **fatal** — wedges `/health`, healthcheck restarts the container |

  Controls that rule out the obvious suspects, all measured on the same box: a 191 MB archive
  survives a full download, an abort after 1 MB, and a vanished client — 0 restarts, so this is not
  generic client-abort handling. It is not the `Range` header (removed above) — a plain, Range-less
  request kills the service just as fast; the first probe in the failing run returned 200 and the
  service died immediately after. It is not memory growth during the spool — that phase is fine and
  settles (see the bounded-memory story above); the fatal phase is *serving*, not spooling. So it is
  specifically serving a very large already-spooled file that this Bun/Elysia runtime cannot survive,
  and the threshold sits somewhere between 3.78 GB (fine) and 19 GB (fatal) — 5 GiB is the default,
  chosen comfortably above the verified-working number and far below the verified-fatal one.

  The check lives in `buildShareZip` (zip.ts): `predictLength` over the stat'd entry list is already
  computed for the spool sweep's headroom, so testing it against the cap costs nothing extra, and it
  runs BEFORE the spool is ever touched — an over-cap archive is never built, cold request or warm.
  `share/routes.ts` turns the resulting `ZipTooLargeError` into **413, never the opaque 404**: the
  token and role are both valid, so this is a capacity limit, not a denial, and folding it into the
  same 404 as a revoked link would tell a legitimate visitor with a real share that it is dead.
  `renderZipTooLargePage` (page/index.ts) explains the limit in the visitor's locale and links back to
  the gallery — reachable only via a direct/bookmarked hit on `/s/:slug/zip`, because the share page's
  own control (`renderSharePage`'s `zipControlHtml`) never renders a working link to an archive the
  server has already decided it cannot build: over the cap, the `.zip-toolarge` block replaces it with
  the same explanation inline, plus — for a `full`-role share whose JPEGs alone would clear the cap
  (the paired RAFs are what pushed it over) — a hint stating that smaller total. That hint is a fact
  about THIS share's own JPEGs, which the same token can already see and download one by one; it never
  names or implies another token, role, or link, so it cannot become the kind of oracle the opaque-404
  contract exists to prevent. `SPOOL_MAX_BYTES` (zip.ts) came down from 40 GiB to 20 GiB alongside this
  — the old number was sized to fit the 19 GB archive this cap now refuses outright, so keeping it at
  8x the largest possible archive (5 GiB) was pure headroom no longer needed; 20 GiB (4x) still leaves
  comfortable room for several distinct (share, role) archives cached at once on a single-user service.

  **Do not raise `SHARE_ZIP_MAX_BYTES` without re-measuring on the actual deployment.** It is a
  property of this box (RAM, spinning-disk spool throughput, whatever in the Bun/Elysia response path
  is actually wedging), not a portable constant, and the failure mode when it is wrong is the whole
  container restarting under every visitor mid-download, not a clean error for one. If the underlying
  wedge is ever root-caused and fixed (a Bun/Elysia upgrade, or isolating the cause below the response
  layer), the fix is un-cap the route, not raise the number blind.

  If the first-attempt-slow problem returns for an UNDER-cap archive (a large `download`-role share on
  a slow spinning-disk read), the fixes in order are: raise the tunnel's origin timeout in `homelab`;
  or upgrade past #32553 (`oven/bun:canary` pinned by digest, or 1.3.15/1.4.0 when it ships) and drop
  the spool entirely — at which point the streamed response becomes correct again. `Range` is not
  coming back either way; the earlier reasoning for it (resumable multi-GB downloads) is superseded by
  the spool cache making a retry cheap regardless.

`token` is threaded into every asset URL by the page renderer.

## 8. Admin API (`routes/`, bearer `API_SECRET` via argo's onTransform scoped guard)

Public before guard: `GET /health` (no DB), `GET /api` (discovery JSON: name/version/docs/tags),
`/openapi` + `/openapi/json`, `/s/*`, SPA static. Everything else under `/api` is bearer-guarded.
Argo conventions apply wholesale: zod v4 + `mapJsonSchema: { zod: z.toJSONSchema }`, `z.coerce.number()`
for numeric params, `z.enum` never literal-unions, ISO date strings, `detail` with tags/summary/description
+ `security: [{ BearerAuth: [] }]`, `.get('', …)` at prefix root, `{ data, total }` pagination (limit ≤ 200).

- `GET /api/library/dirs` → `{ data: [{ root, dir, imageCount, ratedCounts: {r4plus…}, rawPairedCount, minCaptureAt, maxCaptureAt }] }`
  (root ∈ `fuji`|`raws`|`share`)
- `GET /api/library/albums?root=fuji|raws|share` → `{ data: AlbumNode[] }` where `AlbumNode =
  { path, leaf, depth, imageCount, ratedCounts, minCaptureAt, maxCaptureAt }` — **the virtual folder
  tree the admin browses instead of directories** (§3.1; deliberately `DirDto`-shaped minus
  `rawPairedCount` so one component renders either tree).
  One node per distinct path PREFIX: a stored `'Ereignisse|Segeln 25'` emits BOTH an `'Ereignisse'`
  and an `'Ereignisse|Segeln 25'` node — the ancestor expansion the table does not materialize (§4)
  happens here, in memory. Plus a synthetic `path='' leaf='(untagged)'` node covering every
  `kind='jpeg'` image with no keywords at all, always emitted even at count 0 (it is ~76% of the
  library, not an edge case). `imageCount` is RECURSIVE and deduped per image via a `Set`, so an
  image tagged with two sibling paths counts once in their shared parent. Sorted by `path`
  (code-unit order, matching the BINARY collation `albumAtOrBelow`'s ranges assume), so untagged
  comes first. JPEG-only — RAFs carry no keywords.
  Implementation: ONE indexed pass over (keyword × image) for the whole root, aggregated in memory.
  A per-node recursive CTE is the only pure-SQL alternative; the real shape is ~600 keyword rows
  against 2.4k images, so the single scan wins outright.
  An album share is scoped to the SAME `root` as the tree it was previewed in, so a node's
  `imageCount` IS the share's membership (before `minRating`).
- `GET /api/library/images?root&dir&kind&recursive&album&untagged&captureFrom&captureTo&minRating&stem&page&limit&sort=captureAt|name&order` → `{ data: ImageDto[], total }`
  - `album` — an `/api/library/albums` path, scoped at-or-below by the same `recursive` toggle via
    the shared `albumAtOrBelow` + `EXISTS` (dedupe, §7). `album=''` is "in any album".
  - `untagged` — string boolean, no keywords at all; the exact complement of `album=''`. Sending
    both `album` and `untagged` is **400**, not a silent empty result: they are two different
    questions about the same axis, so asking both is a client bug.
  - `captureFrom`/`captureTo` — inclusive bounds, an ISO instant or a bare `YYYY-MM-DD` meaning that
    whole UTC day (`T00:00:00.000Z` … `T23:59:59.999Z`), so `?captureFrom=2026-07-04&captureTo=
    2026-07-11` is "the Mallorca week". `capture_at` is stored as a UTC `toISOString()` string, so
    the compare is lexicographic on the same normalized shape and `images_capture_at_idx` stays
    sargable; an offset datetime is round-tripped through `Date` first rather than compared
    byte-wise. NULL `capture_at` rows drop out once either bound is set.
  - (`recursive` is parsed as a string boolean — `z.coerce.boolean()` would make `recursive=false`
  true — and applies to `dir` and `album` alike; `kind` and the shared `dirAtOrBelow` scope let the
  create-share preview match a folder
  share exactly; `minRating=0` means no filter, as in the share predicate; `stem` is a
  case-insensitive substring match against the filename stem — a plain `LIKE` already satisfies
  "case-insensitive" since SQLite's `LIKE` is ASCII case-insensitive by default, same as the b2
  `prefix`/`q` filters below)
- `GET /api/library/images/:id/file?size=thumb|med|full|orig` — bytes. Accepts bearer header OR
  `?assetToken=…` (browser `<img>` tags; this route only) — a short-lived (1h) HMAC-signed token,
  never the raw `API_SECRET`. `POST /api/library/asset-token` (bearer-guarded) mints one.
- `DELETE /api/images/:id` — deletes an image. Only `root='share'` images may be deleted (403 on
  `fuji`/`raws`, which are read-only source trees); 404 on an unknown id. Removes the file under
  `SHARE_ROOT`, its cached renditions (all four sizes, by recomputing the content-addressed cache
  key from the row's identity — design §6), and the `images` row. `share_images` rows referencing it
  cascade automatically (schema FK). `b2_objects.published_image_id` has no cascading FK — if the
  image was published, its `b2_objects` row is kept and only `published_image_id` is nulled; the B2
  object itself is never deleted by this route (that stays `DELETE /api/b2/:key`'s job).
- `POST /api/index/rescan` → 202 `{ started }` · `GET /api/index/status`
- Shares (role-based rework, stage 1; admin-UX rework, stage 2): `GET /api/shares` (each with tokens
  `{id, role, label, url, createdAt, revokedAt}` + `imageCount` + minted URLs
  `SHARE_BASE_URL/<slug>?token=…`) · `GET /api/shares/:id` → the same shape plus `images: ImageDto[]`
  (the resolved set, **capture_at ascending for every source type** — §7; folder/album live-filtered,
  selection joined through `share_images`) — powers the admin share detail page. `ShareDto` carries `sourceType: 'folder'|'selection'|'album'`
  and a nullable `album` alongside `root`/`dir` ·
  `POST /api/shares { slug?, title, note?, expiresAt?, role?, source: {type:'folder', root, dir, recursive?, minRating?} |
  {type:'album', album, root?, recursive?, minRating?} | {type:'selection', imageIds} }` — `slug`
  auto-derives from `title` (lowercased, non-alphanumerics → `-`, collapsed/trimmed, `-2`/`-3`… on
  collision) when omitted; mints one initial token with `role` (`view`|`download`|`full`, **default
  `view`**) — the common case is minting a download link in one call instead of create-then-add-token.
  `album` is required and non-empty (an empty album would mean "every tagged image" — a different,
  unrequested kind of share and a foot-gun on a public surface) and `root` defaults to `'fuji'`,
  matching the tree the path came from (§7 for why it is scoped at all).
  **A selection's `imageIds` are vetted before anything is written** (`checkShareImageIds`): every id
  must exist and be renderable (`kind='jpeg'`). A RAF id is one click away — the RAWs root is a
  first-class browse axis (§12) and "Select all N matching" takes all 3661 of its rows — and it has
  no rendition (§6), so it 500s every one of its tiles on the friend's page. **Rejected with 400
  naming the ids, never silently filtered**: a share is a promise about a specific set, and quietly
  shipping fewer photos than were asked for is the same class of defect as quietly shipping more (the
  scope-vs-snapshot rule in §12). This route is equally the agent contract, so the check lives here
  and not only in the admin — which additionally blocks it in the UI, before the modal opens. The
  ids' ORDER carries no meaning: every share ships capture-ascending (§7) ·
  `PATCH /api/shares/:id { title?, note?, expiresAt?, minRating?, recursive?, album?, imageIds? }` —
  each scope field is **rejected where it is meaningless** rather than silently stored (a stored
  `minRating` on a selection share reads as an active filter in the admin UI while the predicate
  ignores it): `minRating`/`recursive` 400 on a selection, `album` 400 on anything but an album
  share, `imageIds` 400 on anything but a selection (it replaces the set, under the same
  exists-and-renderable vetting as create — a rejected PATCH leaves the old set untouched) ·
  `DELETE /api/shares/:id` ·
  `POST /api/shares/:id/roll` → revokes every active token, mints a same-role replacement for each →
  `{ tokens: TokenDto[] }` · `POST /api/shares/:id/tokens { role, label? }` → mints an additional
  non-revoking token → `TokenDto` · `POST /api/shares/:id/tokens/:tokenId/revoke` → revokes exactly
  that token → `TokenDto`.
- `POST /api/images` multipart `{ file, dir? }` → saves to `SHARE_ROOT/<yyyy>/<mm>/` (collision-safe name),
  indexes immediately (`root='share'`) → 201 `{ id, root, relPath, adminFileUrl }`. Rejects (400)
  before writing anything to disk: an extension outside the indexer's recognized set (`EXT_KIND` —
  `jpg`/`jpeg`/`png`/`webp`/`avif`/`heic`/`raf`, indexer/scan.ts), a declared MIME type outside the
  matching allowlist (`CONTENT_TYPE_BY_EXT`, library.ts), or a file over 50 MB. The MIME check is
  documented dead weight in the current runtime: Bun's multipart parser re-derives `File#type` from
  the filename extension rather than the wire `Content-Type` header (verified live — a raw multipart
  part declaring `Content-Type: application/pdf` on a `sneaky.jpg` field still yields
  `type: "image/jpeg"` in the handler), so the client's declared MIME can never actually disagree
  with the extension today. Kept as defense-in-depth against a future parser change; the extension
  check is the real gate. Without the upfront check, an unsupported extension would still write the
  file to `SHARE_ROOT` and only then fail in `indexSinglePath`, orphaning it on disk — the up-front
  reject avoids that.
- `POST /api/publish` `{ imageIds: number[], prefix: 'fuji'|'blog'|'gen'|'misc' }` → for each: Bun.S3Client
  `.write('img/<prefix>/<filename>', file)` (skip+report if key exists), upsert b2_objects with
  published_image_id → `{ published: [{ id, key, cdnUrl }] }` where `cdnUrl` comes from `lib/cdn.ts`
  (below) — the single place both this route and `GET /api/b2` mint CDN URLs from.
- **Opaque-prefix key naming (`lib/naming.ts`)**: since the CDN serves unsigned URLs, `gen`/`misc` get a
  random 16-char `[a-z0-9]` basename (extension preserved) instead of the file stem — the object name
  itself is the access control, mirroring the dotfiles `imgcli` tool. `fuji`/`blog` stay stem-based
  (they're meant to be a browsable, readable gallery). Both `POST /api/publish` and
  `POST /api/b2/upload` derive keys through this one helper. Because a random name breaks the
  "skip if key exists" republish guard, `POST /api/publish` instead checks `b2_objects` for a row
  already published from the same image under the same opaque prefix and reports that in `skipped`
  (with its existing key/cdnUrl) rather than creating a duplicate object.
- **CDN URL shape (`lib/cdn.ts`, stage 4 — verified live against the real bucket, not assumed from
  `~/SourceRoot/vps/docs/image-cdn.md` alone)**: `img.jkrumm.com`'s Traefik layer runs an
  `imgproxy-short` `replacepathregex` middleware in front of imgproxy
  (`~/SourceRoot/vps/apps/imgproxy/compose.yml`) that rewrites a short public path into imgproxy's raw
  `/_/.../plain/img/<key>` form. `cdnOriginalUrl(key)` → `${CDN_BASE}/<key minus img/ prefix>` (no
  processing-options segment — confirmed live to serve the original bytes; this is what `publish.ts`
  already emitted pre-stage-4 and it was correct). `cdnThumbUrl(key, width)` →
  `${CDN_BASE}/rs:fit:<width>/<key minus img/ prefix>` (confirmed live to serve a resized rendition,
  longest side bounded to `width`).
- `GET /api/b2?prefix=all|fuji|blog|gen|misc&q&page&limit&sort=lastModified|key|size&order` → b2_objects
  `{ data: [{ ...row, mirrored, publishedImageId, cdnUrl, thumbUrl }], total, totalBytes,
  unmirroredCount, lastReconcileAt }` — `total` is filtered by `prefix`/`q`/paginated; `totalBytes`,
  `unmirroredCount`, and `lastReconcileAt` are always bucket-wide (ignore both filters) so the admin
  Public page's header strip reads consistently regardless of the active filter. `q` is a
  case-insensitive substring match against the object key (same ASCII-`LIKE` reasoning as the
  library `stem` filter above). `thumbUrl` uses a 480px width (matches the renditions 'thumb' size,
  design §6). `lastReconcileAt` comes from an in-memory status object in `cron/b2-reconcile.ts`
  (mirrors the indexer's status pattern, design §5) — not persisted, resets on restart.
- `POST /api/b2/upload` multipart `{ file, prefix: 'fuji'|'blog'|'gen'|'misc', subdir? }` → uploads
  straight to B2 under `img/<prefix>/<sanitized filename>`, or `img/<prefix>/<subdir>/<filename>` when
  `subdir` is given (never touches a local disk root), skips (does not overwrite) a pre-existing key,
  upserts b2_objects on success → `{ uploaded, key, cdnUrl, reason? }`. `subdir` (imgcli sync migration
  — preserves nested export directory structure instead of flattening into one dir) is validated
  strictly via `lib/naming.ts assertValidSubdir` since it becomes part of an object key: no
  leading/trailing slash, no empty/`.`/`..` segment, segment chars restricted to `[A-Za-z0-9._-]`, max
  8 segments, max 200 chars total — any violation is 400 before B2 is touched.
- `GET /api/b2/:key` — same params contract as `DELETE /api/b2/:key` (URL-encoded full key, one path
  segment, `B2_PREFIX` + traversal guard). Unlike `GET /api/b2` (reads the local mirror table), this
  reads the bucket live via `S3Port.head` → 404 if absent, then joins in b2_objects mirror fields
  (`mirrored`/`publishedImageId`/`firstSeenAt`, null/false when there's no mirror row) and `cdnUrl`.
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
| reindex | `15 5 * * *` + a background scan on boot when `bootScanReason` says so | full scan |
| b2-reconcile | `45 5 * * *` | S3 list → b2_objects |
| reverse-backup | `0 6 * * *` | mirror unmirrored keys + heartbeat |
| rendition-sweep | `30 4 * * 0` | age + size cap eviction |

`bootScanReason` (`cron/reindex.ts`) returns `'empty-index'` (first boot / rebuilt-from-scratch
cache) **or `'keyword-backfill'`** — the index has rows but at least one non-RAW row still carries
`keywords_indexed_at = NULL`. The second case is what a DEPLOY looks like: the migration adds
`image_keywords` empty and leaves ~6000 existing rows unbackfilled, and a boot check that only
counted rows found 6000 and did nothing, so the album tree stayed empty until 05:15 (§4). No
post-deploy step is required; `POST /api/index/rescan` (Activity → "Rescan now") remains the manual
lever. Null on a populated, fully-backfilled index — restarts must not re-read metadata for
thousands of files on a 4-core box.

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
  Volumes (as shipped, `~/SourceRoot/homelab/docker-compose.yml`): `/home/jkrumm/ssd/SSD/Bilder/Fuji:/photos/fuji:ro`,
  `/mnt/hdd/fuji/RAWs:/photos/raws:ro`, `/home/jkrumm/ssd/SSD/Bilder/ImageShare:/photos/share` (rw —
  service-owned, no `:ro`), `/home/jkrumm/ssd/SSD/Bilder/B2-Mirror:/photos/b2-mirror`,
  `/home/jkrumm/ssd/image-share:/data`, `/home/jkrumm/ssd/SSD/Dev/image-share:/backup`, `/etc/localtime:/etc/localtime:ro`.
  Env: `API_SECRET=${IMAGE_SHARE_API_SECRET}`, `FUJI_ROOT`/`RAWS_ROOT`/`SHARE_ROOT`/`B2_MIRROR_DIR`/`DATA_DIR`/`SNAPSHOT_DIR`
  set to the container paths above (must match the mounts — see env.ts, design §3), the B2 five-pack
  (`B2_ENDPOINT`/`B2_REGION`/`B2_BUCKET`/`B2_KEY_ID`/`B2_APP_KEY` — exact env var names env.ts reads;
  see the credential note below), `SHARE_BASE_URL=https://share.jkrumm.com`,
  `CDN_BASE=https://img.jkrumm.com`, `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty until ClickStack exists on homelab —
  homelab agent verifies; if no clickstack container there, leave unset), `TZ=Europe/Berlin`.
- **B2 credential note (scoped-key migration)**: `B2_KEY_ID`/`B2_APP_KEY` moved from the shared
  `op://common/b2-images-write` key to a dedicated, service-scoped key at
  `op://homelab/image-share/{B2_KEY_ID,B2_APP_KEY}` — capabilities `listFiles`/`readFiles`/`writeFiles`/`deleteFiles`,
  `namePrefix: img/`. This is what makes `DELETE /api/b2/:key` actually functional: the shared
  `b2-images-write` key lacked `deleteFiles`, so that route used to only 500 when it reached
  `S3Port.delete`. The scoped key deployed 2026-07-24 and the route is verified working in
  production. `B2_ENDPOINT`/`B2_REGION`/`B2_BUCKET` are non-secret bucket config, unaffected,
  and stay on the shared `op://common/backblaze-s3` refs.
- Caddyfile: single `share.jkrumm.com` site block — plain `reverse_proxy image-share:7720`
  handles for `/health`, `/api/*`, `/openapi*`, `/admin*`, `/s/*`, then a catch-all handle with
  `rewrite * /s{uri}` + `reverse_proxy` for the friend share slugs.
- `.env.tpl`: `IMAGE_SHARE_API_SECRET=op://homelab/image-share/API_SECRET`,
  `IMAGE_SHARE_B2_KEY_ID=op://homelab/image-share/B2_KEY_ID`,
  `IMAGE_SHARE_B2_APP_KEY=op://homelab/image-share/B2_APP_KEY`,
  `IMAGE_SHARE_B2_ENDPOINT`/`IMAGE_SHARE_B2_REGION`/`IMAGE_SHARE_B2_BUCKET=op://common/backblaze-s3/{ENDPOINT,REGION,BUCKET}`.
- Makefile: `image-share-deploy` (pull ~/image-share + build --no-cache + up -d), `-restart`, `-logs`.
- uptime-kuma monitors.yaml: Image Share subgroup — docker monitor + `https://share.jkrumm.com/health`
  (cloudflare_bypass).
- restic: NO changes (ImageShare/B2-Mirror land inside the Bilder source; live DB + renditions live
  outside all sources; snapshots land in the Dev source).
- Dockerfile: `oven/bun:1.3` (Debian, NOT alpine — perl + glibc sharp prebuilds), two-stage:
  builder installs workspaces + `vite build` admin; runner: `apt-get install -y curl perl libjemalloc2`,
  `ENV LD_PRELOAD=/usr/lib/<arch>/libjemalloc.so.2` (arch-detect at build), non-root user with access to
  mounted volumes (match host uid 1000), `CMD bun run apps/api/src/index.ts`, HEALTHCHECK like argo.
- DNS (deploy-time, /cloudflare skill): proxied CNAME `share` → `<TUNNEL_ID>.cfargotunnel.com`.
- **Rolling back past the album feature is one-way, and the DB does not roll back with the image.**
  Migrations are backward-tolerant (added tables/columns; an older binary ignores them), so nothing
  stops `make image-share-deploy` from rebuilding an older clone — but once an album share exists:
  - the PUBLIC surface fails **closed**, by construction: `shares.dir` carries
    `ALBUM_SHARE_LEGACY_DIR` (§4), so the old folder filter resolves an album share to zero images
    instead of the whole root. The friend's link goes empty, it does not go wide.
  - the ADMIN surface still breaks **loudly**: the old `ShareDto` validates
    `sourceType: z.enum(['folder','selection'])`, so `GET /api/shares` 500s and the shares page is
    dead until the newer image is back. A scan run by the old binary leaves fresh rows at
    `keywords_indexed_at = NULL`, which is harmless: rolling forward backfills them on boot (§9).
  So: roll back to recover the SERVICE, then roll forward. If an album share must keep working
  through a rollback, restore the nightly snapshot (§9 db-snapshot) alongside the older image and
  re-create it as a selection share.

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

Notifications go through `features/common/notify.ts` → **`notifyMutation`**, never basalt's
`notifyPromise`: the latter takes a static `error` ReactNode and never sees the rejection, so every
call site showed "Could not create share" and threw away what the server actually said ("slug
already in use", a 403 on a fuji delete). `notifyMutation` mirrors its show → update shape and its
history store, resolves the message from the thrown error, and re-throws so a local `.catch` still
runs.

- **Library** `/` — the album-first browse page (§3.1). URL state is one zod schema
  (`features/library/search-params.ts`: root, album | untagged | dir, recursive, minRating,
  captureFrom/captureTo, stem, page, sort, order) with every derivation from it pure and unit-tested
  — `toImagesParams`, `filterKeyOf`, `scopeLabel`, `scopeSourceOf`, `shareActionOf`.
  - Left rail `browse-panel.tsx`: root SegmentedControl (Fuji / Share / RAWs) → `album-tree.tsx`,
    the recursive keyword tree from `/api/library/albums` with "All images" and the `(untagged)`
    bucket as peers. The **dir tree is demoted behind a "Folders" disclosure** — three rows for the
    whole library is a fallback, not a hierarchy. Drawer instead of rail below `sm`.
  - `filter-bar.tsx`: filename (debounced into the URL via `stem-sync.ts`, `replace`d so a typed
    word costs one history entry), From/To + a date-preset menu (`date-presets.ts`),
    `MinRatingInput`, the recursive checkbox (its label tracks the album/dir axis), sort, order.
  - Grid `image-grid.tsx` (SimpleGrid + AspectRatio + `LibraryImage`, thumb via assetToken URL);
    a `kind='raw'` row renders an inert ".RAF · no preview" tile instead of requesting bytes the
    byte route answers 415 for. Lightbox = Modal fullScreen, med rendition, prev/next/keyboard, and
    it pages ACROSS page boundaries rather than dead-ending at image 60.
  - Selection survives filter changes and page turns (`selection.ts` holds whole rows, not ids):
    "Select all N matching" (walks every page), "Select page", "Select none", shift-click ranges, a
    stale-selection warning with "Keep only what matches", and a review modal
    (`selection-modal.tsx`) that shows exactly what would be shared. Actions: "Publish to CDN…",
    "Create share" (via `CreateShareModal`).
    `orderedSelection` sorts by **capture_at ascending only** — it deliberately does not take the
    toolbar's sort/order, which is a BROWSE preference and used to reach the friend's page (§7).
    The review modal therefore shows the delivered sequence, not the grid's.
    Selecting across `root='raws'` is possible (it is a browse axis), so the selection panel calls
    out any `kind='raw'` rows in it, offers "Remove the N RAF originals", and disables "Create
    share" until they are gone — `POST /api/shares` rejects them anyway (§8), but the operator
    should learn that from the page they selected on, not from a failed mutation.
  - Scope toolbar → ONE share button driven by `shareActionOf`: a live album/folder share when
    every active filter fits the share source, and otherwise ("Share these N images") a frozen
    selection share of exactly what matches, with a line saying why. A live scope carries only
    root + dir/album + recursive + minRating, so a capture-date or filename filter must never be
    silently dropped into a larger share — browsing `Ereignisse|Segeln 25` with a
    2026-07-04…2026-07-11 range reads "12 images" next to a button that used to mint all 550.
    **The rejected alternative was widening the schema** (capture bounds as live share properties,
    `shares.capture_from/capture_to` + predicate + admin editing + preview). It is defensible — "the
    Mallorca week from this album" is a real ask — but a live date-bounded share only differs from a
    frozen one while the index keeps changing under it, and the Fuji tree is imported in bursts and
    then static; a snapshot of a finished week is what the operator means. The snapshot also needs no
    new column, no new PATCH surface, and no second place for the preview count and the share to
    disagree. If a *rolling* window ("the last 30 days") is ever wanted, that is when the schema
    earns the change. **The snapshot mode is also what keeps the button alive on an axis that is not
    an album or a folder at all**: `Untagged` (~1794 of 2352 images, §3.1) and `All images` produce
    no scope source, and keying the button off one hid it entirely — including the snapshot that
    works there perfectly — on the axis §3.1 calls first-class. `unscopableAxis` names the axis as
    one more thing a live scope cannot carry, so the button stays and the line beneath it explains
    which of the two it is. `shareActionOf` is null for exactly ONE case: `root='raws'`, where every
    row is `kind='raw'` and POST /api/shares rejects it.
- **Public** `/public` (stage 4) — a browser for what actually lives on `img.jkrumm.com`, peer of
  Library. Header strip (StatCards): object count, total bytes, not-mirrored count, last reconcile
  time (all bucket-wide, from `GET /api/b2`'s aggregate fields) + Reconcile/Reverse-backup buttons
  (`notifyMutation`) — moved off Activity. An upload control (prefix `Select` + `FileButton multi` →
  `POST /api/b2/upload`, `notifyMutation` per file). A prefix filter (all/fuji/blog/gen/misc) + sort
  (lastModified/key/size) + order + pagination, mirroring the Library page's search-param + zod
  pattern. Thumbnail grid (SimpleGrid + AspectRatio + Image) loading `thumbUrl` **directly from
  img.jkrumm.com** — never proxied through this API. Per tile: size + last-modified, a "not mirrored"
  badge, a `CopyButton` for `cdnUrl`, and a delete action behind `modals.openConfirmModal` naming the
  key (`DELETE /api/b2/:key`). `EmptyState` when nothing is published yet.
- **Shares** `/shares` — admin-UX rework, stage 2: a pure navigation table (title, slug, source,
  image count, active-token count, created) whose rows link to the detail route; "New share" opens
  `CreateShareModal` in its picker mode (the only entry point without ambient album/folder/selection
  context). `create-share-modal.tsx` asks for title (autofocus, server-derived slug previewed
  client-side), an optional markdown note, and **who gets which link**: the role of the initial
  token (`view`/`download`/`full`) plus an optional second link with its own role and label — the
  usual case being view for the group and full for one person. It never re-asks for a source the
  caller already resolved. Picker mode adds an Album/Folder SegmentedControl (album first — the
  keyword tree is the axis with structure), a root Select, `AlbumPicker` or a dir TextInput, and the
  same `MinRatingInput` + include-sub-albums/subfolders controls the Library toolbar uses.
  `share-forms.ts` resolves ONE `ShareSourceInput` that both the count preview
  (`scope-preview.ts`) and the POST body use verbatim, so preview-equals-reality is structural.
  Submit is gated by `isCreateShareBlocked` (pure, unit-tested — the hook itself cannot be imported
  by a test, it pulls in the `window`-touching Eden client): blocked while the preview is stale, 0,
  **or still unknown**. That last case is the invariant's real edge — `total` is `undefined` for the
  whole time the request is in flight or retrying AND after the retries give up, so testing staleness
  alone left the button live behind the "Could not verify the image count" alert. A share is never
  minted against a scope the operator never saw a count for.
- **Shares detail** `/shares/:id` — header (inline-editable title, slug, source line), Links section
  (per-token role badge/label/URL/CopyButton/created date, revoke-with-confirm, a "show revoked" toggle,
  "Add link" via the adapted `add-token-modal.tsx`, "Roll all links" replacing every active token),
  Images section (thumbnail grid; selection shares get a per-tile remove action patching `imageIds`,
  folder/album shares are read-only), a collapsed Settings section (note/expiry, plus `MinRatingInput`
  and a recursive toggle on folder AND album shares — labelled "Include subfolders" /
  "Include sub-albums" — via PATCH), and a DangerZone delete action navigating back to `/shares`.
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
- **Admin (`bun test --cwd apps/admin`)**: `bun:test`, no DOM renderer and **no test dependency** —
  so anything worth asserting is extracted out of the component into a pure module and tested there.
  That constraint is the design pressure, not an excuse: `search-params.ts` (URL → query params,
  filter key, scope label, `shareActionOf`), `stem-sync.ts` (the debounced filename box's two-way
  URL binding, driven as a SEQUENCE — Back out of a filename filter must not re-apply it),
  `selection.ts`, `share-forms.ts`, `share-links.ts`, `token-role.ts`, `album-path.ts`,
  `date-presets.ts`, `renderable.ts`, `image-recovery.ts` (one asset-token re-mint per failure, then
  the placeholder), `format.ts`, the b2 page's own `search-params.ts`. `min-rating-input.test.ts` is
  a source-level guard: no component may render a bare Mantine `Rating`, because without
  `allowClear` (off by default, not themed by basalt-ui) a rating filter cannot be cleared.
  A module a test imports must not touch `window`/`import.meta.env` at load; `src/bun-test.d.ts`
  type-references bun-types' `test.d.ts` alone so Bun's globals never reach the browser program.
- `bun run check` = oxlint + oxfmt --check + tsc both apps + bun test (BOTH apps; root script;
  CI-less for now).

## 14. Out of scope v1 (per PRD)

Search/tags/timeline, video, photos.jkrumm.com takeover, Immich removal (separate, human-gated),
signed imgproxy URLs, analytics, friend uploads, multi-user.
