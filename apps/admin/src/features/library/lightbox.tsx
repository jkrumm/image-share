import { ActionIcon, Group, Image, Modal, Stack, Text } from '@mantine/core'
import { useEffect } from 'react'
import { imageFileUrl } from '../../lib/eden'
import type { ImageDto } from '../../lib/queries/library'

type Props = {
  images: ImageDto[]
  index: number | null
  onIndexChange: (index: number | null) => void
}

export function Lightbox({ images, index, onIndexChange }: Props) {
  const image = index !== null ? images[index] : undefined

  useEffect(() => {
    if (index === null) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') onIndexChange(Math.max(0, (index ?? 0) - 1))
      if (e.key === 'ArrowRight') onIndexChange(Math.min(images.length - 1, (index ?? 0) + 1))
      if (e.key === 'Escape') onIndexChange(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [index, images.length, onIndexChange])

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
        <Stack h="100%" gap={0}>
          <Group justify="space-between" p="sm">
            <Text size="sm" c="dimmed">
              {image.dir}/{image.stem}.{image.ext} · {index !== null ? index + 1 : 0} /{' '}
              {images.length}
            </Text>
            <Group gap="xs">
              <ActionIcon
                component="a"
                href={imageFileUrl(image.id, 'orig')}
                target="_blank"
                rel="noreferrer"
                variant="default"
                aria-label="Download original"
              >
                ⬇
              </ActionIcon>
              <ActionIcon variant="default" onClick={() => onIndexChange(null)} aria-label="Close">
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
              disabled={index === 0}
              onClick={() => onIndexChange(Math.max(0, (index ?? 0) - 1))}
              aria-label="Previous"
            >
              ‹
            </ActionIcon>
            <Image
              src={imageFileUrl(image.id, 'med')}
              alt={image.stem}
              fit="contain"
              mah="calc(100vh - 120px)"
              w="auto"
            />
            <ActionIcon
              variant="subtle"
              size="xl"
              pos="absolute"
              right={8}
              disabled={index === images.length - 1}
              onClick={() => onIndexChange(Math.min(images.length - 1, (index ?? 0) + 1))}
              aria-label="Next"
            >
              ›
            </ActionIcon>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
