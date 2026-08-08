// The capture-date presets behind the filter bar's `Dates ▾` menu. Pure, and
// parameterised on `today` so the boundaries can be asserted without waiting
// for a particular day to come round.

/**
 * `captureFrom`/`captureTo` are bare `YYYY-MM-DD` days (the API reads them as
 * whole UTC days). These are built from the LOCAL calendar so the presets agree
 * with what the native date input shows; the timezone offset can shift a photo
 * taken within an hour of midnight into the neighbouring day, which is the
 * right trade for a browse filter.
 */
export function isoDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function daysBefore(date: Date, days: number): Date {
  const shifted = new Date(date)
  shifted.setDate(shifted.getDate() - days)
  return shifted
}

export type CaptureRange = { captureFrom: string; captureTo: string }

export type DatePreset = {
  label: string
  /** `today` is injected rather than read from the clock so this stays pure. */
  range: (today: Date) => CaptureRange
}

export const DATE_PRESETS: DatePreset[] = [
  {
    label: 'Last 7 days',
    // Inclusive of today, so "last 7 days" spans 7 calendar days, not 8.
    range: (today) => ({ captureFrom: isoDay(daysBefore(today, 6)), captureTo: isoDay(today) }),
  },
  {
    label: 'Last 30 days',
    range: (today) => ({ captureFrom: isoDay(daysBefore(today, 29)), captureTo: isoDay(today) }),
  },
  {
    label: 'Last 90 days',
    range: (today) => ({ captureFrom: isoDay(daysBefore(today, 89)), captureTo: isoDay(today) }),
  },
  {
    label: 'This year',
    range: (today) => ({
      captureFrom: `${today.getFullYear()}-01-01`,
      captureTo: isoDay(today),
    }),
  },
  {
    label: 'Last year',
    range: (today) => {
      const year = today.getFullYear() - 1
      return { captureFrom: `${year}-01-01`, captureTo: `${year}-12-31` }
    },
  },
]
