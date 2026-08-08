import {
  Alert,
  Box,
  Button,
  Collapse,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { useQuery } from '@tanstack/react-query'
import { QueryState } from '../common'
import { libraryQueries, type AlbumNode, type LibraryRoot } from '../../lib/queries/library'
import { AlbumTree } from './album-tree'
import { DirTree } from './dir-tree'

const ROOT_OPTIONS: { value: LibraryRoot; label: string }[] = [
  { value: 'fuji', label: 'Fuji' },
  { value: 'share', label: 'Share' },
  { value: 'raws', label: 'RAWs' },
]

type Props = {
  root: LibraryRoot
  dir: string | undefined
  album: string | undefined
  untagged: boolean
  onRootChange: (root: LibraryRoot) => void
  onSelectAll: () => void
  onSelectAlbum: (path: string) => void
  onSelectUntagged: () => void
  onSelectDir: (root: LibraryRoot, dir: string) => void
}

/**
 * The browse rail: root picker, then the Lightroom keyword tree as the primary
 * axis with the directory tree demoted behind a toggle (design §3.1 — the Fuji
 * tree is one flat directory, so folders are a fallback, not a hierarchy).
 */
export function BrowsePanel({
  root,
  dir,
  album,
  untagged,
  onRootChange,
  onSelectAll,
  onSelectAlbum,
  onSelectUntagged,
  onSelectDir,
}: Props) {
  const [foldersOpened, folders] = useDisclosure(false)
  const albumsQuery = useQuery(libraryQueries.albums(root))

  return (
    <Stack gap="sm">
      <SegmentedControl
        fullWidth
        size="xs"
        data={ROOT_OPTIONS}
        value={root}
        onChange={(value) => onRootChange(value as LibraryRoot)}
      />

      {root === 'raws' ? (
        <Alert variant="light" color="gray" title="RAWs have no albums">
          <Text size="xs">
            Keywords live in the JPEGs, and a RAF has no rendition — browse by folder below, or
            switch back to Fuji.
          </Text>
        </Alert>
      ) : (
        <QueryState
          query={albumsQuery}
          variant="section"
          errorTitle="Could not load albums"
          loading={
            <Stack gap={4}>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={`album-skeleton-${i}`} h={30} radius="sm" />
              ))}
            </Stack>
          }
          isEmpty={() => false}
        >
          {(data) => (
            <AlbumTree
              albums={data.data as AlbumNode[]}
              album={album}
              untagged={untagged}
              onSelectAlbum={onSelectAlbum}
              onSelectUntagged={onSelectUntagged}
              onSelectAll={onSelectAll}
            />
          )}
        </QueryState>
      )}

      <Box>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={folders.toggle}
          aria-expanded={foldersOpened}
        >
          {foldersOpened ? '▾' : '▸'} Folders
        </Button>
        <Collapse expanded={foldersOpened}>
          <Box pt="xs">
            {foldersOpened && <DirTree root={root} dir={dir} onSelect={onSelectDir} />}
          </Box>
        </Collapse>
      </Box>
    </Stack>
  )
}
