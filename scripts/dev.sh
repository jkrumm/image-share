#!/usr/bin/env bash
# Local dev entry (design §3, §10). Local data roots live under .dev/ so the
# service never touches real photo trees. Runs the API (+ admin SPA if present)
# concurrently. Invoked by `bun dev`.
#
# Secrets: for real B2/publish work, wrap with the secrets shim:
#   secrets-run run --env-file=apps/api/.env.local.tpl -- ./scripts/dev.sh
# Bare `./scripts/dev.sh` boots on env.ts defaults (no secrets needed).

set -euo pipefail

cd "$(dirname "$0")/.."

# Create the local data roots the env defaults point at.
mkdir -p .dev/library .dev/raws .dev/uploads .dev/b2-mirror .dev/data/db .dev/data/renditions .dev/backup

# Free the ports so re-runs don't leave a zombie / trip --strictPort.
npx --yes kill-port 7720 7721 >/dev/null 2>&1 || true

if [ -d apps/admin ]; then
  exec ./node_modules/.bin/concurrently \
    --names api,web \
    --prefix-colors blue,magenta \
    "bun run --cwd apps/api dev" \
    "bun run --cwd apps/admin dev"
else
  echo "apps/admin not present yet — running api only"
  exec bun run --cwd apps/api dev
fi
