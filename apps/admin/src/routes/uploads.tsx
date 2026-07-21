import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Button, FileButton, Group, Stack, Text } from '@mantine/core'
import { notifyPromise } from 'basalt-ui/notifications'
import { EmptyState } from 'basalt-ui'
import { useUploadImage } from '../lib/queries/uploads'

export const Route = createFileRoute('/uploads')({
  component: UploadsPage,
})

type UploadRow = { name: string; status: 'pending' | 'done' | 'error'; adminFileUrl?: string }

function UploadsPage() {
  const [rows, setRows] = useState<UploadRow[]>([])
  const uploadImage = useUploadImage()

  async function handleFiles(files: File[]) {
    for (const file of files) {
      setRows((prev) => [...prev, { name: file.name, status: 'pending' }])
      try {
        const result = await notifyPromise(uploadImage.mutateAsync(file), {
          loading: `Uploading ${file.name}…`,
          success: `Uploaded ${file.name}`,
          error: `Failed to upload ${file.name}`,
        })
        setRows((prev) =>
          prev.map((r) =>
            r.name === file.name && r.status === 'pending'
              ? { ...r, status: 'done', adminFileUrl: result.adminFileUrl }
              : r,
          ),
        )
      } catch {
        setRows((prev) =>
          prev.map((r) =>
            r.name === file.name && r.status === 'pending' ? { ...r, status: 'error' } : r,
          ),
        )
      }
    }
  }

  return (
    <Stack gap="md">
      <FileButton onChange={(files) => void handleFiles(files)} multiple accept="image/*">
        {(props) => <Button {...props}>Upload images…</Button>}
      </FileButton>

      {rows.length === 0 && (
        <EmptyState
          title="No uploads yet"
          description="Uploaded images land in the service-owned uploads area and are indexed immediately."
        />
      )}

      {rows.length > 0 && (
        <Stack gap="xs">
          {rows.map((row, i) => (
            <Group key={`${row.name}-${i}`} justify="space-between">
              <Text size="sm">{row.name}</Text>
              <Text size="xs" c={row.status === 'error' ? 'red' : 'dimmed'}>
                {row.status}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  )
}
