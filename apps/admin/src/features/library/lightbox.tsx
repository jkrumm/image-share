import { ActionIcon, Center, Group, Image, Loader, Modal, Stack, Text } from '@mantine/core'
import { useCallback, useEffect } from 'react'
import { useImageFileUrl } from '../common'
import { formatDateTime, formatNumber } from '../../lib/format'
import type { ImageDto } from '../../lib/queries/library'
import { hasRendition } from './renderable'

/**
 * How the lightbox walks off the end of a page.
 *
 * Without this the viewer dead-ends at the 60th image of a 2365-image library
 * with no hint why. `onPageChange` moves the grid and tells the page which edge
 * of the new page to land on; `pending` covers the moment the next page is
 * still in flight (the previous page is kept mounted, so the old bytes would
 * otherwise flash under a caption that already reads the new position).
 */
export type LightboxPaging = {
  page: number
  totalPages: number
  limit: number
  total: number
  pending: boolean
  onPageChange: (page: number, land: 'first' | 'last') => void
}

type Props = {
  images: ImageDto[]
  index: number | null
  onIndexChange: (index: number | null) => void
  paging?: LightboxPaging
}

export function Lightbox({ images, index, onIndexChange, paging }: Props) {
  const image = index !== null ? images[index] : undefined

  const hasPrev = index !== null && (index > 0 || (paging !== undefined && paging.page > 1))
  const hasNext =
    index !== null &&
    (index < images.length - 1 || (paging !== undefined && paging.page < paging.totalPages))

  const goPrev = useCallback(() => {
    if (index === null) return
    if (index > 0) {
      onIndexChange(index - 1)
      return
    }
    if (paging && paging.page > 1) paging.onPageChange(paging.page - 1, 'last')
  }, [index, onIndexChange, paging])

  const goNext = useCallback(() => {
    if (index === null) return
    if (index < images.length - 1) {
      onIndexChange(index + 1)
      return
    }
    if (paging && paging.page < paging.totalPages) paging.onPageChange(paging.page + 1, 'first')
  }, [index, images.length, onIndexChange, paging])

  useEffect(() => {
    if (index === null) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowLeft') goPrev()
      if (event.key === 'ArrowRight') goNext()
      if (event.key === 'Escape') onIndexChange(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [index, goPrev, goNext, onIndexChange])

  return (
    <Modal
      opened={image !== undefined}
      onClose={() => onIndexChange(null)}
      fullScreen
      withCloseButton={false}
      padding={0}
      styles={{ body: { height: '100vh', display: 'flex', flexDirection: 'column' } }}
    >
      {image && (
        <LightboxBody
          image={image}
          index={index ?? 0}
          count={images.length}
          paging={paging}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onPrev={goPrev}
          onNext={goNext}
          onClose={() => onIndexChange(null)}
        />
      )}
    </Modal>
  )
}

type BodyProps = {
  image: ImageDto
  index: number
  count: number
  paging: LightboxPaging | undefined
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

function LightboxBody({
  image,
  index,
  count,
  paging,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: BodyProps) {
  // Reactive URLs: an asset token re-minted while the lightbox is open must
  // reach the already-painted <img>, which a one-shot imageFileUrl() cannot do.
  const displayUrl = useImageFileUrl(image.id, 'med')
  const originalUrl = useImageFileUrl(image.id, 'orig')

  const position = paging
    ? `${formatNumber((paging.page - 1) * paging.limit + index + 1)} / ${formatNumber(paging.total)}`
    : `${index + 1} / ${count}`

  return (
    <Stack h="100%" gap={0}>
      <Group justify="space-between" p="sm" wrap="nowrap">
        <Text size="sm" c="dimmed" truncate>
          {image.dir ? `${image.dir}/` : ''}
          {image.stem}.{image.ext} · {position} · {formatDateTime(image.captureAt)}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <ActionIcon
            component="a"
            href={originalUrl}
            target="_blank"
            rel="noreferrer"
            variant="default"
            aria-label="Download original"
          >
            ⬇
          </ActionIcon>
          <ActionIcon variant="default" onClick={onClose} aria-label="Close">
            ✕
          </ActionIcon>
        </Group>
      </Group>
      <Group flex={1} justify="center" align="center" pos="relative" px="xl" pb="xl">
        <ActionIcon
          variant="subtle"
          size="xl"
          pos="absolute"
          left={8}
          disabled={!hasPrev}
          onClick={onPrev}
          aria-label="Previous"
        >
          ‹
        </ActionIcon>
        {paging?.pending ? (
          <Center h="100%">
            <Loader size="sm" />
          </Center>
        ) : hasRendition(image) ? (
          <Image
            src={displayUrl}
            alt={image.stem}
            fit="contain"
            mah="calc(100vh - 120px)"
            w="auto"
          />
        ) : (
          // A RAF has no rendition — asking for one is a 415, so offer the only
          // thing that exists for this row: the original bytes.
          <Center h="100%">
            <Text size="sm" c="dimmed" ta="center">
              .{image.ext.toUpperCase()} has no preview — download the original above.
            </Text>
          </Center>
        )}
        <ActionIcon
          variant="subtle"
          size="xl"
          pos="absolute"
          right={8}
          disabled={!hasNext}
          onClick={onNext}
          aria-label="Next"
        >
          ›
        </ActionIcon>
      </Group>
    </Stack>
  )
}
