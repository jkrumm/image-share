import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = join(SRC, 'features/shares/min-rating-input.tsx')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.isFile() && path.endsWith('.tsx') ? [path] : []
  })
}

describe('MinRatingInput is the one minimum-rating control', () => {
  // The regression: the Library toolbar rolled its own `<Rating>` inside an
  // `Input.Wrapper`, so the same concept shipped in two shapes with different
  // copy — and, worse, as a dead end: Mantine only resets a Rating to 0 with
  // `allowClear`, which is off by default and not themed in by basalt-ui, so
  // once three stars were clicked no control could send `minRating: undefined`
  // again.
  test('no other component renders a bare Mantine Rating', () => {
    const offenders = tsxFiles(SRC)
      .filter((path) => path !== OWNER)
      .filter((path) => /<Rating[\s/>]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))

    expect(offenders).toEqual([])
  })

  test('the owner does render one, so the guard above cannot pass vacuously', () => {
    expect(/<Rating[\s/>]/.test(readFileSync(OWNER, 'utf8'))).toBe(true)
  })

  test('it ships an explicit clear affordance, since Mantine will not', () => {
    expect(readFileSync(OWNER, 'utf8')).toContain('onChange(0)')
  })
})
