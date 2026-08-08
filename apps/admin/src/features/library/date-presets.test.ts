import { describe, expect, test } from 'bun:test'
import { DATE_PRESETS, daysBefore, isoDay } from './date-presets'

function preset(label: string) {
  const found = DATE_PRESETS.find((p) => p.label === label)
  if (!found) throw new Error(`no preset ${label}`)
  return found
}

// Dates are built from LOCAL components on purpose: `isoDay` reads the local
// calendar so the presets agree with what the native date input shows.
const AUG_8_2026 = new Date(2026, 7, 8)

describe('isoDay', () => {
  test('emits the bare YYYY-MM-DD day the API reads as a whole UTC day', () => {
    expect(isoDay(AUG_8_2026)).toBe('2026-08-08')
  })

  test('zero-pads single-digit months and days', () => {
    expect(isoDay(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(isoDay(new Date(2026, 8, 9))).toBe('2026-09-09')
  })

  test('reads the LOCAL calendar day, not the UTC one', () => {
    // Late local evening: `toISOString().slice(0,10)` would report tomorrow in
    // any timezone east of UTC, which is the bug this helper exists to avoid.
    const lateEvening = new Date(2026, 7, 8, 23, 30)
    expect(isoDay(lateEvening)).toBe('2026-08-08')
  })

  test('the time of day never leaks into the value', () => {
    expect(isoDay(new Date(2026, 7, 8, 0, 0))).toBe(isoDay(new Date(2026, 7, 8, 23, 59)))
  })
})

describe('daysBefore', () => {
  test('walks back across a month boundary', () => {
    expect(isoDay(daysBefore(new Date(2026, 0, 3), 6))).toBe('2025-12-28')
  })

  test('handles a leap day', () => {
    expect(isoDay(daysBefore(new Date(2024, 2, 1), 1))).toBe('2024-02-29')
    expect(isoDay(daysBefore(new Date(2025, 2, 1), 1))).toBe('2025-02-28')
  })

  test('does not mutate the date it is given', () => {
    const date = new Date(2026, 7, 8)
    daysBefore(date, 30)
    expect(isoDay(date)).toBe('2026-08-08')
  })

  test('zero days is the same day', () => {
    expect(isoDay(daysBefore(AUG_8_2026, 0))).toBe('2026-08-08')
  })
})

describe('DATE_PRESETS', () => {
  test('"Last 7 days" spans seven calendar days INCLUDING today, not eight', () => {
    expect(preset('Last 7 days').range(AUG_8_2026)).toEqual({
      captureFrom: '2026-08-02',
      captureTo: '2026-08-08',
    })
  })

  test('"Last 30 days" and "Last 90 days" are inclusive the same way', () => {
    expect(preset('Last 30 days').range(AUG_8_2026)).toEqual({
      captureFrom: '2026-07-10',
      captureTo: '2026-08-08',
    })
    expect(preset('Last 90 days').range(AUG_8_2026)).toEqual({
      captureFrom: '2026-05-11',
      captureTo: '2026-08-08',
    })
  })

  test('"This year" runs from 1 January to today, not to 31 December', () => {
    expect(preset('This year').range(AUG_8_2026)).toEqual({
      captureFrom: '2026-01-01',
      captureTo: '2026-08-08',
    })
  })

  test('"Last year" is the whole previous calendar year', () => {
    expect(preset('Last year').range(AUG_8_2026)).toEqual({
      captureFrom: '2025-01-01',
      captureTo: '2025-12-31',
    })
  })

  test('a rolling window crosses the new year correctly', () => {
    expect(preset('Last 7 days').range(new Date(2026, 0, 3))).toEqual({
      captureFrom: '2025-12-28',
      captureTo: '2026-01-03',
    })
  })

  test('every preset yields from <= to, on a leap year and off one', () => {
    for (const today of [AUG_8_2026, new Date(2024, 1, 29), new Date(2025, 0, 1)]) {
      for (const p of DATE_PRESETS) {
        const { captureFrom, captureTo } = p.range(today)
        expect(captureFrom <= captureTo).toBe(true)
      }
    }
  })

  test('every preset is a bare day, so the API reads it as a whole UTC day', () => {
    for (const p of DATE_PRESETS) {
      const { captureFrom, captureTo } = p.range(AUG_8_2026)
      expect(captureFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(captureTo).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  test('labels are unique — they are the React keys of the menu', () => {
    expect(new Set(DATE_PRESETS.map((p) => p.label)).size).toBe(DATE_PRESETS.length)
  })

  test('a preset is pure — the same day in gives the same range twice', () => {
    for (const p of DATE_PRESETS) {
      expect(p.range(AUG_8_2026)).toEqual(p.range(AUG_8_2026))
    }
  })
})
