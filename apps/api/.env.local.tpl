# Local dev env for apps/api. Bare boot works on env.ts defaults (paths under
# .dev/, no secrets). Wrap with the secrets shim only when exercising B2:
#   secrets-run run --env-file=apps/api/.env.local.tpl -- ./scripts/dev.sh
#
# op:// refs follow homelab conventions (op://homelab/image-share/*,
# op://common/*). secrets-run resolves them; a bare `bun run` leaves them as
# literal strings, which is fine because the defaults below cover local boot.

NODE_ENV=development
PORT=7720

# Bearer secret for the /api surface. Prod: op://homelab/image-share/API_SECRET.
API_SECRET=dev-secret-change-me

# ── Filesystem roots (local .dev/ mirrors the prod container layout) ─────────
LIBRARY_ROOT=./.dev/library
RAWS_ROOT=./.dev/raws
UPLOADS_DIR=./.dev/uploads
B2_MIRROR_DIR=./.dev/b2-mirror
DATA_DIR=./.dev/data
SNAPSHOT_DIR=./.dev/backup
INDEX_EXCLUDE_DIRS=immich,Fotos-Mediathek.photoslibrary,Uploads,B2-Mirror

# ── Share + CDN ──────────────────────────────────────────────────────────────
SHARE_BASE_URL=http://localhost:7720/s
CDN_BASE=https://img.jkrumm.com

# ── Backblaze B2 (S3-compatible, via Bun.S3Client) ───────────────────────────
# Prod refs (homelab): op://common/backblaze-s3 (endpoint/region/bucket) +
# op://common/b2-images-write (key id / app key). Empty locally = publish and
# reconcile paths stay dormant.
B2_ENDPOINT=op://common/backblaze-s3/ENDPOINT
B2_REGION=op://common/backblaze-s3/REGION
B2_BUCKET=op://common/backblaze-s3/BUCKET
B2_KEY_ID=op://common/b2-images-write/B2_KEY_ID
B2_APP_KEY=op://common/b2-images-write/B2_APP_KEY
B2_PREFIX=img/

# ── Uptime Kuma push heartbeat (reverse-backup) ──────────────────────────────
# Prod: op://homelab/image-share/UPTIME_KUMA_PUSH_URL. Empty disables it.
UPTIME_KUMA_PUSH_URL=

# ── OpenTelemetry ────────────────────────────────────────────────────────────
# Empty = no-op exporters. Point at a local ClickStack :4319 if you run one.
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_SERVICE_NAME=image-share

# ── Cron + rendition knobs ───────────────────────────────────────────────────
CRON_ENABLED=true
RENDITION_MAX_AGE_DAYS=90
RENDITION_CACHE_MAX_GB=20
