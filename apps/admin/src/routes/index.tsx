import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Drawer,
  Grid,
  Group,
  Pagination,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { PageActions } from 'basalt-ui'
import { notifyMutation, QueryState } from '../features/common'
import { BrowsePanel } from '../features/library/browse-panel'
import {
  FilterBar,
  type FilterChangeOptions,
  type FilterPatch,
} from '../features/library/filter-bar'
import { ImageGrid } from '../features/library/image-grid'
import { Lightbox } from '../features/library/lightbox'
import { PublishModal } from '../features/library/publish-modal'
import { SelectionModal } from '../features/library/selection-modal'
import {
  addToSelection,
  intersectSelection,
  isSelectionStale,
  nextSelectionKeys,
  orderedSelection,
  removeFromSelection,
  unshareableSelection,
  type SelectedImage,
  type SelectionKeys,
} from '../features/library/selection'
import {
  filterKeyOf,
  LIBRARY_PAGE_LIMIT,
  LibrarySearchSchema,
  scopeLabel,
  shareActionOf,
  toImagesParams,
  type LibrarySearchParams,
} from '../features/library/search-params'
import { CreateShareModal } from '../features/shares/create-share-modal'
import { formatNumber } from '../lib/format'
import {
  fetchAllMatchingImages,
  libraryQueries,
  type ImageDto,
  type LibraryRoot,
} from '../lib/queries/library'
import type { ShareSourceInput } from '../lib/queries/shares'

const LIMIT = LIBRARY_PAGE_LIMIT

export const Route = createFileRoute('/')({
  validateSearch: (raw: Record<string, unknown>) => LibrarySearchSchema.parse(raw),
  component: LibraryPage,
})

function LibraryPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/' })

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [publishOpened, setPublishOpened] = useState(false)
  const [reviewOpened, setReviewOpened] = useState(false)
  const [createShareSource, setCreateShareSource] = useState<ShareSourceInput | null>(null)
  const [drawerOpened, drawer] = useDisclosure(false)
  const [bulkPending, setBulkPending] = useState(false)

  // Full rows, not bare ids — the ordering a selection share promises has to
  // hold for images picked on a page the user has long since left. See
  // features/library/selection.ts.
  const [selection, setSelection] = useState<Map<number, SelectedImage>>(new Map())
  /** Every filter under which something currently selected was picked. */
  const [selectionKeys, setSelectionKeys] = useState<SelectionKeys>(new Set<string>())
  const anchorIndex = useRef<number | null>(null)
  /** Latest selection, readable from an async bulk action without a stale closure. */
  const selectionRef = useRef(selection)
  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  const imagesParams = useMemo(() => toImagesParams(search, LIMIT), [search])

  const query = useQuery({
    ...libraryQueries.images(imagesParams),
    // A page turn keeps the previous grid mounted instead of unmounting it to a
    // bare Loader — 60 tiles do not have to be re-requested to be looked at.
    placeholderData: keepPreviousData,
  })

  const images = (query.data?.data ?? []) as ImageDto[]
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  const filterKey = useMemo(() => filterKeyOf(search), [search])

  const selectionStale = isSelectionStale(selection, selectionKeys, filterKey)

  // Capture order, NOT the toolbar's sort: that is a browse preference, and it
  // used to reach the friend's page (see features/library/selection.ts).
  const orderedSelected = useMemo(() => orderedSelection(selection), [selection])
  const selectedIds = useMemo(() => orderedSelected.map((image) => image.id), [orderedSelected])
  /** Selected RAF rows — POST /api/shares rejects them, so say so here first. */
  const unshareable = useMemo(() => unshareableSelection(selection), [selection])

  const updateSearch = useCallback(
    (patch: Partial<LibrarySearchParams>, options?: { replace?: boolean }) => {
      void navigate({ search: { ...search, ...patch }, ...(options?.replace && { replace: true }) })
    },
    [navigate, search],
  )

  // ── Selection plumbing ─────────────────────────────────────────────────────

  const commit = useCallback(
    (next: Map<number, SelectedImage>, options?: { matchesCurrentFilter?: boolean }) => {
      setSelection(next)
      setSelectionKeys((prev) =>
        nextSelectionKeys(prev, next, filterKey, options?.matchesCurrentFilter ?? false),
      )
    },
    [filterKey],
  )

  const clearSelection = useCallback(() => {
    anchorIndex.current = null
    commit(new Map())
  }, [commit])

  function toggleAt(index: number, shiftKey: boolean) {
    const image = images[index]
    if (!image) return

    const anchor = anchorIndex.current
    if (shiftKey && anchor !== null && anchor !== index) {
      const [from, to] = anchor <= index ? [anchor, index] : [index, anchor]
      commit(addToSelection(selection, images.slice(from, to + 1)))
      anchorIndex.current = index
      return
    }

    anchorIndex.current = index
    commit(
      selection.has(image.id)
        ? removeFromSelection(selection, [image.id])
        : addToSelection(selection, [image]),
    )
  }

  function selectPage() {
    commit(addToSelection(selection, images))
  }

  /**
   * Walks every page of the current filter, then merges the result into the
   * selection AS IT IS WHEN THE WALK FINISHES — a 12-request walk is long
   * enough for the owner to keep clicking tiles, and merging into the snapshot
   * taken at click time would silently drop those picks.
   */
  async function runBulk(
    merge: (all: ImageDto[], base: Map<number, SelectedImage>) => Map<number, SelectedImage>,
    messages: { loading: string; success: string; error: string },
    matchesCurrentFilter: boolean,
  ) {
    setBulkPending(true)
    try {
      const all = await notifyMutation(fetchAllMatchingImages(imagesParams), messages)
      commit(merge(all, selectionRef.current), { matchesCurrentFilter })
    } catch {
      // notifyMutation already surfaced the real server message
    } finally {
      setBulkPending(false)
    }
  }

  function selectAllMatching() {
    // NOT `matchesCurrentFilter`: anything already selected under an earlier
    // filter is still in there, so the stale-selection warning must survive.
    void runBulk(
      (all, base) => addToSelection(base, all),
      {
        loading: `Selecting ${formatNumber(total)} images…`,
        success: `${formatNumber(total)} images selected`,
        error: 'Could not select every match',
      },
      false,
    )
  }

  function keepOnlyMatching() {
    void runBulk(
      (all, base) => intersectSelection(base, new Set(all.map((image) => image.id))),
      {
        loading: 'Checking the selection against the current filter…',
        success: 'Selection narrowed to the current filter',
        error: 'Could not narrow the selection',
      },
      true,
    )
  }

  // ── Browse axis ────────────────────────────────────────────────────────────

  function selectRoot(root: LibraryRoot) {
    updateSearch({ root, dir: undefined, album: undefined, untagged: false, page: 1 })
  }

  function selectAll() {
    updateSearch({ dir: undefined, album: undefined, untagged: false, page: 1 })
    drawer.close()
  }

  function selectAlbum(path: string) {
    updateSearch({ album: path, untagged: false, dir: undefined, page: 1 })
    drawer.close()
  }

  function selectUntagged() {
    updateSearch({ untagged: true, album: undefined, dir: undefined, page: 1 })
    drawer.close()
  }

  function selectDir(root: LibraryRoot, dir: string) {
    updateSearch({ root, dir, album: undefined, untagged: false, page: 1 })
    drawer.close()
  }

  function resetFilters() {
    void navigate({ search: LibrarySearchSchema.parse({ root: search.root }) })
  }

  const axis: 'album' | 'dir' | 'none' =
    search.album !== undefined ? 'album' : search.dir !== undefined ? 'dir' : 'none'

  // `useCallback`, not a plain declaration: FilterBar debounces the filename box
  // against this, and a fresh identity every render re-runs that effect mid-debounce.
  const applyFilter = useCallback(
    (patch: FilterPatch, options?: FilterChangeOptions) => {
      updateSearch({ ...patch, page: 1 }, options)
    },
    [updateSearch],
  )

  // ── Lightbox ───────────────────────────────────────────────────────────────

  useEffect(() => {
    // Only clamp against SETTLED data. While a page turn is in flight the
    // previous page is still mounted, and stepping back from a short last page
    // parks the index at 59 on purpose — clamping to the old page's length
    // would land the viewer in the middle of the page it just left.
    if (lightboxIndex === null || query.isPlaceholderData) return
    if (images.length === 0) {
      setLightboxIndex(null)
      return
    }
    if (lightboxIndex > images.length - 1) setLightboxIndex(images.length - 1)
  }, [images.length, lightboxIndex, query.isPlaceholderData])

  // Shift-click ranges are page-local by construction, so the anchor must not
  // survive a page turn or a filter change.
  useEffect(() => {
    anchorIndex.current = null
  }, [search.page, filterKey])

  // ── Share entry points ─────────────────────────────────────────────────────

  // A live album/folder share carries root + dir/album + recursive + minRating —
  // and NOTHING else. So when a capture-date or filename filter is on, the
  // scoped share would ship a set the operator never saw a count for; the button
  // freezes the current matches into a selection share instead, and says so.
  const shareAction = shareActionOf(search)

  const shareButtonLabel =
    shareAction === null
      ? ''
      : shareAction.mode === 'scope'
        ? shareAction.source.type === 'album'
          ? 'Share this album'
          : 'Share this folder'
        : `Share these ${formatNumber(total)} images`

  /** Materialise every image matching the current filter into a selection share. */
  async function shareCurrentMatches() {
    setBulkPending(true)
    try {
      const all = await notifyMutation(fetchAllMatchingImages(imagesParams), {
        loading: `Collecting ${formatNumber(total)} images…`,
        success: `${formatNumber(total)} images ready to share`,
        error: 'Could not collect every match',
      })
      setCreateShareSource({ type: 'selection', imageIds: all.map((image) => image.id) })
    } catch {
      // notifyMutation already surfaced the real server message
    } finally {
      setBulkPending(false)
    }
  }

  const browsePanel = (
    <BrowsePanel
      root={search.root}
      dir={search.dir}
      album={search.album}
      untagged={search.untagged}
      onRootChange={selectRoot}
      onSelectAll={selectAll}
      onSelectAlbum={selectAlbum}
      onSelectUntagged={selectUntagged}
      onSelectDir={selectDir}
    />
  )

  return (
    <Stack gap="md">
      <PageActions>
        <Button size="xs" variant="default" hiddenFrom="sm" onClick={drawer.open}>
          Albums
        </Button>
      </PageActions>

      <Grid gap="md">
        <Grid.Col span={{ base: 12, sm: 4, md: 3 }} visibleFrom="sm">
          <Box
            pos="sticky"
            top={12}
            pr="sm"
            style={{ borderRight: '1px solid var(--mantine-color-default-border)' }}
          >
            <ScrollArea.Autosize mah="calc(100dvh - 160px)" type="hover">
              {browsePanel}
            </ScrollArea.Autosize>
          </Box>
        </Grid.Col>

        <Grid.Col span={{ base: 12, sm: 8, md: 9 }}>
          <Stack gap="md">
            <FilterBar
              axis={axis}
              minRating={search.minRating}
              recursive={search.recursive}
              captureFrom={search.captureFrom}
              captureTo={search.captureTo}
              stem={search.stem}
              sort={search.sort}
              order={search.order}
              onChange={applyFilter}
            />

            <Group justify="space-between" gap="xs" wrap="wrap">
              <Text size="sm" c="dimmed">
                {scopeLabel(search)} · {formatNumber(total)} image{total === 1 ? '' : 's'}
              </Text>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="light"
                  disabled={total === 0 || bulkPending}
                  loading={bulkPending}
                  onClick={selectAllMatching}
                >
                  Select all {formatNumber(total)} matching
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  disabled={images.length === 0}
                  onClick={selectPage}
                >
                  Select page
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  disabled={selection.size === 0}
                  onClick={clearSelection}
                >
                  Select none
                </Button>
                {shareAction !== null && (
                  <Button
                    size="compact-xs"
                    disabled={total === 0 || bulkPending}
                    loading={bulkPending}
                    onClick={() => {
                      if (shareAction.mode === 'scope') {
                        setCreateShareSource(shareAction.source)
                        return
                      }
                      void shareCurrentMatches()
                    }}
                  >
                    {shareButtonLabel}
                  </Button>
                )}
              </Group>
            </Group>

            {shareAction?.mode === 'snapshot' && (
              <Text size="xs" c="dimmed">
                A live album or folder share cannot carry {shareAction.dropped.join(' and ')}, so
                this button freezes exactly the {formatNumber(total)} images matching right now into
                a selection share.
              </Text>
            )}

            {selection.size > 0 && (
              <Paper withBorder p="xs">
                <Stack gap="xs">
                  <Group justify="space-between" gap="xs" wrap="wrap">
                    <Text size="sm">{formatNumber(selection.size)} selected</Text>
                    <Group gap="xs">
                      <Button size="xs" variant="default" onClick={() => setReviewOpened(true)}>
                        Review…
                      </Button>
                      <Button size="xs" variant="default" onClick={clearSelection}>
                        Clear
                      </Button>
                      <Button size="xs" onClick={() => setPublishOpened(true)}>
                        Publish to CDN…
                      </Button>
                      <Button
                        size="xs"
                        disabled={unshareable.length > 0}
                        onClick={() =>
                          setCreateShareSource({ type: 'selection', imageIds: selectedIds })
                        }
                      >
                        Create share
                      </Button>
                    </Group>
                  </Group>

                  {unshareable.length > 0 && (
                    <Alert variant="light" color="red" title="RAF originals cannot be shared">
                      <Stack gap="xs">
                        <Text size="sm">
                          {formatNumber(unshareable.length)} of these are RAW originals. A share
                          renders every image from its JPEG, so a RAF has no preview to send and the
                          server rejects it — drop them and the rest can go out.
                        </Text>
                        <Group gap="xs">
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() =>
                              commit(
                                removeFromSelection(
                                  selection,
                                  unshareable.map((image) => image.id),
                                ),
                              )
                            }
                          >
                            Remove the {formatNumber(unshareable.length)} RAF originals
                          </Button>
                        </Group>
                      </Stack>
                    </Alert>
                  )}

                  {selectionStale && (
                    <Alert variant="light" color="yellow" title="Selected outside this filter">
                      <Stack gap="xs">
                        <Text size="sm">
                          Some of these {formatNumber(selection.size)} images were picked under a
                          different filter and are not necessarily on screen. A share is created
                          from the whole selection, not from what you can see.
                        </Text>
                        <Group gap="xs">
                          <Button
                            size="xs"
                            variant="default"
                            loading={bulkPending}
                            onClick={keepOnlyMatching}
                          >
                            Keep only what matches
                          </Button>
                          <Button size="xs" variant="default" onClick={() => setReviewOpened(true)}>
                            Show me all {formatNumber(selection.size)}
                          </Button>
                        </Group>
                      </Stack>
                    </Alert>
                  )}
                </Stack>
              </Paper>
            )}

            <QueryState
              query={query}
              variant="section"
              errorTitle="Could not load images"
              empty={{
                title: 'No images match',
                description:
                  'Nothing in this album, folder or date range. Widen the capture dates, drop the rating filter, or pick another album on the left.',
                action: (
                  <Button size="xs" variant="default" onClick={resetFilters}>
                    Reset filters
                  </Button>
                ),
              }}
            >
              {() => (
                <ImageGrid
                  images={images}
                  selection={selection}
                  onToggle={toggleAt}
                  onOpen={setLightboxIndex}
                  stale={query.isPlaceholderData}
                />
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
        </Grid.Col>
      </Grid>

      <Drawer opened={drawerOpened} onClose={drawer.close} title="Browse" size="sm" padding="md">
        {browsePanel}
      </Drawer>

      <Lightbox
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        paging={{
          page: search.page,
          totalPages,
          limit: LIMIT,
          total,
          pending: query.isPlaceholderData,
          onPageChange: (page, land) => {
            updateSearch({ page })
            // Only the LAST page can be short, and 'last' is only ever asked for
            // when stepping backwards — so the previous page is always full.
            setLightboxIndex(land === 'first' ? 0 : LIMIT - 1)
          },
        }}
      />

      <SelectionModal
        opened={reviewOpened}
        onClose={() => setReviewOpened(false)}
        images={orderedSelected}
        onRemove={(id) => commit(removeFromSelection(selection, [id]))}
        onClear={() => {
          clearSelection()
          setReviewOpened(false)
        }}
      />

      <PublishModal
        imageIds={selectedIds}
        opened={publishOpened}
        onClose={() => setPublishOpened(false)}
      />

      <CreateShareModal
        opened={createShareSource !== null}
        onClose={() => setCreateShareSource(null)}
        {...(createShareSource !== null && { source: createShareSource })}
        onCreated={clearSelection}
      />
    </Stack>
  )
}
