import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { safeJoin } from './paths.js'

const ROOT = '/photos/library'

describe('safeJoin', () => {
  it('joins a normal relative path inside the root', () => {
    expect(safeJoin(ROOT, 'mallorca-2026/DSCF0001.JPG')).toBe(
      resolve(ROOT, 'mallorca-2026/DSCF0001.JPG'),
    )
  })

  it('returns the root itself for an empty relative path', () => {
    expect(safeJoin(ROOT, '')).toBe(resolve(ROOT))
  })

  it('rejects parent-directory traversal', () => {
    expect(() => safeJoin(ROOT, '../secrets/id_rsa')).toThrow()
    expect(() => safeJoin(ROOT, 'a/../../etc/passwd')).toThrow()
  })

  it('rejects an absolute path that escapes the root', () => {
    expect(() => safeJoin(ROOT, '/etc/passwd')).toThrow()
  })

  it('rejects a sibling directory sharing the root as a name prefix', () => {
    // /photos/library-evil must NOT pass as a child of /photos/library.
    expect(() => safeJoin(ROOT, '../library-evil/x.jpg')).toThrow()
  })

  it('allows a nested path that normalizes back inside the root', () => {
    expect(safeJoin(ROOT, 'a/b/../c/x.jpg')).toBe(resolve(ROOT, 'a/c/x.jpg'))
  })
})
