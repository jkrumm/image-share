# image-share

Personal image service on the HomeLab: read-only index of the Fuji photo tree (`fuji`/`raws`
roots) plus a service-owned ingest area (`share` root), friend sharing via slug+role-scoped
token (`share.jkrumm.com`), on-demand renditions, bearer-token ingest API for agents, publish-to-B2
(`img.jkrumm.com` CDN). Single user, filesystem is truth, DB is a rebuildable cache (except
shares/share_images/tokens → nightly snapshot).

**Read `docs/design.md` before changing anything — it is the implementation contract.**
`PRD.md` holds intent; where they conflict, design.md wins (it resolves the PRD's inline notes).

## Stack

Bun workspaces monorepo, argo-patterned (`~/SourceRoot/argo` is the canonical reference):
- `apps/api` — Elysia 1.4 + Zod v4 + Drizzle (bun:sqlite) + @elysiajs/openapi + OTEL.
  sharp (renditions), exifr + exiftool-vendored (EXIF/XMP), client-zip (streaming ZIP),
  Bun.S3Client (B2). Serves the admin SPA statically. Share access is token-only, role-scoped
  (view/download/full) — no passwords.
- `apps/admin` — Vite 8 + React 19 + basalt-ui SPA (Eden Treaty typed on the api `App` export).

## Commands

- `bun run check` — oxlint + format check + typecheck both apps + tests (run before commit)
- `bun test --cwd apps/api` — API tests (fixtures are generated; never touch real photo trees)
- `bun run --cwd apps/api db:generate` — drizzle migration after schema edits (commit `drizzle/`)
- `./scripts/dev.sh` — local dev (api :7720, admin :7721), local data under `.dev/`

## Rules

- Argo API conventions apply wholesale (see `.claude/rules/`): zod coercion for params,
  `detail` blocks on every route, `{ data, total }` pagination, throw-and-bubble errors.
- `FUJI_ROOT`/`RAWS_ROOT` are read-only — the service never writes or renames originals,
  never writes metadata to image files (Photomator owns that). `SHARE_ROOT` is the only
  read-write image root (agent ingest lands there, `root='share'`).
- Every filesystem access goes through `lib/paths.ts rootBaseDir`/`safeJoin` — no exceptions.
- Public share surface: single opaque 404 for every denial (no oracle between wrong/rolled/expired
  token, missing slug, an id outside the share, or a size/route the token's role doesn't permit).
- Deployment lives in `~/SourceRoot/homelab` (compose, Caddyfile, monitors); Dockerfile here.
