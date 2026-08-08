import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDb, runMigrations, type Db } from '../db/index.js'
import { imageKeywords, images } from '../db/schema.js'
import { albumAtOrBelow } from './album-scope.js'

// Boundary tests run against a real in-memory SQLite (design §13) rather than
// asserting on generated SQL — the whole point of the range form is how SQLite
// itself compares the strings, which a string assertion would not prove.
let testDb: Db

// path → the fixture image's stem, so an assertion reads as "which photos does
// this album scope contain".
const FIXTURES: Array<[path: string, stem: string]> = [
  ['Ereignisse', 'root-album'],
  ['Ereignisse|Segeln 25', 'sailing'],
  ['Ereignisse|Segeln 25|Tag 1', 'sailing-day-1'],
  ['Ereignisse|Segeln 2', 'sailing-shorter'], // prefix of 'Segeln 25'
  ['Ereignisse|Segeln 250', 'sailing-longer'], // 'Segeln 25' is a prefix of THIS
  ['Ereignissen', 'not-a-child'], // 'Ereignisse' is a prefix of this too
  ['ereignisse|Segeln 25', 'case-variant'], // case-variant sibling album
  ['Insta Post Marokko', 'morocco'], // unrelated flat keyword
]

async function stemsInScope(path: string, recursive: boolean): Promise<string[]> {
  const rows = await testDb
    .select({ stem: images.stem })
    .from(imageKeywords)
    .innerJoin(images, eq(imageKeywords.imageId, images.id))
    .where(albumAtOrBelow(path, recursive))
  return rows.map((r) => r.stem).toSorted()
}

beforeAll(async () => {
  const created = createDb(':memory:')
  testDb = created.db
  runMigrations(testDb)

  for (const [path, stem] of FIXTURES) {
    const [row] = await testDb
      .insert(images)
      .values({
        root: 'fuji',
        relPath: `${stem}.JPG`,
        dir: '',
        stem,
        ext: 'jpg',
        kind: 'jpeg',
        fileSize: 1,
        mtimeMs: 1,
        indexedAt: '2026-01-01T00:00:00.000Z',
      })
      .returning({ id: images.id })
    await testDb
      .insert(imageKeywords)
      .values({ imageId: row!.id, path, leaf: path.slice(path.lastIndexOf('|') + 1) })
  }
})

describe('albumAtOrBelow', () => {
  it('includes the album itself and its whole subtree when recursive', async () => {
    expect(await stemsInScope('Ereignisse', true)).toEqual(
      ['root-album', 'sailing', 'sailing-day-1', 'sailing-longer', 'sailing-shorter'].toSorted(),
    )
  })

  it('includes only the exact album when not recursive', async () => {
    expect(await stemsInScope('Ereignisse', false)).toEqual(['root-album'])
    expect(await stemsInScope('Ereignisse|Segeln 25', false)).toEqual(['sailing'])
  })

  it('does NOT match a case-variant sibling album (the LIKE trap)', async () => {
    // SQLite's LIKE is case-insensitive for ASCII and ignores COLLATE, so
    // `path LIKE 'Ereignisse|%'` WOULD have matched 'ereignisse|Segeln 25'.
    const scoped = await stemsInScope('Ereignisse', true)
    expect(scoped).not.toContain('case-variant')

    // ...and the lowercase album scopes only its own subtree.
    expect(await stemsInScope('ereignisse', true)).toEqual(['case-variant'])
  })

  it('does NOT bleed into a sibling whose name is a prefix of another', async () => {
    // 'Segeln 2' must not swallow 'Segeln 25' / 'Segeln 250' — the separator is
    // part of the lower bound, so only real children qualify.
    expect(await stemsInScope('Ereignisse|Segeln 2', true)).toEqual(['sailing-shorter'])
    expect(await stemsInScope('Ereignisse|Segeln 25', true)).toEqual(
      ['sailing', 'sailing-day-1'].toSorted(),
    )
  })

  it('does NOT match a top-level album that merely starts with the scope', async () => {
    expect(await stemsInScope('Ereignisse', true)).not.toContain('not-a-child')
  })

  it('scopes a flat single-segment album', async () => {
    expect(await stemsInScope('Insta Post Marokko', true)).toEqual(['morocco'])
    expect(await stemsInScope('Insta Post Marokko', false)).toEqual(['morocco'])
  })

  it('matches every album for an empty path, recursive or not', async () => {
    const all = FIXTURES.map(([, stem]) => stem).toSorted()
    expect(await stemsInScope('', true)).toEqual(all)
    expect(await stemsInScope('', false)).toEqual(all)
  })

  it('returns nothing for an album nobody is tagged with', async () => {
    expect(await stemsInScope('Ereignisse|Wandern', true)).toEqual([])
  })
})
