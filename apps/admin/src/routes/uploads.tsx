import { createFileRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { Button, FileButton, Group, Paper, Progress, Stack, Text, TextInput } from '@mantine/core'
import { EmptyState } from 'basalt-ui'
import { LibraryImage, notifyMutation } from '../features/common'
import { formatBytes } from '../lib/format'
import { toErrorMessage } from '../lib/eden'
import { useUploadImage } from '../lib/queries/uploads'

export const Route = createFileRoute('/uploads')({
  component: UploadsPage,
})

type UploadRow = {
  /** Identity of the row, not its name — two files picked in one batch can
   * legitimately share a filename, and matching rows back by name resolved the
   * wrong one (the first still-pending twin) when they did. */
  id: string
  name: string
  size: number
  status: 'pending' | 'done' | 'error'
  /** 0–100 while uploading; null until the first progress event. */
  percent: number | null
  imageId?: number
  relPath?: string
  error?: string
}

function UploadsPage() {
  const [rows, setRows] = useState<UploadRow[]>([])
  const [dir, setDir] = useState('')
  const uploadImage = useUploadImage()
  const nextRowId = useRef(0)

  function patchRow(id: string, patch: Partial<UploadRow>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  async function handleFiles(files: File[]) {
    // Sequential on purpose: the HomeLab container has 1 GB and every upload is
    // indexed (and possibly EXIF-parsed) inline — a parallel batch of 40 MB
    // files is how that box gets OOM-killed.
    for (const file of files) {
      nextRowId.current += 1
      const id = `upload-${nextRowId.current}`
      setRows((prev) => [
        ...prev,
        { id, name: file.name, size: file.size, status: 'pending', percent: null },
      ])
      try {
        const result = await notifyMutation(
          uploadImage.mutateAsync({
            file,
            ...(dir.trim() && { dir: dir.trim() }),
            onProgress: ({ percent }) => patchRow(id, { percent }),
          }),
          {
            loading: `Uploading ${file.name}…`,
            success: `Uploaded ${file.name}`,
            error: `Failed to upload ${file.name}`,
          },
        )
        patchRow(id, {
          status: 'done',
          percent: 100,
          imageId: result.id,
          relPath: result.relPath,
        })
      } catch (err) {
        patchRow(id, { status: 'error', error: toErrorMessage(err, 'Upload failed') })
      }
    }
  }

  return (
    <Stack gap="md">
      <Group gap="sm" align="flex-end" wrap="wrap">
        <TextInput
          w={280}
          label="Sub-directory (optional)"
          description="Lands in share/<year>/<month>/<sub-directory>"
          placeholder="mallorca/day-2"
          value={dir}
          onChange={(event) => setDir(event.currentTarget.value)}
        />
        <FileButton onChange={(files) => void handleFiles(files)} multiple accept="image/*">
          {(props) => <Button {...props}>Upload images…</Button>}
        </FileButton>
        {rows.length > 0 && (
          <Button variant="subtle" onClick={() => setRows([])}>
            Clear list
          </Button>
        )}
      </Group>

      {rows.length === 0 && (
        <EmptyState
          title="No uploads yet"
          description="Uploaded images land in the service-owned uploads area and are indexed immediately."
        />
      )}

      {rows.length > 0 && (
        <Stack gap="xs">
          {rows.map((row) => (
            <UploadRowItem key={row.id} row={row} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function UploadRowItem({ row }: { row: UploadRow }) {
  return (
    <Paper withBorder p="sm">
      <Stack gap={6}>
        <Group justify="space-between" gap="sm" wrap="nowrap">
          <Text size="sm" truncate>
            {row.name}
          </Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {formatBytes(row.size)}
            {row.status === 'pending' && row.percent !== null && ` · ${row.percent}%`}
          </Text>
        </Group>

        {row.status === 'pending' && (
          <Progress
            value={row.percent ?? 0}
            animated={row.percent === null || row.percent >= 100}
            size="sm"
            aria-label={`Uploading ${row.name}`}
          />
        )}

        {row.status === 'done' && (
          <Group gap="xs" wrap="nowrap">
            {row.imageId !== undefined && (
              <LibraryImage id={row.imageId} alt={row.name} w={36} h={36} radius="sm" />
            )}
            <Text size="xs" c="green">
              done
            </Text>
            {row.relPath && (
              <Text size="xs" c="dimmed" ff="monospace" truncate>
                {row.relPath}
              </Text>
            )}
          </Group>
        )}

        {row.status === 'error' && (
          <Text size="xs" c="red">
            {row.error ?? 'Upload failed'}
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
