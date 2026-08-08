# image-share

Personal image service on the HomeLab: a read-only index over the existing photo
tree, friend sharing via slug + role-scoped rollable token (`share.jkrumm.com`),
on-demand renditions, a bearer-token ingest API for agents, and publish-to-B2
(`img.jkrumm.com` CDN). Single user, filesystem is truth, the DB is a rebuildable
cache (except `shares`/`share_tokens`, which are snapshotted nightly).

## Browsing

The photo tree is one flat directory, so directories are not the browse axis. The
hierarchy is the **album tree** Lightroom already wrote into the JPEGs
(`XMP-lr:HierarchicalSubject`, e.g. `Ereignisse|Segeln 25`), which the indexer reads
into `image_keywords` — this service never writes metadata back into an image file.
Only a minority of the library is tagged, so **untagged** and the **capture-date
range** are peer filters, not fallbacks. A share can be a folder, an album, or a
hand-picked selection; folder and album shares are live-filtered and scoped to one
root. See `docs/design.md` §3.1.

Bun workspaces monorepo, argo-patterned (Elysia + Zod v4 + Drizzle/bun:sqlite +
OpenAPI + OTEL for `apps/api`; Vite + React 19 + basalt-ui for `apps/admin`).

## Commands

- `bun run check` — lint + format check + typecheck + tests
- `bun test --cwd apps/api` — API tests (fixtures are generated; never touches real photo trees)
- `bun run --cwd apps/api db:generate` — regenerate drizzle migrations after a schema edit (commit `drizzle/`)
- `./scripts/dev.sh` — local dev (api `:7720`, admin `:7721`); local data roots live under `.dev/`

## Docs

**`docs/design.md` is the implementation contract — read it before changing anything.**
`PRD.md` holds intent; where they conflict, design.md wins.
