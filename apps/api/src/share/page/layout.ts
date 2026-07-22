// Deterministic bento-grid span computation (Stage 3, share page redesign
// brief §C). Server renders inline `--col-span`/`--row-span` custom properties
// per tile from this SAME function the client would use to recompute layout
// on a view switch — index + aspect ratio are the only inputs, so server and
// client always agree without any negotiation.
//
// Rule (tunable, not a spec contract): landscape (w/h >= 1.3) spans 2 columns;
// portrait (w/h <= 0.8) spans 2 rows; every 7th item spans 2x2; everything
// else is 1x1. `grid-auto-flow: dense` (set in styles.ts) backfills the holes
// left by the wider/taller tiles. The max span produced here is 2, which is
// also the minimum column count at the sub-640px breakpoint (brief §C) — so
// clamping is a defensive no-op in the shipped breakpoints, but the `columns`
// parameter still enforces it explicitly for any future column count.

export interface BentoDims {
  width: number | null
  height: number | null
}

export interface BentoSpan {
  colSpan: number
  rowSpan: number
}

const LANDSCAPE_RATIO = 1.3
const PORTRAIT_RATIO = 0.8
const BIG_TILE_EVERY = 7
const BIG_TILE_SPAN = 2

function clampSpan(span: BentoSpan, columns: number): BentoSpan {
  return {
    colSpan: Math.min(span.colSpan, columns),
    rowSpan: Math.min(span.rowSpan, columns),
  }
}

/**
 * Compute the col/row span for a single tile at `index` (0-based, position in
 * the full share, not the visible page) given its known-or-unknown aspect
 * ratio. `columns` clamps the result to the current breakpoint's column
 * count (default: no clamp).
 */
export function bentoSpanFor(dims: BentoDims, index: number, columns = Infinity): BentoSpan {
  if ((index + 1) % BIG_TILE_EVERY === 0) {
    return clampSpan({ colSpan: BIG_TILE_SPAN, rowSpan: BIG_TILE_SPAN }, columns)
  }
  const ratio = dims.width && dims.height ? dims.width / dims.height : null
  if (ratio !== null && ratio >= LANDSCAPE_RATIO) {
    return clampSpan({ colSpan: 2, rowSpan: 1 }, columns)
  }
  if (ratio !== null && ratio <= PORTRAIT_RATIO) {
    return clampSpan({ colSpan: 1, rowSpan: 2 }, columns)
  }
  // Unknown or square-ish dimensions fall back to a 1x1 tile — matches the
  // 3:2 fallback aspect box used for the unknown-dimension case elsewhere.
  return clampSpan({ colSpan: 1, rowSpan: 1 }, columns)
}

/** Compute spans for every image in order (design §C). */
export function computeBentoSpans(images: readonly BentoDims[], columns = Infinity): BentoSpan[] {
  return images.map((dims, index) => bentoSpanFor(dims, index, columns))
}
