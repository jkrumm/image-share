# image-share — PRD

Personal OSS image service on the HomeLab: a thin layer over the existing photo
filesystem and the B2/imgproxy CDN. Replaces Immich's actual role (folder gallery +
friend sharing) and becomes the single ingest/serving/manamgent door for images across blogs,
the Obsidian vault, and agents. Deliberately modest — not a product, not
multi-tenant, not a photo editor.

## Problem

Photos live as folders on the HomeLab (Fuji exports under `Bilder/`, managed in
Photomator from the Mac), but every consumer has its own bolted-on path: Immich runs
a full ML/Postgres stack just to mirror folders and share albums with friends; the
static photo-gallery bakes images into each build; the Obsidian vault has no sanctioned
way to reference images; agents have no upload target. Meanwhile a public image CDN
(B2 `jkrumm` bucket  + img folder + imgproxy at `img.jkrumm.com`) now exists but has no
management layer. It is accessabel for agents with our recent work in dotfiles wiring up the Claude Code skill and the homelab modified traefik api. One small service can cover gallery, sharing, ingest, manamgenent and publish —
on top of the storage that already exists, without owning it.

## Goals

1. **Index in place, filesystem is truth.** Index the existing photo folder tree
   read-only (originals never moved or modified) plus a service-managed upload area.
   **File EXIF/XMP metadata is the source of truth** — ratings and metadata are
   written by Photomator on the Mac; the service reads them (capture date,
   orientation, rating) and never maintains competing metadata. The DB is a
   rebuildable index cache, nothing more.
2. **Friend folder sharing.** Share any folder as-is via slug + rollable token
   (`share.jkrumm.com/mallorca-2026?token=…`), with optional password and optional
   expiry. Tokens can be rolled per share to revoke access without changing the slug.
   Share pages render responsive grids/lightbox and offer streaming ZIP download of
   the folder. No friend-side uploads. So I can e.g. share All with link and token read jpeg medium size then to e.g. Laura full size jpeg AND RAWs together.
3. **Own transform layer for private images.** Renditions (thumbnails, share-page
   sizes) generated in-process with an established image library, cached on disk.
   Private pixels are served only through the service's authed/tokenized routes —
   they never transit the public CDN.
4. **Publish to the public CDN, per-action choice.** Two paths:
   - *Publish from library:* mark a file/folder public → copy to the B2 bucket →
     return the `img.jkrumm.com` rendition URL. HomeLab remains truth; B2 is a mirror.
   - *Direct-public upload:* API uploads destined for public land straight in B2
     (B2 is truth for these — covered by the reverse-backup requirement below). (Naaah strike this entirely I would expose public images over the B2+imgproxy on VPS and the HomeLab image-share over cloudflared from HomeLab and it gives shared folders access with valid folder+token for fuji jpeg+raw OR my bearer token for all the images)
5. **Ingest API for agents.** Bearer-token upload endpoint (private → upload area,
   public → B2) returning the canonical serving URL. This replaces the previously
   planned Argo `POST /images` endpoint and extends the dotfiles img claude skill and cli massively including unit tests etc.. Direct-to-B2 via S3 key remains a supported
   bypass from skill (photoflow, rclone); the service reconciles the bucket
   and filesystem by periodic re-index, so out-of-band uploads appear in the library.
6. **Retire Immich** once friend sharing reaches parity with current usage
   (folder mirror + shared albums).

## Non-goals

- Not shutterflow: no product ambitions, single-user by design, no tenant or
  multi-user abstractions.
- No app-level admin auth in v1 — admin UI/API are Tailscale-only (the tailnet is
  the auth), like the other private HomeLab services. Agents authenticate with a
  bearer token on the API. Share routes are the only public surface. (WRONG we made cloudfalred and bearer token)
- No search UI, tag browsing, or timeline view in v1 (the EXIF index they need is
  built in v1; the features come later). => we build all on folder path and image exif data except of sharing tokens ofcourse maybe with sqlite db which is backed up by existing restic or so same as the images itself
- No video in v1. No transcoding ever.
- No metadata writing to image files, no editing — Photomator owns that. The service
  organizes only what it owns (the upload area and sharing acesses); the indexed tree is read-only.
- No takeover of `photos.jkrumm.com` in v1 — the static gallery stays until it
  migrates into this service later; shares launch on `share.jkrumm.com`.
- imgproxy, the B2 bucket, and the CDN domain are existing infrastructure — consumed,
  not rebuilt.

## Technical Approach (high-level)

- **Runs on the HomeLab only** (Docker, joins the existing compose stack). Admin
  UI/API exposed cloudflared pattern; `share.jkrumm.com` exposed
  publicly via the existing cloudflared tunnel.
- Stack expectation: Elysia + Bun + Drizzle (SQLite) + basalt-ui, following argo's
  patterns especially for Elysia including telementry wiring. OpenAPI spec as the agent contract, matching the argo convention.
- **Indexer:** scans the configured roots (existing tree read-only + upload area),
  extracts EXIF/XMP (capture date, orientation, rating) into the SQLite cache;
  re-scan reconciles filesystem, B2 bucket, and index. The index must be fully
  rebuildable from files at any time.
- **Renditions:** on-demand generation with an on-disk cache keyed by
  file+params; cache is excluded from restic (rebuildable). Correct EXIF
  orientation handling is a hard requirement. (Do those caches time out after some days or so?)
- **Shares:** slug + token(s) with optional bcrypt'd password and expiry; tokens
  rollable without changing the slug. Share pages are server-rendered or a small
  public bundle — fast on mobile, no auth cookies.
- **Backup posture:** originals and upload area are covered by existing restic
  sources; DB + rendition cache excluded as rebuildable; a reverse-backup job
  (B2 → HomeLab pull) covers direct-public files whose only home is B2 — this job
  is part of v1's definition of done, per the append-only-key safety model.
- Research current library/API versions before implementation (sharp-on-Bun
  compatibility, EXIF/XMP parsing library choice, streaming ZIP) — per the
  research-first rule, no version assumptions from memory. (Also take a look at how my photo-flow projects works today we will move the photo-gallery highrated images though to be directly synced to B2+imagproxy live stack soon not to this project directly)

## Success Criteria

1. A friend opens `share.jkrumm.com/<slug>?token=…` on a phone: grid loads fast,
   lightbox works, ZIP download streams; wrong/rolled token or expired share is
   cleanly denied.
2. Photomator edits on the Mac (e.g. a rating change on a Fuji export) appear in the
   service after re-index without any manual metadata entry; galleries sort by
   capture date; rating filter works.
3. An agent uploads via the API with a bearer token and receives a working
   `img.jkrumm.com` URL (public path) or a private library location (private path).
4. Publishing a library folder to B2 yields imgproxy URLs; the originals remain on
   the HomeLab; `restic` + the reverse-backup job together cover every image the
   service knows about.
5. Out-of-band B2 uploads (photoflow/rclone/Obsidian S3 plugin) show up in the
   library after reconciliation.
6. Immich is shut down; nothing of daily value is lost.
7. Deployed via the homelab repo conventions (compose, Caddy, cloudflared,
   uptime-kuma monitor, docs) — visible in Glance/UptimeKuma like any other service.

## Later (explicitly deferred)

Search/tags/timeline UI · video files · photo-gallery migration +
`photos.jkrumm.com` takeover · Obsidian/photoflow moving from direct-B2 to the API ·
signed imgproxy URLs for sensitive public prefixes · share-link analytics · image-gen project writes to the project directly or always syncs everything to the server
