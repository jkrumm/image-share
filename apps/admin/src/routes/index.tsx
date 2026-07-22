import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import {
  AspectRatio,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  Image,
  Loader,
  Pagination,
  Paper,
  Rating,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { EmptyState, PageActions } from 'basalt-ui'
import { DirTree } from '../features/library/dir-tree'
import { Lightbox } from '../features/library/lightbox'
import { PublishModal } from '../features/library/publish-modal'
import { ShareFormModal } from '../features/shares/share-form-modal'
import { imageFileUrl } from '../lib/eden'
import { libraryQueries, type ImageDto, type LibraryRoot } from '../lib/queries/library'

const LIMIT = 60

const SearchSchema = z.object({
  root: z.enum(['fuji', 'raws', 'share']).optional(),
  dir: z.string().optional(),
  recursive: z.boolean().default(false),
  minRating: z.number().int().min(0).max(5).optional(),
  page: z.number().int().min(1).default(1),
  sort: z.enum(['captureAt', 'name']).default('captureAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

type SearchParams = z.infer<typeof SearchSchema>

export const Route = createFileRoute('/')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  component: LibraryPage,
})

function LibraryPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/' })
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [publishOpened, setPublishOpened] = useState(false)
  const [shareFromFolderOpened, setShareFromFolderOpened] = useState(false)

  const imagesParams = useMemo(
    () => ({
      root: search.root,
      dir: search.dir,
      recursive: search.recursive,
      minRating: search.minRating,
      page: search.page,
      limit: LIMIT,
      sort: search.sort,
      order: search.order,
    }),
    [search],
  )

  const { data, isLoading } = useQuery(libraryQueries.images(imagesParams))
  const images = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  function updateSearch(patch: Partial<SearchParams>) {
    void navigate({ search: { ...search, ...patch } })
  }

  function selectDir(root: LibraryRoot, dir: string) {
    setSelection(new Set())
    updateSearch({ root, dir, page: 1 })
  }

  function toggleSelect(id: number) {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedIds = Array.from(selection)

  return (
    <Grid gap={0} h="calc(100vh - 60px)">
      <Grid.Col span={3} style={{ borderRight: '1px solid var(--mantine-color-default-border)' }}>
        <DirTree root={search.root} dir={search.dir} onSelect={selectDir} />
      </Grid.Col>
      <Grid.Col span={9} p="md">
        <Stack gap="md">
          <PageActions>
            <Group gap="sm" wrap="wrap">
              <Rating
                value={search.minRating ?? 0}
                onChange={(v) => updateSearch({ minRating: v === 0 ? undefined : v, page: 1 })}
              />
              <Checkbox
                label="Include subfolders"
                checked={search.recursive}
                onChange={(e) => updateSearch({ recursive: e.currentTarget.checked, page: 1 })}
              />
              <Select
                w={160}
                data={[
                  { value: 'captureAt', label: 'Capture date' },
                  { value: 'name', label: 'Name' },
                ]}
                value={search.sort}
                onChange={(v) => v && updateSearch({ sort: v as SearchParams['sort'] })}
                allowDeselect={false}
              />
              <Select
                w={120}
                data={[
                  { value: 'desc', label: 'Newest' },
                  { value: 'asc', label: 'Oldest' },
                ]}
                value={search.order}
                onChange={(v) => v && updateSearch({ order: v as SearchParams['order'] })}
                allowDeselect={false}
              />
            </Group>
          </PageActions>

          {selection.size > 0 && (
            <Paper withBorder p="xs">
              <Group justify="space-between">
                <Text size="sm">{selection.size} selected</Text>
                <Group gap="xs">
                  <Button size="xs" variant="default" onClick={() => setSelection(new Set())}>
                    Clear
                  </Button>
                  <Button size="xs" onClick={() => setPublishOpened(true)}>
                    Publish to CDN…
                  </Button>
                </Group>
              </Group>
            </Paper>
          )}

          {/* RAWs can't back a folder share — every raws row is kind='raw' and the
              share content query requires kind='jpeg', so the link would be dead
              on arrival. RAW downloads ride along on a fuji/share folder share
              via a full-role token instead. */}
          {search.dir !== undefined && search.root !== 'raws' && (
            <Group justify="flex-end">
              <Button size="xs" variant="light" onClick={() => setShareFromFolderOpened(true)}>
                Create share from this folder…
              </Button>
            </Group>
          )}

          {isLoading && <Loader size="sm" />}

          {!isLoading && images.length === 0 && (
            <EmptyState
              title="No images"
              description="Pick a folder on the left, or adjust the rating filter. Uploads land here after being indexed."
            />
          )}

          {images.length > 0 && (
            <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 6 }} spacing="xs">
              {images.map((image: ImageDto, i: number) => (
                <div key={image.id} style={{ position: 'relative' }}>
                  <Checkbox
                    checked={selection.has(image.id)}
                    onChange={() => toggleSelect(image.id)}
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
                  <AspectRatio ratio={1}>
                    <Image
                      src={imageFileUrl(image.id, 'thumb')}
                      alt={image.stem}
                      fit="cover"
                      radius="sm"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setLightboxIndex(i)}
                    />
                  </AspectRatio>
                </div>
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
      </Grid.Col>

      <Lightbox images={images} index={lightboxIndex} onIndexChange={setLightboxIndex} />
      <PublishModal
        imageIds={selectedIds}
        opened={publishOpened}
        onClose={() => setPublishOpened(false)}
      />
      {search.root && search.root !== 'raws' && search.dir !== undefined && (
        <ShareFormModal
          opened={shareFromFolderOpened}
          onClose={() => setShareFromFolderOpened(false)}
          initial={{ root: search.root, dir: search.dir }}
        />
      )}
    </Grid>
  )
}
