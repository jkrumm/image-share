import { describe, expect, test } from 'bun:test'
import type { ImageKind } from '../../lib/queries/library'
import { hasRendition } from './renderable'

describe('hasRendition', () => {
  // The regression: the raws root is a first-class browse segment, and the grid
  // requested `?size=thumb` for all 60 RAF tiles on a page — every one of them a
  // 415 (previously an unhandled 500) plus a logged error and a trace span, on a
  // 1 GB container.
  test('a RAF row has none — renditions only ever come from the paired JPEG', () => {
    expect(hasRendition({ kind: 'raw' })).toBe(false)
  })

  test.each<ImageKind>(['jpeg', 'image'])('a %s row does', (kind) => {
    expect(hasRendition({ kind })).toBe(true)
  })
})
