import type { ImageDto } from '../../lib/queries/library'

/**
 * Whether `GET /api/library/images/{id}/file` can produce a rendition for this
 * row.
 *
 * RAF originals cannot: renditions only ever come from the paired JPEG (design
 * §6), and the byte route answers 415 for every size but `orig`. The raws root
 * IS browsable — 3661 files that only exist there — so the grid has to show the
 * rows; it just must not ask for bytes it will never get, which is otherwise 60
 * failed requests and 60 logged errors per page turn.
 */
export function hasRendition(image: Pick<ImageDto, 'kind'>): boolean {
  return image.kind !== 'raw'
}
