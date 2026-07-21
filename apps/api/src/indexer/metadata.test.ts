import { describe, expect, it } from 'bun:test'
import { parseFilenameDate } from './metadata.js'

// Pure unit tests for the filename capture-date fallback (design §5, §13).
describe('parseFilenameDate', () => {
  it('parses the YYYY-MM-DD_HH-MM-SS convention', () => {
    expect(parseFilenameDate('2026-07-21_14-30-05_foo.jpg')).toBe('2026-07-21T14:30:05')
  })

  it('parses the pattern with a space separator', () => {
    expect(parseFilenameDate('2026-07-21 14-30-05.RAF')).toBe('2026-07-21T14:30:05')
  })

  it('parses the pattern anywhere in the filename, not just the start', () => {
    expect(parseFilenameDate('IMG_2026-07-21_14-30-05.jpg')).toBe('2026-07-21T14:30:05')
  })

  it('returns null when no date pattern is present', () => {
    expect(parseFilenameDate('DSCF0001.RAF')).toBeNull()
    expect(parseFilenameDate('mallorca-sunset.jpg')).toBeNull()
  })

  it('returns null for an invalid calendar date (month 13)', () => {
    expect(parseFilenameDate('2026-13-21_14-30-05_foo.jpg')).toBeNull()
  })

  it('returns null for an invalid calendar date (day 32)', () => {
    expect(parseFilenameDate('2026-01-32_14-30-05_foo.jpg')).toBeNull()
  })
})
