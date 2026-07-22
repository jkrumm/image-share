import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  AspectRatio,
  Badge,
  Button,
  CopyButton,
  FileButton,
  Group,
  Image,
  Loader,
  Pagination,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { EmptyState, PageActions, StatCard } from 'basalt-ui'
import { notifyPromise, notifyWarning } from 'basalt-ui/notifications'
import { formatBytes } from '../lib/format'
import {
  b2Queries,
  useDeleteB2Object,
  useTriggerB2Reconcile,
  useTriggerReverseBackup,
  useUploadB2Object,
  type B2ObjectDto,
  type B2Prefix,
} from '../lib/queries/b2'

const LIMIT = 60

const PREFIX_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'fuji', label: 'Fuji' },
  { value: 'blog', label: 'Blog' },
  { value: 'gen', label: 'Generated' },
  { value: 'misc', label: 'Misc' },
]

const UPLOAD_PREFIX_OPTIONS = PREFIX_OPTIONS.filter((o) => o.value !== 'all')

const SearchSchema = z.object({
  prefix: z.enum(['all', 'fuji', 'blog', 'gen', 'misc']).default('all'),
  page: z.number().int().min(1).default(1),
  sort: z.enum(['lastModified', 'key', 'size']).default('lastModified'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

type SearchParams = z.infer<typeof SearchSchema>

export const Route = createFileRoute('/public')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  component: PublicPage,
})

function PublicPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/public' })
  const [uploadPrefix, setUploadPrefix] = useState<B2Prefix>('misc')

  const { data, isLoading } = useQuery(
    b2Queries.list({
      prefix: search.prefix,
      page: search.page,
      limit: LIMIT,
      sort: search.sort,
      order: search.order,
    }),
  )
  const objects = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  const reconcile = useTriggerB2Reconcile()
  const reverseBackup = useTriggerReverseBackup()
  const deleteObject = useDeleteB2Object()
  const uploadObject = useUploadB2Object()

  function updateSearch(patch: Partial<SearchParams>) {
    void navigate({ search: { ...search, ...patch } })
  }

  function handleReconcile() {
    void notifyPromise(reconcile.mutateAsync(), {
      loading: 'Starting B2 reconcile…',
      success: 'Reconcile started',
      error: 'Could not start reconcile',
    })
  }

  function handleReverseBackup() {
    void notifyPromise(reverseBackup.mutateAsync(), {
      loading: 'Starting reverse backup…',
      success: 'Reverse backup started',
      error: 'Could not start reverse backup',
    })
  }

  function handleDelete(obj: B2ObjectDto) {
    modals.openConfirmModal({
      title: 'Delete from the CDN',
      children: (
        <Text size="sm">
          Delete{' '}
          <Text span ff="monospace">
            {obj.key}
          </Text>
          ? This removes it from B2 and the public URL immediately. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void notifyPromise(deleteObject.mutateAsync(obj.key), {
          loading: 'Deleting…',
          success: 'Deleted',
          error: 'Could not delete',
        })
      },
    })
  }

  async function handleUpload(files: File[]) {
    for (const file of files) {
      try {
        const result = await notifyPromise(
          uploadObject.mutateAsync({ file, prefix: uploadPrefix }),
          {
            loading: `Uploading ${file.name}…`,
            success: `Uploaded ${file.name}`,
            error: `Failed to upload ${file.name}`,
          },
        )
        // The upload skips (does not overwrite) a pre-existing key — flag that
        // distinctly since notifyPromise's success message can't branch on it.
        if (!result.uploaded) notifyWarning(`${file.name} already exists on the CDN — skipped`)
      } catch {
        /* toast already shown by notifyPromise */
      }
    }
  }

  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="sm">
        <StatCard label="Objects" value={String(total)} />
        <StatCard label="Total size" value={formatBytes(data?.totalBytes ?? 0)} />
        <StatCard label="Not mirrored" value={String(data?.unmirroredCount ?? 0)} />
        <StatCard label="Last reconcile" value={data?.lastReconcileAt ?? 'never'} />
      </SimpleGrid>

      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Select
            w={140}
            data={UPLOAD_PREFIX_OPTIONS}
            value={uploadPrefix}
            onChange={(v) => v && setUploadPrefix(v as B2Prefix)}
            allowDeselect={false}
          />
          <FileButton onChange={(files) => void handleUpload(files)} multiple accept="image/*">
            {(props) => <Button {...props}>Upload to CDN…</Button>}
          </FileButton>
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            loading={reconcile.isPending}
            onClick={handleReconcile}
          >
            Reconcile bucket
          </Button>
          <Button
            size="xs"
            variant="default"
            loading={reverseBackup.isPending}
            onClick={handleReverseBackup}
          >
            Run reverse backup
          </Button>
        </Group>
      </Group>

      <PageActions>
        <Group gap="sm" wrap="wrap">
          <Select
            w={140}
            label="Prefix"
            data={PREFIX_OPTIONS}
            value={search.prefix}
            onChange={(v) => v && updateSearch({ prefix: v as SearchParams['prefix'], page: 1 })}
            allowDeselect={false}
          />
          <Select
            w={160}
            label="Sort"
            data={[
              { value: 'lastModified', label: 'Last modified' },
              { value: 'key', label: 'Key' },
              { value: 'size', label: 'Size' },
            ]}
            value={search.sort}
            onChange={(v) => v && updateSearch({ sort: v as SearchParams['sort'] })}
            allowDeselect={false}
          />
          <Select
            w={120}
            label="Order"
            data={[
              { value: 'desc', label: 'Descending' },
              { value: 'asc', label: 'Ascending' },
            ]}
            value={search.order}
            onChange={(v) => v && updateSearch({ order: v as SearchParams['order'] })}
            allowDeselect={false}
          />
        </Group>
      </PageActions>

      {isLoading && <Loader size="sm" />}

      {!isLoading && objects.length === 0 && (
        <EmptyState
          title="Nothing published yet"
          description="Publish images from the Library, or upload directly here — either way they land on img.jkrumm.com."
        />
      )}

      {objects.length > 0 && (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }} spacing="md">
          {objects.map((obj) => (
            <B2Tile key={obj.key} obj={obj} onDelete={() => handleDelete(obj)} />
          ))}
        </SimpleGrid>
      )}

      {totalPages > 1 && (
        <Group justify="center">
          <Pagination
            total={totalPages}
            value={search.page}
            onChange={(page) => updateSearch({ page })}
          />
        </Group>
      )}
    </Stack>
  )
}

function B2Tile({ obj, onDelete }: { obj: B2ObjectDto; onDelete: () => void }) {
  return (
    <Paper withBorder p="xs">
      <Stack gap={6}>
        <div style={{ position: 'relative' }}>
          {!obj.mirrored && (
            <Badge color="yellow" size="xs" pos="absolute" top={4} left={4} style={{ zIndex: 1 }}>
              not mirrored
            </Badge>
          )}
          <AspectRatio ratio={1}>
            <Image src={obj.thumbUrl} alt={obj.key} fit="cover" radius="sm" />
          </AspectRatio>
        </div>
        <Text size="xs" ff="monospace" truncate>
          {obj.key}
        </Text>
        <Text size="xs" c="dimmed">
          {formatBytes(obj.size)} · {obj.lastModified}
        </Text>
        <Group gap="xs" justify="space-between">
          <CopyButton value={obj.cdnUrl}>
            {({ copied, copy }) => (
              <Button size="xs" variant="default" onClick={copy}>
                {copied ? 'Copied' : 'Copy URL'}
              </Button>
            )}
          </CopyButton>
          <Button size="xs" variant="subtle" color="red" onClick={onDelete}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Paper>
  )
}
