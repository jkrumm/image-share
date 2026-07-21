import {
  trace,
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Attributes,
} from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import pkg from '../package.json' with { type: 'json' }
import { env } from './env.js'

// Base OTLP origin. Empty string (default in local dev / when no ClickStack
// exists yet on the HomeLab) means NO exporter is wired — spans/logs still get
// created against the global no-op provider, so the rest of the code is
// unconditional. Prod compose sets http://clickstack:4319.
const base = env.OTEL_EXPORTER_OTLP_ENDPOINT
const otelEnabled = base.length > 0

export const resource = resourceFromAttributes({
  'service.name': env.OTEL_SERVICE_NAME,
  'service.version': env.OTEL_SERVICE_VERSION || pkg.version,
  'deployment.environment': env.NODE_ENV,
})

// Passed to the @elysiajs/opentelemetry plugin (NodeSDK under the hood). With no
// processors the plugin instruments requests but drops the spans — a clean
// no-op that never reaches out to a missing collector.
export const telemetryConfig = {
  serviceName: env.OTEL_SERVICE_NAME,
  resource,
  spanProcessors: otelEnabled
    ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces` }))]
    : [],
}

// Logs — separate LoggerProvider registered globally so `logs.getLogger()`
// works. Only registered when an endpoint exists; otherwise the global default
// no-op provider is used and `log.*` still writes to the console.
if (otelEnabled) {
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${base}/v1/logs` }))],
  })
  logs.setGlobalLoggerProvider(loggerProvider)
}

export const tracer = trace.getTracer(env.OTEL_SERVICE_NAME, pkg.version)

const logger = logs.getLogger(env.OTEL_SERVICE_NAME, pkg.version)

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const severityMap: Record<LogLevel, { number: SeverityNumber; text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
}

function emit(level: LogLevel, body: string, attributes?: Attributes): void {
  const { number, text } = severityMap[level]
  logger.emit(
    attributes
      ? { severityNumber: number, severityText: text, body, attributes }
      : { severityNumber: number, severityText: text, body },
  )
}

/**
 * Structured logger that emits OTel log records (correlated with the active
 * trace via SDK context) AND writes to console for terminal visibility.
 * Prefer this over bare `console.*` in new code so logs show up in HyperDX.
 */
export const log = {
  debug(message: string, attributes?: Attributes): void {
    console.debug(message, attributes ?? '')
    emit('debug', message, attributes)
  },
  info(message: string, attributes?: Attributes): void {
    console.info(message, attributes ?? '')
    emit('info', message, attributes)
  },
  warn(message: string, attributes?: Attributes): void {
    console.warn(message, attributes ?? '')
    emit('warn', message, attributes)
  },
  error(message: string, err?: unknown, attributes?: Attributes): void {
    const errAttrs: Attributes =
      err instanceof Error
        ? {
            'exception.type': err.name,
            'exception.message': err.message,
            'exception.stacktrace': err.stack ?? '',
          }
        : err !== undefined
          ? { 'exception.message': String(err) }
          : {}
    console.error(message, err ?? '', attributes ?? '')
    emit('error', message, { ...errAttrs, ...attributes })
  },
}

/**
 * Wrap a cron tick in a fresh root span (design §9). Detaches from any ambient
 * context via ROOT_CONTEXT so each tick stands alone in the trace tree — croner
 * uses setTimeout, whose async context can otherwise chain ticks together.
 *
 * Naming convention: `cron.<job>.<flavor>` (e.g. `cron.reindex.scheduled`).
 */
export async function tracedTick(
  name: string,
  attributes: Record<string, string>,
  fn: () => Promise<unknown>,
): Promise<void> {
  await context.with(ROOT_CONTEXT, () =>
    tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
      try {
        await fn()
        span.setStatus({ code: SpanStatusCode.OK })
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
        throw err
      } finally {
        span.end()
      }
    }),
  )
}
