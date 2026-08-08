import { AspectRatio, Badge, Box, Center, Checkbox, SimpleGrid, Stack, Text } from '@mantine/core'
import { alpha, VX } from 'basalt-ui/tokens'
import { LibraryImage } from '../common'
import type { ImageFileSize } from '../../lib/eden'
import type { ImageDto } from '../../lib/queries/library'
import { hasRendition } from './renderable'
import type { Selection } from './selection'

/**
 * Tile rendition tier.
 *
 * It should be `'small'` (900px webp) — a 2-column phone tile is ~190 CSS px,
 * which is 570 device px at 3× and therefore already past `thumb`'s 480. But
 * `GET /api/library/images/{id}/file` still enumerates `thumb|med|full|orig`
 * (apps/api/src/routes/library.ts), so `'small'` is not addressable over the
 * admin byte route yet — see the note on `ImageFileSize` in lib/eden.ts. (The
 * share page already serves it, and `RENDITION_SIZES` already deletes it.) Once
 * the route's enum gains `'small'`, this becomes a per-breakpoint choice:
 * `'small'` at ≤3 columns, `'thumb'` above.
 */
const TILE_SIZE: ImageFileSize = 'thumb'

type Props = {
  images: ImageDto[]
  selection: Selection
  /** `shiftKey` asks for a range from the last toggled tile to this one. */
  onToggle: (index: number, shiftKey: boolean) => void
  onOpen: (index: number) => void
  /** True while a page turn is settling — the previous page stays up, dimmed. */
  stale?: boolean
}

export function ImageGrid({ images, selection, onToggle, onOpen, stale = false }: Props) {
  return (
    <SimpleGrid
      cols={{ base: 2, xs: 3, sm: 3, md: 4, lg: 6 }}
      spacing="xs"
      style={{ opacity: stale ? 0.55 : 1, transition: 'opacity 120ms ease' }}
    >
      {images.map((image, index) => {
        const selected = selection.has(image.id)
        return (
          <Box
            key={image.id}
            pos="relative"
            style={{
              borderRadius: 'var(--mantine-radius-sm)',
              outline: selected ? `2px solid ${VX.accent}` : 'none',
              outlineOffset: 2,
            }}
          >
            <Checkbox
              size="sm"
              checked={selected}
              readOnly
              aria-label={`${selected ? 'Deselect' : 'Select'} ${image.stem}.${image.ext}`}
              onClick={(event) => onToggle(index, event.shiftKey)}
              pos="absolute"
              top={6}
              left={6}
              style={{ zIndex: 1 }}
            />
            {image.rating !== null && image.rating > 0 && (
              <Badge pos="absolute" top={6} right={6} style={{ zIndex: 1 }} size="xs">
                {image.rating}★
              </Badge>
            )}
            <AspectRatio
              ratio={1}
              style={{
                borderRadius: 'var(--mantine-radius-sm)',
                overflow: 'hidden',
                // A tile that has not painted yet is a soft block, not a white
                // hole — 60 lazy thumbs land over several seconds.
                background: alpha(VX.ink, 0.06),
              }}
            >
              {hasRendition(image) ? (
                <LibraryImage
                  id={image.id}
                  size={TILE_SIZE}
                  alt={image.stem}
                  fit="cover"
                  loading="lazy"
                  onClick={() => onOpen(index)}
                  style={{ cursor: 'pointer' }}
                />
              ) : (
                <Center onClick={() => onOpen(index)} style={{ cursor: 'pointer' }}>
                  <Stack gap={2} align="center">
                    <Text size="sm" fw={600} c="dimmed">
                      .{image.ext.toUpperCase()}
                    </Text>
                    <Text size="xs" c="dimmed" ta="center" px={4}>
                      no preview
                    </Text>
                  </Stack>
                </Center>
              )}
            </AspectRatio>
          </Box>
        )
      })}
    </SimpleGrid>
  )
}
