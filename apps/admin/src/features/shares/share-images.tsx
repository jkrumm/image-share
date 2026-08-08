import {
  ActionIcon,
  AspectRatio,
  Badge,
  Group,
  Pagination,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core'
import { useState, type ReactNode } from 'react'
import { LibraryImage } from '../common'
import { Lightbox } from '../library/lightbox'
import { formatNumber } from '../../lib/format'
import type { ImageDto } from '../../lib/queries/library'

/** One screen of thumbnails. GET /api/shares/:id returns the share's whole
 * resolved set unpaginated, and an album share of `Ereignisse|Segeln 25` is 550
 * images today — mounting 550 `<img>` at once on a 1 GB container's admin page
 * is the sharpest cliff in the app and it sits on the happy path. */
const PAGE_SIZE = 60

type Props = {
  images: ImageDto[]
  /** Selection shares only — folder/album shares follow their scope. */
  onRemove?: (image: ImageDto) => void
  removing?: boolean
}

export function ShareImages({ images, onRemove, removing = false }: Props): ReactNode {
  const [page, setPage] = useState(1)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const totalPages = Math.max(1, Math.ceil(images.length / PAGE_SIZE))
  // Clamped rather than reset in an effect: removing the last image of the last
  // page must not render a blank grid for a frame.
  const current = Math.min(page, totalPages)
  const start = (current - 1) * PAGE_SIZE
  const pageImages = images.slice(start, start + PAGE_SIZE)

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {formatNumber(images.length)} image{images.length === 1 ? '' : 's'}
          {totalPages > 1 && ` · showing ${start + 1}–${start + pageImages.length}`}
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 3, sm: 4, md: 6, lg: 8 }} spacing="xs">
        {pageImages.map((image, i) => (
          <div key={image.id} style={{ position: 'relative' }}>
            {onRemove && (
              <ActionIcon
                size="sm"
                color="red"
                variant="filled"
                pos="absolute"
                top={4}
                right={4}
                style={{ zIndex: 1 }}
                aria-label={`Remove ${image.stem} from share`}
                disabled={removing}
                onClick={() => onRemove(image)}
              >
                ✕
              </ActionIcon>
            )}
            {image.rating !== null && image.rating > 0 && (
              <Badge pos="absolute" bottom={4} left={4} style={{ zIndex: 1 }} size="xs">
                {image.rating}★
              </Badge>
            )}
            <AspectRatio ratio={1}>
              <LibraryImage
                id={image.id}
                size="thumb"
                alt={image.stem}
                radius="sm"
                style={{ cursor: 'pointer' }}
                onClick={() => setLightboxIndex(i)}
              />
            </AspectRatio>
          </div>
        ))}
      </SimpleGrid>

      {totalPages > 1 && (
        <Group justify="center">
          <Pagination total={totalPages} value={current} onChange={setPage} />
        </Group>
      )}

      {/* Indices are page-relative; `paging` lets the lightbox walk off either
          edge into the next page instead of dead-ending at image 60 of 550.
          `pending` is always false — the whole set is already client-side, the
          pages are slices of it. */}
      <Lightbox
        images={pageImages}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        paging={{
          page: current,
          totalPages,
          limit: PAGE_SIZE,
          total: images.length,
          pending: false,
          onPageChange: (nextPage, land) => {
            setPage(nextPage)
            const size = Math.min(PAGE_SIZE, images.length - (nextPage - 1) * PAGE_SIZE)
            setLightboxIndex(land === 'first' ? 0 : Math.max(0, size - 1))
          },
        }}
      />
    </Stack>
  )
}
