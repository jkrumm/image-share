import { and, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm'
import { imageKeywords } from '../db/schema.js'

/**
 * Byte-exact "`image_keywords.path` is at or below `path`" predicate — the
 * single album scope builder, the keyword-tree twin of lib/dir-scope.ts's
 * `dirAtOrBelow`. The Fuji tree is flat, so this hierarchy (written by
 * Lightroom into XMP-lr:HierarchicalSubject) is the axis the library is
 * actually browsed and shared along; sharing it here is what keeps an album
 * share's count preview from diverging from what the share contains.
 *
 * `image_keywords` stores the FULL path only — no materialized ancestor rows —
 * so "at or below 'Ereignisse'" is a subtree question about the string, same
 * as it is for `images.dir`.
 *
 * Deliberately NOT `LIKE`, for the same two reasons dir-scope documents:
 * - SQLite's `LIKE` is case-insensitive for ASCII, and `COLLATE` has NO effect
 *   on it. `path LIKE 'Ereignisse|%'` therefore also matches a case-variant
 *   sibling album (`ereignisse|Segeln 25`) — keywords are free-text written by
 *   Lightroom, so those are genuinely different albums and an album share
 *   would expose images outside itself.
 * - `LIKE` needs `%`/`_` escaping; an album named `Segeln_25` would over-match
 *   `SegelnX25`.
 *
 * A half-open range on the `[prefix, prefix⁺)` interval — where `prefix⁺` is
 * `prefix` with its final byte incremented ('|' 0x7C → '}' 0x7D) — captures
 * exactly the subtree: `path >= 'Ereignisse|' AND path < 'Ereignisse}'`. It
 * compares under the column's BINARY collation (case-exact, no wildcards,
 * nothing to escape), it cannot bleed into a sibling whose name merely starts
 * with the same characters (`Segeln 2` does not scope `Segeln 25`, because the
 * separator is part of the bound), AND it is sargable, so it uses
 * `image_keywords_path_idx` instead of a full table scan — unlike `LIKE` or a
 * `substr()` comparison, both of which force a SCAN.
 *
 * `recursive: false` narrows to an exact path match (that album's own images,
 * none of its sub-albums). An empty `path` means "every album" — the
 * unconstrained predicate — so callers can pass a scope through unbranched.
 */
export function albumAtOrBelow(path: string, recursive: boolean): SQL {
  if (path === '') return sql`1 = 1`
  if (!recursive) return eq(imageKeywords.path, path)
  const prefix = `${path}|`
  const upperBound =
    prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
  return or(
    eq(imageKeywords.path, path),
    and(gte(imageKeywords.path, prefix), lt(imageKeywords.path, upperBound)),
  )!
}
