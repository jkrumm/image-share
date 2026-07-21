import { Button, Modal, Select, Stack, Text } from '@mantine/core'
import { useState } from 'react'
import { notifyPromise } from 'basalt-ui/notifications'
import { usePublishImages, type PublishInput } from '../../lib/queries/library'

const PREFIX_OPTIONS: { value: PublishInput['prefix']; label: string }[] = [
  { value: 'fuji', label: 'Fuji' },
  { value: 'blog', label: 'Blog' },
  { value: 'gen', label: 'Generated' },
  { value: 'misc', label: 'Misc' },
]

type Props = {
  imageIds: number[]
  opened: boolean
  onClose: () => void
}

export function PublishModal({ imageIds, opened, onClose }: Props) {
  const [prefix, setPrefix] = useState<PublishInput['prefix']>('fuji')
  const publish = usePublishImages()

  function handlePublish() {
    notifyPromise(publish.mutateAsync({ imageIds, prefix }), {
      loading: `Publishing ${imageIds.length} image(s)…`,
      success: 'Published to the CDN',
      error: 'Publish failed',
    })
      .then(onClose)
      .catch(() => {
        /* toast already shown by notifyPromise */
      })
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Publish to CDN">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Copies {imageIds.length} image(s) to the public B2 bucket under{' '}
          <Text span ff="monospace">
            img/&lt;prefix&gt;/
          </Text>
          . Existing keys are skipped, not overwritten.
        </Text>
        <Select
          label="Prefix"
          data={PREFIX_OPTIONS}
          value={prefix}
          onChange={(v) => v && setPrefix(v as PublishInput['prefix'])}
          allowDeselect={false}
        />
        <Button
          onClick={handlePublish}
          loading={publish.isPending}
          disabled={imageIds.length === 0}
        >
          Publish {imageIds.length} image(s)
        </Button>
      </Stack>
    </Modal>
  )
}
