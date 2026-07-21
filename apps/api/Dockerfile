# image-share container (design §11). Build context is the REPO ROOT
# (build: { context: ., dockerfile: apps/api/Dockerfile }). Debian base — NOT
# alpine — because sharp's prebuilt binaries need glibc and exiftool-vendored
# needs perl.

# ── Builder: install workspaces + build the admin SPA ────────────────────────
FROM oven/bun:1.3 AS builder
WORKDIR /app

# Manifests first for layer caching. The admin manifest is optional at this
# stage of the project — the wildcard tolerates its absence.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.jso[n] ./apps/admin/

RUN bun install --frozen-lockfile

# Sources.
COPY apps/api ./apps/api
COPY apps/admi[n] ./apps/admin

# Build the admin SPA if it exists; always leave a dist/ dir so the runner COPY
# below is unconditional (guarded per the scaffold contract).
RUN mkdir -p apps/admin/dist \
  && if [ -f apps/admin/package.json ]; then bun run --cwd apps/admin build; \
     else echo "apps/admin absent — serving no SPA"; fi

# ── Runner ───────────────────────────────────────────────────────────────────
FROM oven/bun:1.3 AS runner
WORKDIR /app

# curl: healthcheck. perl: exiftool-vendored. libjemalloc2: sharp memory
# behaviour under long-running processes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl perl libjemalloc2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Preload jemalloc to tame sharp's long-run RSS. Symlinked to an
# arch-independent path so the ENV below works on any target arch
# (glibc ignores a missing LD_PRELOAD target, so worst case is no jemalloc).
RUN ln -s "$(find /usr/lib -name 'libjemalloc.so.2' | head -n1)" /usr/local/lib/libjemalloc.so.2

# Match host uid 1000 so the process can read/write the bind-mounted volumes
# (design §11). The base image already ships a `bun` user at uid 1000.
COPY --from=builder --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=builder --chown=bun:bun /app/apps/api /app/apps/api
COPY --from=builder --chown=bun:bun /app/apps/admin/dist /app/apps/admin/dist
COPY --from=builder --chown=bun:bun /app/package.json /app/package.json

ENV NODE_ENV=production
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
EXPOSE 7720

USER bun

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:7720/health || exit 1

CMD ["bun", "run", "apps/api/src/index.ts"]
