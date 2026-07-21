---
paths:
  - apps/api/**
---

# Observability (apps/api)

OpenTelemetry traces + logs ship to **ClickStack** (HyperDX) when configured.
The Elysia OpenTelemetry plugin wires NodeSDK internally; we layer manual
instrumentation on top.

| Environment | `OTEL_EXPORTER_OTLP_ENDPOINT`                        | Behaviour                       |
| ----------- | ---------------------------------------------------- | ------------------------------- |
| Local dev   | unset / empty                                        | **no-op exporters** (see guard) |
| Prod        | `http://clickstack:4319` (once it exists on HomeLab) | traces + logs exported          |

## The no-op guard (design §10)

`src/telemetry.ts` reads `OTEL_EXPORTER_OTLP_ENDPOINT`. When it is empty:

- `telemetryConfig.spanProcessors` is `[]` — the plugin still instruments
  requests but the spans go nowhere (no reach-out to a missing collector).
- No `LoggerProvider` is registered — `log.*` still writes to the console.

So the API boots and runs identically with or without a collector. Never remove
this guard; prod simply sets the endpoint.

The endpoint must be the **base origin only** — the exporter appends
`/v1/traces` and `/v1/logs`. If you see `/v1/traces/v1/traces`, that's the bug.

## Files

| File                      | Role                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `src/telemetry.ts`        | `telemetryConfig`, `tracer`, `log`, and `tracedTick` (cron root spans). |
| `src/lib/traced-fetch.ts` | Drop-in `fetch` — CLIENT span + W3C `traceparent` injection.            |
| `src/index.ts`            | Mounts `opentelemetry(...)` first, then `onError`, then `cors`.         |

## No DB spans in v1 (design §2)

We deliberately do **not** wrap the Drizzle/bun:sqlite client with
`@kubiks/otel-drizzle` — it's Postgres-oriented and sqlite support isn't worth
fighting. SQLite queries are in-process and fast; skip DB spans rather than
add a shaky dependency. Do not add manual spans around every query.

## Plugin order in `src/index.ts`

`opentelemetry(...)` → `onError` (records exceptions on the active span) →
`cors(...)` (must allow `traceparent`, `tracestate`, `baggage`) → `openapi` →
public routes → `/api` group → static.

`checkIfShouldTrace` skips `/`, `/health`, `/api` (discovery), and `/openapi*` —
frequently polled, pure noise. Extend it when adding a public probe route.

## Outgoing HTTP — always `tracedFetch`

Never call bare `fetch` server-side. Use `tracedFetch` from
`src/lib/traced-fetch.ts` (e.g. the Uptime Kuma heartbeat in the reverse-backup
job) — CLIENT span + `traceparent` injection + 4xx/5xx marked as errors.

## Cron jobs — ROOT_CONTEXT + named span

Every cron tick wraps in `tracedTick(name, attrs, fn)` from `telemetry.ts`,
which uses `context.with(ROOT_CONTEXT, …)` so ticks don't chain into one trace.
Naming: `cron.<job>.<flavor>` (e.g. `cron.reindex.scheduled`).

## Structured logging

Use the `log` helper (`log.info/warn/error`) — emits OTel log records correlated
with the active span AND writes to console. `log.error(msg, err)` auto-attaches
`exception.*`. Prefer it over bare `console.*` in new code.

## What NOT to do

- ❌ Bare `fetch(...)` server-side — always `tracedFetch`.
- ❌ Removing the empty-endpoint guard in `telemetry.ts`.
- ❌ `OTEL_EXPORTER_OTLP_ENDPOINT=http://host/v1/traces` — the SDK appends the path.
- ❌ Dropping `traceparent`/`tracestate`/`baggage` from `cors.allowedHeaders`.
- ❌ `tracer.startActiveSpan` in a cron without `context.with(ROOT_CONTEXT, …)`.
- ❌ `@opentelemetry/instrumentation-fs` under Bun — hangs the runtime.
