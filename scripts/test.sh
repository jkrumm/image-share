#!/usr/bin/env bash
# Run the API test suite (design §13). Tests generate their own fixtures and use
# an in-memory / temp SQLite db — they never touch real photo trees, so no
# secrets and no external services are required.
#
# Invoked by `bun test` (repo root) or directly.

set -euo pipefail

cd "$(dirname "$0")/.."

# Isolate any incidental filesystem writes under a throwaway data root.
mkdir -p .dev/data/db .dev/data/renditions

# --isolate runs each test file in a fresh global object (bun 1.3+). Required
# because routes/{ingest,shares}.test.ts use process-global `mock.module` on
# '../db/index.js', which otherwise leaks a mocked db module into every other
# test file in the shared process (e.g. indexer/scan.test.ts).
exec bun test --cwd apps/api --isolate "$@"
