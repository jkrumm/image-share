import { describe, expect, it } from 'bun:test'
import { assertValidSubdir, deriveObjectFilename, isOpaquePrefix } from './naming.js'

describe('isOpaquePrefix / deriveObjectFilename', () => {
  it('flags gen/misc as opaque, fuji/blog as readable', () => {
    expect(isOpaquePrefix('gen')).toBe(true)
    expect(isOpaquePrefix('misc')).toBe(true)
    expect(isOpaquePrefix('fuji')).toBe(false)
    expect(isOpaquePrefix('blog')).toBe(false)
  })

  it('keeps the original filename for a readable prefix', () => {
    expect(deriveObjectFilename('fuji', 'sunset.jpg')).toBe('sunset.jpg')
  })

  it('mints a random 16-char [a-z0-9] basename for an opaque prefix, preserving the extension', () => {
    const name = deriveObjectFilename('misc', 'secret-plan.png')
    expect(name).toMatch(/^[a-z0-9]{16}\.png$/)
    expect(name).not.toContain('secret')
  })
})

describe('assertValidSubdir', () => {
  it('accepts a plain multi-segment subdir', () => {
    expect(() => assertValidSubdir('2026/07/trip')).not.toThrow()
  })

  it('accepts a single segment with allowed punctuation', () => {
    expect(() => assertValidSubdir('a_b-c.d')).not.toThrow()
  })

  it('rejects a leading slash', () => {
    expect(() => assertValidSubdir('/2026/07')).toThrow()
  })

  it('rejects a trailing slash', () => {
    expect(() => assertValidSubdir('2026/07/')).toThrow()
  })

  it('rejects an empty segment', () => {
    expect(() => assertValidSubdir('a//b')).toThrow()
  })

  it('rejects a "." segment', () => {
    expect(() => assertValidSubdir('a/./b')).toThrow()
  })

  it('rejects a ".." segment', () => {
    expect(() => assertValidSubdir('a/../b')).toThrow()
  })

  it('rejects a character outside [A-Za-z0-9._-]', () => {
    expect(() => assertValidSubdir('a b')).toThrow()
    expect(() => assertValidSubdir('a/b*c')).toThrow()
  })

  it('rejects a total length over 200 chars', () => {
    expect(() => assertValidSubdir('a'.repeat(201))).toThrow()
  })

  it('rejects more than 8 segments', () => {
    expect(() => assertValidSubdir(Array.from({ length: 9 }, () => 'x').join('/'))).toThrow()
  })

  it('accepts exactly 8 segments', () => {
    expect(() => assertValidSubdir(Array.from({ length: 8 }, () => 'x').join('/'))).not.toThrow()
  })
})
