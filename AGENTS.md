# image-share

What it is, in one paragraph: `README.md`. This file holds the stack, commands and rules.

**Read `docs/design.md` before changing anything — it is the implementation contract.**
`PRD.md` holds intent; where they conflict, design.md wins (it resolves the PRD's inline notes).

## Stack

Bun workspaces monorepo, argo-patterned (`~/SourceRoot/argo` is the canonical reference):
- `apps/api` — Elysia 1.4 + Zod v4 + Drizzle (bun:sqlite) + @elysiajs/openapi + OTEL.
  sharp (renditions), exifr + exiftool-vendored (EXIF/XMP), client-zip (streaming ZIP),
  Bun.S3Client (B2). Serves the admin SPA statically. Share access is token-only, role-scoped
  (view/download/full) — no passwords.
- `apps/admin` — Vite 8 + React 19 + basalt-ui SPA (Eden Treaty typed on the api `App` export).
  basalt's enforcement toolchain lives in `apps/admin` (`.basalt/manifest.json`, a nested
  `.oxlintrc.json` extending the shipped preset, managed `AGENTS.md` block/`DESIGN.md`/`.claude/`).
  After a basalt bump run the LOCAL bin, never `bunx` — `bunx` serves a cached tarball and will
  happily report a passing scan from the previous version — and run it **from `apps/admin`**:
  `cd apps/admin && B=$PWD/node_modules/.bin/basalt-ui && $B doctor && $B sync && $B check-theme && $B check-theme --audit-allows`
  (`--version` must say what package.json pins). Since 1.29.0 the CLI has ONE resolver —
  `BASALT_CWD`, then cwd, plus a declared `basalt.roots` — and nothing is inferred from siblings
  or parents, so the same commands run from the repo root refuse (`doctor`/`sync`) or scan zero
  files (`check-theme`); that is why `lefthook.yml` hands the preset's root-run `check-theme` a
  `BASALT_CWD`. `check-coverage` was dropped in the same minor (repo-internal, not a consumer
  command). Head colors come from `basaltAppPlugin` in `vite.config.ts`, never a
  hex in `index.html`.
  Nav is one `defineNav` definition in `src/lib/nav.ts`, spread onto `BasaltShell` with `useNav` —
  never a hand-written sections array.

## Validate

- `bun run check` — lint (`oxlint` + basalt `check-theme`/`sync --check`) + `format:check` +
  typecheck both apps + both test suites. The gate before every commit; `make check` is the same
  command. CI (`.github/workflows/check.yml`) runs this on PRs and pushes to `master` and then
  additionally runs `bun run --cwd apps/admin build` — that extra step exists because
  `bun run check` once passed while the admin build was broken (missing basalt-ui peers).
- `bun test --cwd apps/api` — API tests (fixtures are generated; never touch real photo trees).
- `bun test --cwd apps/admin` — admin tests. `bun:test` only, no DOM renderer and no test
  dependency: pure logic is extracted into modules (`features/*/search-params.ts`,
  `selection.ts`, `share-forms.ts`, …) and tested there. A module a test imports must not
  touch `window`/`import.meta.env` at load. `src/bun-test.d.ts` type-references bun-types'
  `test.d.ts` alone, so Bun's globals never reach the browser program.
- `bun run --cwd apps/api db:generate` — drizzle migration after schema edits (commit `drizzle/`).
- `./scripts/dev.sh` — local dev (api :7720, admin :7721), local data under `.dev/`.

## Deploy

- **No CI or RollHook deploy.** `.github/workflows/check.yml` only validates on push to `master`.
  Deployment lives in `~/SourceRoot/homelab` (compose, Caddyfile, monitors, Makefile targets); the
  Dockerfile is owned here at `apps/api/Dockerfile` (build context = repo root). `make deploy`
  aliases the homelab target: `$(MAKE) -C ../homelab image-share-deploy` (ssh, `git pull`, rebuild
  the container from a sibling clone at `/home/jkrumm/image-share`).

## Verify & Monitor

- Health URL: `https://share.jkrumm.com/health` — Caddy routes `/health` straight to the API
  (`GET /health`, no DB). `make verify` curls it with `curl -fsS`; exit 0 means live and healthy.
- Uptime Kuma monitors (group `Image Share`): `Image Share - HTTP` and `Image Share - Docker`. The
  service also pings a Kuma push heartbeat at the end of a successful reverse-backup
  (`UPTIME_KUMA_PUSH_URL`).
- OTel `service.name`: `image-share` (`OTEL_SERVICE_NAME` default in `apps/api/src/env.ts`). An
  empty `OTEL_EXPORTER_OTLP_ENDPOINT` makes the exporters no-op (the live HomeLab compose leaves it
  empty).

## Gotchas

- Argo API conventions apply wholesale (see `.claude/rules/`): zod coercion for params,
  `detail` blocks on every route, `{ data, total }` pagination, throw-and-bubble errors.
- `FUJI_ROOT`/`RAWS_ROOT` are read-only — the service never writes or renames originals, and
  **never writes metadata into an image file** (Photomator/Lightroom own that; a second writer
  racing them over the same XMP packet loses metadata). `SHARE_ROOT` is the only read-write image
  root (agent ingest lands there, `root='share'`).
- **The browse axis is the album tree, not the directory tree** (design §3.1): the Fuji tree is ONE
  flat directory of 2365 JPEGs, so the hierarchy lives in `XMP-lr:HierarchicalSubject` — written by
  Lightroom on the Mac, READ into `image_keywords` here. Only ~24% of the library is tagged, so the
  `(untagged)` bucket and the capture-date range are first-class filters, not edge cases.
- Every filesystem access goes through `lib/paths.ts rootBaseDir`/`safeJoin` — no exceptions.
- Public share surface: single opaque 404 for every denial (no oracle between wrong/rolled/expired
  token, missing slug, an id outside the share, or a size/route the token's role doesn't permit).
