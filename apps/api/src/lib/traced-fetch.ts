import { context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { tracer } from '../telemetry.js'

/**
 * Fetch wrapper that creates an OTel CLIENT span for outgoing HTTP requests and
 * injects W3C traceparent so the downstream service can continue the trace. Use
 * for any external HTTP call from a route handler or a cron tick (e.g. the
 * Uptime Kuma heartbeat in the reverse-backup job).
 *
 * Drop-in replacement for `fetch` — same signature and return type.
 */
export async function tracedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')

  return tracer.startActiveSpan(
    `${method} ${url.hostname}${url.pathname}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': method,
        'url.full': url.href,
        'server.address': url.hostname,
        'url.scheme': url.protocol.replace(':', ''),
      },
    },
    async (span) => {
      try {
        const traceHeaders: Record<string, string> = {}
        propagation.inject(context.active(), traceHeaders)

        const mergedHeaders = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        )
        for (const [key, value] of Object.entries(traceHeaders)) {
          mergedHeaders.set(key, value)
        }

        const response = await fetch(input, { ...init, headers: mergedHeaders })
        span.setAttribute('http.response.status_code', response.status)
        if (response.status >= 400) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` })
        }
        return response
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
        span.recordException(error as Error)
        throw error
      } finally {
        span.end()
      }
    },
  )
}
