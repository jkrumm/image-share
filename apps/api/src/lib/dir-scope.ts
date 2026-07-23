import { and, eq, gte, lt, or, type SQL } from 'drizzle-orm'
import { images } from '../db/schema.js'

/**
 * Byte-exact "`images.dir` is at or below `dir`" predicate — the single dir
 * scope builder shared by the folder-share membership filter (lib/share-auth)
 * and the admin library browse (routes/library), so the create-share count
 * preview can never diverge from what the share actually contains.
 *
 * Deliberately NOT `LIKE`:
 * - SQLite's `LIKE` is case-insensitive for ASCII, and `COLLATE` has NO effect
 *   on it. `dir LIKE 'Trip/%'` therefore also matches a case-variant sibling
 *   directory (`trip/sub`) — on the case-sensitive Linux filesystem those are
 *   different folders, so a folder share would expose images outside itself.
 * - `LIKE` needs `%`/`_` escaping; a folder named `Trip_1` would over-match
 *   `TripX1`.
 *
 * A half-open range on the `[prefix, prefix⁺)` interval — where `prefix⁺` is
 * `prefix` with its final byte incremented ('/' 0x2F → '0' 0x30) — captures
 * exactly the subtree: `dir >= 'Trip/' AND dir < 'Trip0'`. It compares under
 * the column's BINARY collation (case-exact, no wildcards, nothing to escape)
 * AND is sargable, so it uses `images_dir_idx` instead of a full table scan —
 * unlike `LIKE` or a `substr()` comparison, both of which force a SCAN.
 */
export function dirAtOrBelow(dir: string): SQL {
  const prefix = `${dir}/`
  const upperBound =
    prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
  return or(eq(images.dir, dir), and(gte(images.dir, prefix), lt(images.dir, upperBound)))!
}
