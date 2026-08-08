// Shared formatting helpers for the admin SPA. Every user-facing number, byte
// count and timestamp goes through here — pages never call `Intl` or
// `toLocaleString` directly, so the locale is one constant, not a grep.

/**
 * Single-user admin, German operator: dates read `08.08.2026`, times are 24h.
 * Change here and every surface follows.
 */
export const LOCALE = 'de-DE'

/** Rendered in place of a null/absent/invalid value. */
export const EMPTY_VALUE = '—'

export type DateInput = string | number | Date | null | undefined

// Intl constructors are expensive; build each formatter once at module load.
const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const relativeFormatter = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })

const numberFormatter = new Intl.NumberFormat(LOCALE)

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return EMPTY_VALUE
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** Thousands-separated integer — `2365` → `2.365`. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_VALUE
  return numberFormatter.format(value)
}

/**
 * Normalises anything the API hands back (ISO string, epoch ms, Date) into a
 * Date, or null when the value is absent or unparseable. Exported so callers
 * that need to compare/sort dates don't re-implement the guard.
 */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** `08.08.2026` */
export function formatDate(value: DateInput, fallback = EMPTY_VALUE): string {
  const date = toDate(value)
  return date ? dateFormatter.format(date) : fallback
}

/** `08.08.2026, 08:54` */
export function formatDateTime(value: DateInput, fallback = EMPTY_VALUE): string {
  const date = toDate(value)
  return date ? dateTimeFormatter.format(date) : fallback
}

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
]

/**
 * `vor 3 Stunden` / `in 2 Tagen` / `jetzt`. Works for past and future, so it
 * covers both `createdAt` and a token's `expiresAt`.
 */
export function formatRelative(value: DateInput, fallback = EMPTY_VALUE): string {
  const date = toDate(value)
  if (!date) return fallback
  const seconds = (date.getTime() - Date.now()) / 1000
  const magnitude = Math.abs(seconds)
  if (magnitude < 45) return relativeFormatter.format(0, 'second')
  for (const [unit, size] of RELATIVE_UNITS) {
    if (magnitude >= size) return relativeFormatter.format(Math.round(seconds / size), unit)
  }
  return relativeFormatter.format(Math.round(seconds), 'second')
}

/**
 * `08.08.2026 – 12.08.2026`, collapsed to a single date when both ends land on
 * the same day and to the one known end when the other is null. Built for the
 * album/dir capture ranges (`minCaptureAt` / `maxCaptureAt`).
 */
export function formatDateRange(from: DateInput, to: DateInput, fallback = EMPTY_VALUE): string {
  const start = toDate(from)
  const end = toDate(to)
  if (!start || !end) {
    const single = start ?? end
    return single ? dateFormatter.format(single) : fallback
  }
  const left = dateFormatter.format(start)
  const right = dateFormatter.format(end)
  return left === right ? left : `${left} – ${right}`
}
