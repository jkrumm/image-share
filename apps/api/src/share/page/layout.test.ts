import { describe, expect, it } from 'bun:test'
import { bentoSpanFor, computeBentoSpans } from './layout.js'

describe('bentoSpanFor', () => {
  it('spans landscape images 2 columns', () => {
    expect(bentoSpanFor({ width: 4000, height: 3000 }, 0)).toEqual({ colSpan: 2, rowSpan: 1 })
  })

  it('spans portrait images 2 rows', () => {
    expect(bentoSpanFor({ width: 3000, height: 4000 }, 0)).toEqual({ colSpan: 1, rowSpan: 2 })
  })

  it('spans square-ish images 1x1', () => {
    expect(bentoSpanFor({ width: 1000, height: 1000 }, 0)).toEqual({ colSpan: 1, rowSpan: 1 })
  })

  it('falls back to 1x1 when dimensions are unknown', () => {
    expect(bentoSpanFor({ width: null, height: null }, 0)).toEqual({ colSpan: 1, rowSpan: 1 })
    expect(bentoSpanFor({ width: 4000, height: null }, 0)).toEqual({ colSpan: 1, rowSpan: 1 })
  })

  it('makes every 7th item (index 6, 13, ...) a 2x2 tile regardless of aspect ratio', () => {
    expect(bentoSpanFor({ width: null, height: null }, 6)).toEqual({ colSpan: 2, rowSpan: 2 })
    expect(bentoSpanFor({ width: 3000, height: 4000 }, 13)).toEqual({ colSpan: 2, rowSpan: 2 })
    expect(bentoSpanFor({ width: 4000, height: 3000 }, 20)).toEqual({ colSpan: 2, rowSpan: 2 })
  })

  it('does not treat the 6th item (index 5) as a big tile', () => {
    expect(bentoSpanFor({ width: 4000, height: 3000 }, 5)).toEqual({ colSpan: 2, rowSpan: 1 })
  })

  it('clamps spans to the given column count', () => {
    expect(bentoSpanFor({ width: 4000, height: 3000 }, 6, 1)).toEqual({ colSpan: 1, rowSpan: 1 })
    expect(bentoSpanFor({ width: 4000, height: 3000 }, 0, 2)).toEqual({ colSpan: 2, rowSpan: 1 })
  })
})

describe('computeBentoSpans', () => {
  it('computes a span per image in order, mixing known and unknown dimensions', () => {
    const spans = computeBentoSpans([
      { width: 4000, height: 3000 }, // landscape
      { width: null, height: null }, // unknown -> 1x1
      { width: 3000, height: 4000 }, // portrait
    ])
    expect(spans).toEqual([
      { colSpan: 2, rowSpan: 1 },
      { colSpan: 1, rowSpan: 1 },
      { colSpan: 1, rowSpan: 2 },
    ])
  })

  it('returns an empty array for an empty share', () => {
    expect(computeBentoSpans([])).toEqual([])
  })
})
