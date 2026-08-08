import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import {
  AspectRatio,
  Badge,
  Button,
  Center,
  CloseButton,
  CopyButton,
  FileButton,
  Group,
  Image,
  Pagination,
  Paper,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { modals } from '@mantine/modals'
import { useQuery } from '@tanstack/react-query'
import { PageActions, StatCard } from 'basalt-ui'
import { notifyWarning } from 'basalt-ui/notifications'
import {
  B2SearchSchema,
  B2_PAGE_LIMIT,
  isB2Filtered,
  toB2ListParams,
  type B2SearchParams,
} from '../features/b2/search-params'
import { QueryState, notifyMutation } from '../features/common'
import { formatBytes, formatDateTime, formatNumber } from '../lib/format'
import {
  b2Queries,
  useDeleteB2Object,
  useTriggerB2Reconcile,
  useTriggerReverseBackup,
  useUploadB2Object,
  type B2ObjectDto,
  type B2Prefix,
} from '../lib/queries/b2'

const LIMIT = B2_PAGE_LIMIT

const PREFIX_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'fuji', label: 'Fuji' },
  { value: 'blog', label: 'Blog' },
  { value: 'gen', label: 'Generated' },
  { value: 'misc', label: 'Misc' },
]

const UPLOAD_PREFIX_OPTIONS = PREFIX_OPTIONS.filter((o) => o.value !== 'all')

export const Route = createFileRoute('/public')({
  validateSearch: (raw: Record<string, unknown>) => B2SearchSchema.parse(raw),
  component: PublicPage,
})

type UploadState = { name: string; index: number; count: number; percent: number | null }

function PublicPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/public' })
  const [uploadPrefix, setUploadPrefix] = useState<B2Prefix>('misc')
  const [uploadSubdir, setUploadSubdir] = useState('')
  const [upload, setUpload] = useState<UploadState | null>(null)

  // The key filter is typed, so it debounces into the URL instead of firing a
  // request per keystroke against 180+ objects. `lastSyncedQuery` is what the
  // box and the URL last agreed on — without it the two effects below fight
  // each other and a browser Back out of a search immediately re-applies it.
  const [queryInput, setQueryInput] = useState(search.q)
  const [debouncedQuery] = useDebouncedValue(queryInput, 300)
  const lastSyncedQuery = useRef(search.q)

  useEffect(() => {
    if (debouncedQuery === lastSyncedQuery.current) return
    lastSyncedQuery.current = debouncedQuery
    // `replace` so a typed word doesn't leave one history entry per character.
    void navigate({
      search: (prev: B2SearchParams) => ({ ...prev, q: debouncedQuery, page: 1 }),
      replace: true,
    })
  }, [debouncedQuery, navigate])

  useEffect(() => {
    // The URL moved on its own (Back/Forward, a pasted link) — follow it.
    if (search.q === lastSyncedQuery.current) return
    lastSyncedQuery.current = search.q
    setQueryInput(search.q)
  }, [search.q])

  const listQuery = useQuery(b2Queries.list(toB2ListParams(search, LIMIT)))
  // Deliberately a second, unfiltered query: design §12 wants the header strip
  // bucket-wide "regardless of the active filter", and GET /api/b2's `total` is
  // the FILTERED count (only totalBytes/unmirroredCount are unfiltered).
  const summaryQuery = useQuery(b2Queries.bucketSummary())

  const total = listQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LIMIT))
  const filtered = isB2Filtered(search)

  const reconcile = useTriggerB2Reconcile()
  const reverseBackup = useTriggerReverseBackup()
  const deleteObject = useDeleteB2Object()
  const uploadObject = useUploadB2Object()

  function updateSearch(patch: Partial<B2SearchParams>) {
    void navigate({ search: { ...search, ...patch } })
  }

  function handleReconcile() {
    void notifyMutation(reconcile.mutateAsync(), {
      loading: 'Starting B2 reconcile…',
      success: 'Reconcile started',
      error: 'Could not start reconcile',
    }).catch(() => {
      /* message already surfaced by notifyMutation */
    })
  }

  function handleReverseBackup() {
    void notifyMutation(reverseBackup.mutateAsync(), {
      loading: 'Starting reverse backup…',
      success: 'Reverse backup started',
      error: 'Could not start reverse backup',
    }).catch(() => {
      /* message already surfaced by notifyMutation */
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
        void notifyMutation(deleteObject.mutateAsync(obj.key), {
          loading: 'Deleting…',
          success: 'Deleted',
          error: 'Could not delete',
        }).catch(() => {
          /* message already surfaced by notifyMutation */
        })
      },
    })
  }

  async function handleUpload(files: File[]) {
    const subdir = uploadSubdir.trim().replace(/^\/+|\/+$/g, '')
    try {
      for (const [index, file] of files.entries()) {
        setUpload({ name: file.name, index: index + 1, count: files.length, percent: null })
        try {
          const result = await notifyMutation(
            uploadObject.mutateAsync({
              file,
              prefix: uploadPrefix,
              ...(subdir && { subdir }),
              onProgress: ({ percent }) =>
                setUpload((prev) =>
                  prev && prev.name === file.name ? { ...prev, percent } : prev,
                ),
            }),
            {
              loading: `Uploading ${file.name}…`,
              success: `Uploaded ${file.name}`,
              error: `Failed to upload ${file.name}`,
            },
          )
          // The upload skips (does not overwrite) a pre-existing key — flag that
          // distinctly since the success message can't branch on it.
          if (!result.uploaded) notifyWarning(`${file.name} already exists on the CDN — skipped`)
        } catch {
          /* message already surfaced by notifyMutation; keep going with the batch */
        }
      }
    } finally {
      setUpload(null)
    }
  }

  return (
    <Stack gap="lg">
      <QueryState
        query={summaryQuery}
        errorTitle="Could not load bucket totals"
        errorFallback="The bucket mirror could not be read."
        variant="section"
      >
        {(summary) => (
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="sm">
            <StatCard label="Objects" value={formatNumber(summary.objects)} />
            <StatCard label="Total size" value={formatBytes(summary.totalBytes)} />
            <StatCard label="Not mirrored" value={formatNumber(summary.unmirroredCount)} />
            <StatCard
              label="Last reconcile"
              value={formatDateTime(summary.lastReconcileAt, 'never')}
            />
          </SimpleGrid>
        )}
      </QueryState>

      <Group justify="space-between" wrap="wrap" align="flex-end">
        <Group gap="xs" align="flex-end">
          <Select
            w={140}
            label="Prefix"
            data={UPLOAD_PREFIX_OPTIONS}
            value={uploadPrefix}
            onChange={(v) => v && setUploadPrefix(v as B2Prefix)}
            allowDeselect={false}
          />
          <TextInput
            w={220}
            label="Sub-directory (optional)"
            description="Nested under img/<prefix>/"
            placeholder="2026/07/trip"
            value={uploadSubdir}
            onChange={(event) => setUploadSubdir(event.currentTarget.value)}
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

      {upload && (
        <Stack gap={4}>
          <Group justify="space-between" gap="sm" wrap="nowrap">
            <Text size="xs" truncate>
              Uploading {upload.name} ({upload.index}/{upload.count})
            </Text>
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {upload.percent === null ? '' : `${upload.percent}%`}
            </Text>
          </Group>
          <Progress
            value={upload.percent ?? 0}
            animated={upload.percent === null || upload.percent >= 100}
            size="sm"
            aria-label={`Uploading ${upload.name}`}
          />
        </Stack>
      )}

      <PageActions>
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            w={260}
            label="Search key"
            placeholder="segeln, .webp, 2026/07"
            value={queryInput}
            onChange={(event) => setQueryInput(event.currentTarget.value)}
            rightSection={
              queryInput === '' ? null : (
                <CloseButton
                  size="sm"
                  aria-label="Clear search"
                  onClick={() => setQueryInput('')}
                />
              )
            }
          />
          <Select
            w={140}
            label="Prefix"
            data={PREFIX_OPTIONS}
            value={search.prefix}
            onChange={(v) => v && updateSearch({ prefix: v as B2SearchParams['prefix'], page: 1 })}
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
            onChange={(v) => v && updateSearch({ sort: v as B2SearchParams['sort'] })}
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
            onChange={(v) => v && updateSearch({ order: v as B2SearchParams['order'] })}
            allowDeselect={false}
          />
        </Group>
      </PageActions>

      {filtered && listQuery.data && (
        // The header strip stays bucket-wide, so the filtered count needs a home
        // of its own — otherwise a prefix filter silently has no visible effect
        // on any number.
        <Text size="xs" c="dimmed">
          {formatNumber(total)} of {formatNumber(summaryQuery.data?.objects ?? total)} objects match
        </Text>
      )}

      <QueryState
        query={listQuery}
        errorTitle="Could not load the CDN objects"
        errorFallback="The bucket mirror could not be read."
        empty={
          filtered
            ? {
                title: 'No objects match this filter',
                description: 'Clear the search or pick a different prefix.',
              }
            : {
                title: 'Nothing published yet',
                description:
                  'Publish images from the Library, or upload directly here — either way they land on img.jkrumm.com.',
              }
        }
        isEmpty={(data) => data.data.length === 0}
      >
        {(data) => (
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }} spacing="md">
            {data.data.map((obj) => (
              <B2Tile key={obj.key} obj={obj} onDelete={() => handleDelete(obj)} />
            ))}
          </SimpleGrid>
        )}
      </QueryState>

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
  // `thumbUrl` points at img.jkrumm.com (imgproxy) and MUST stay that way — the
  // whole point of the CDN is that these bytes never travel through this API.
  // The only thing handled locally is the failure case: a key present in the
  // mirror table but gone (or not yet propagated) on the CDN renders a
  // placeholder instead of a broken-image glyph.
  const [broken, setBroken] = useState(false)

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
            {broken ? (
              <Center>
                <Text size="xs" c="dimmed">
                  Preview unavailable
                </Text>
              </Center>
            ) : (
              <Image
                src={obj.thumbUrl}
                alt={obj.key}
                fit="cover"
                radius="sm"
                loading="lazy"
                onError={() => setBroken(true)}
              />
            )}
          </AspectRatio>
        </div>
        <Text size="xs" ff="monospace" truncate>
          {obj.key}
        </Text>
        <Text size="xs" c="dimmed">
          {formatBytes(obj.size)} · {formatDateTime(obj.lastModified)}
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
