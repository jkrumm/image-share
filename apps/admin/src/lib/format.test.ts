import { describe, expect, test } from 'bun:test'
import {
  EMPTY_VALUE,
  formatBytes,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatNumber,
  formatRelative,
  LOCALE,
  toDate,
} from './format'

// These assert the de-DE output verbatim: the locale is a product decision
// (single German operator, design §12), so a silent switch to en-US — the
// default when a formatter is constructed without a locale — must fail here.
//
// Every Date is built from LOCAL components so the expectations hold in any
// timezone; the formatters render local time.

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024
const TB = GB * 1024

describe('LOCALE', () => {
  test('is German — every surface follows this one constant', () => {
    expect(LOCALE).toBe('de-DE')
  })
})

describe('formatBytes', () => {
  test.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [KB, '1.0 KB'],
    [1536, '1.5 KB'],
    [MB, '1.0 MB'],
    [8 * MB + 400 * KB, '8.4 MB'],
    [GB, '1.0 GB'],
    [TB, '1.0 TB'],
  ])('%i B → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  test('stops at TB rather than inventing a unit', () => {
    expect(formatBytes(1024 * TB)).toBe('1024.0 TB')
  })

  test('the B→KB switch happens at exactly 1024', () => {
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
  })

  test('non-finite sizes render as the empty marker, not "NaN B"', () => {
    expect(formatBytes(Number.NaN)).toBe(EMPTY_VALUE)
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(EMPTY_VALUE)
  })
})

describe('formatNumber', () => {
  test.each([
    [0, '0'],
    [999, '999'],
    [2365, '2.365'],
    [1_234_567, '1.234.567'],
    [-42, '-42'],
  ])('%i → %s', (value, expected) => {
    expect(formatNumber(value)).toBe(expected)
  })

  test('uses a dot as the thousands separator, not a comma', () => {
    expect(formatNumber(2365)).not.toContain(',')
  })

  test.each([[null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    '%p renders as the empty marker',
    (value) => {
      expect(formatNumber(value)).toBe(EMPTY_VALUE)
    },
  )
})

describe('toDate', () => {
  test.each([[null], [undefined], ['']])('%p is absent, not epoch 0', (value) => {
    expect(toDate(value)).toBeNull()
  })

  test('an unparseable string is null rather than an Invalid Date', () => {
    expect(toDate('not a date')).toBeNull()
    expect(toDate('2026-13-45')).toBeNull()
  })

  test('accepts an ISO string, epoch millis and a Date', () => {
    const date = new Date(2026, 7, 8, 12, 0)
    expect(toDate(date.toISOString())?.getTime()).toBe(date.getTime())
    expect(toDate(date.getTime())?.getTime()).toBe(date.getTime())
    expect(toDate(date)).toBe(date)
  })

  test('epoch 0 is a real instant, not "absent"', () => {
    expect(toDate(0)?.getTime()).toBe(0)
  })
})

describe('formatDate', () => {
  test('renders day-first with a zero-padded two-digit day and month', () => {
    expect(formatDate(new Date(2026, 7, 8))).toBe('08.08.2026')
    expect(formatDate(new Date(2026, 11, 31))).toBe('31.12.2026')
  })

  test('reads an ISO string the same as the Date it came from', () => {
    expect(formatDate(new Date(2026, 7, 8, 12, 0).toISOString())).toBe('08.08.2026')
  })

  test('falls back for absent and unparseable values', () => {
    expect(formatDate(null)).toBe(EMPTY_VALUE)
    expect(formatDate(undefined)).toBe(EMPTY_VALUE)
    expect(formatDate('nope')).toBe(EMPTY_VALUE)
    expect(formatDate(null, 'never')).toBe('never')
  })
})

describe('formatDateTime', () => {
  test('appends a 24h time, so 20:05 is not "8:05 PM"', () => {
    expect(formatDateTime(new Date(2026, 7, 8, 20, 5))).toBe('08.08.2026, 20:05')
  })

  test('zero-pads the hour', () => {
    expect(formatDateTime(new Date(2026, 7, 8, 8, 54))).toBe('08.08.2026, 08:54')
  })

  test('midnight renders as 00:00, not 24:00', () => {
    expect(formatDateTime(new Date(2026, 7, 8, 0, 0))).toBe('08.08.2026, 00:00')
  })

  test('falls back for absent values', () => {
    expect(formatDateTime(null)).toBe(EMPTY_VALUE)
    expect(formatDateTime('', 'never indexed')).toBe('never indexed')
  })
})

// `formatRelative` re-reads `Date.now()` internally, so every offset below keeps
// a margin off the unit boundaries — a value sitting exactly on one lands on
// either side depending on how long the test took to reach the call.
const seconds = (n: number) => new Date(Date.now() + n * 1000)
const MINUTE = 60
const HOUR = 3600
const DAY = 86_400
const WEEK = 604_800
const MONTH = 2_592_000
const YEAR = 31_536_000

describe('formatRelative', () => {
  test('anything inside 45 seconds either way is "jetzt"', () => {
    expect(formatRelative(seconds(0))).toBe('jetzt')
    expect(formatRelative(seconds(-40))).toBe('jetzt')
    expect(formatRelative(seconds(40))).toBe('jetzt')
  })

  test('45–59 s falls through every unit and reads in seconds', () => {
    // The `< 45` guard opens the door before the `minute` bucket can claim it,
    // so this window is the one place a second-granularity string is produced.
    expect(formatRelative(seconds(-50))).toBe('vor 50 Sekunden')
    expect(formatRelative(seconds(50))).toBe('in 50 Sekunden')
  })

  test.each([
    [-2 * MINUTE, 'vor 2 Minuten'],
    [-3 * HOUR, 'vor 3 Stunden'],
    [-3 * DAY, 'vor 3 Tagen'],
    [-3 * WEEK, 'vor 3 Wochen'],
    [-5 * MONTH, 'vor 5 Monaten'],
    [-2 * YEAR, 'vor 2 Jahren'],
  ])('%i s in the past reads %s', (offset, expected) => {
    expect(formatRelative(seconds(offset))).toBe(expected)
  })

  test('works for the future too, which is what token expiry needs', () => {
    expect(formatRelative(seconds(3 * HOUR))).toBe('in 3 Stunden')
    expect(formatRelative(seconds(3 * DAY))).toBe('in 3 Tagen')
  })

  test("numeric:'auto' gives the idiomatic word for ±1 day", () => {
    expect(formatRelative(seconds(-DAY - HOUR))).toBe('gestern')
    expect(formatRelative(seconds(DAY + HOUR))).toBe('morgen')
  })

  test('falls back for absent values', () => {
    expect(formatRelative(null)).toBe(EMPTY_VALUE)
    expect(formatRelative(undefined, 'never')).toBe('never')
  })
})

describe('formatDateRange', () => {
  test('renders both ends separated by an en dash', () => {
    expect(formatDateRange(new Date(2026, 7, 8), new Date(2026, 7, 12))).toBe(
      '08.08.2026 – 12.08.2026',
    )
  })

  test('collapses to one date when both ends land on the same day', () => {
    expect(formatDateRange(new Date(2026, 7, 8, 6, 0), new Date(2026, 7, 8, 22, 0))).toBe(
      '08.08.2026',
    )
  })

  test('shows the one known end when the other is absent', () => {
    expect(formatDateRange(new Date(2026, 7, 8), null)).toBe('08.08.2026')
    expect(formatDateRange(null, new Date(2026, 7, 8))).toBe('08.08.2026')
  })

  test('an album with no dated images falls back', () => {
    expect(formatDateRange(null, null)).toBe(EMPTY_VALUE)
    expect(formatDateRange(null, null, 'no dates')).toBe('no dates')
  })

  test('a reversed range is rendered as given, not silently swapped', () => {
    expect(formatDateRange(new Date(2026, 7, 12), new Date(2026, 7, 8))).toBe(
      '12.08.2026 – 08.08.2026',
    )
  })
})
