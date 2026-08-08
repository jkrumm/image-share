import {
  AspectRatio,
  Badge,
  Box,
  Button,
  CloseButton,
  Group,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core'
import { alpha, VX } from 'basalt-ui/tokens'
import { LibraryImage } from '../common'
import { formatDate } from '../../lib/format'
import { hasRendition } from './renderable'
import type { SelectedImage } from './selection'

type Props = {
  opened: boolean
  onClose: () => void
  /** Already in the order a selection share would be created with. */
  images: SelectedImage[]
  onRemove: (id: number) => void
  onClear: () => void
}

/**
 * The answer to "what exactly is selected". A selection survives filter changes
 * and page turns by design, so the banner count alone is not enough — this is
 * the surface that makes an off-screen pick visible and removable before it
 * silently lands in a share.
 */
export function SelectionModal({ opened, onClose, images, onRemove, onClear }: Props) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`${images.length} selected · share order`}
      size="xl"
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Shown in the order a selection share is delivered: oldest capture first, across every page
          these were picked on. The toolbar’s sort changes how you browse, never how a share reads.
        </Text>

        <SimpleGrid cols={{ base: 3, sm: 5, md: 7 }} spacing="xs">
          {images.map((image, index) => (
            <Box key={image.id} pos="relative">
              <Badge
                pos="absolute"
                top={4}
                left={4}
                size="xs"
                variant="filled"
                style={{ zIndex: 1 }}
              >
                {index + 1}
              </Badge>
              <CloseButton
                size="sm"
                pos="absolute"
                top={2}
                right={2}
                style={{ zIndex: 1 }}
                aria-label={`Remove ${image.stem}.${image.ext} from the selection`}
                onClick={() => onRemove(image.id)}
              />
              <AspectRatio
                ratio={1}
                style={{
                  borderRadius: 'var(--mantine-radius-sm)',
                  overflow: 'hidden',
                  background: alpha(VX.ink, 0.06),
                }}
              >
                {hasRendition(image) ? (
                  <LibraryImage id={image.id} size="thumb" alt={image.stem} fit="cover" />
                ) : (
                  // A RAF has no rendition; asking for one is a guaranteed 415.
                  <Text size="xs" c="dimmed" ta="center">
                    .{image.ext.toUpperCase()}
                    <br />
                    no preview
                  </Text>
                )}
              </AspectRatio>
              <Text size="xs" truncate title={`${image.root}/${image.dir}`}>
                {image.stem}
              </Text>
              <Text size="xs" c="dimmed">
                {formatDate(image.captureAt)}
              </Text>
            </Box>
          ))}
        </SimpleGrid>

        <Group justify="space-between">
          <Button size="xs" variant="default" color="red" onClick={onClear}>
            Clear selection
          </Button>
          <Button size="xs" onClick={onClose}>
            Done
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
