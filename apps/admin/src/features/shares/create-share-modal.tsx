import { Modal, Select, Stack, Text, TextInput, Textarea, Button, Group } from '@mantine/core'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { field, FormErrorSummary, useBasaltForm } from 'basalt-ui/forms'
import { notifyPromise } from 'basalt-ui/notifications'
import { z } from 'zod'
import { libraryQueries } from '../../lib/queries/library'
import {
  useCreateShare,
  type CreateShareInput,
  type ShareDto,
  type ShareRoot,
  type ShareSourceInput,
} from '../../lib/queries/shares'

// Replaces share-form-modal.tsx (design §12 rework): creation asks the
// minimum — title + note — because the caller already knows what's being
// shared. `source` is fixed by the two Library-page entry points (selection /
// folder); it's left undefined only for the Shares list's "New share" action,
// which has no ambient folder context and shows a root/dir picker instead.
export type CreateShareModalSource =
  | { type: 'selection'; imageIds: number[] }
  | { type: 'folder'; root: ShareRoot; dir: string; minRating: number | null }

/** Mirrors the server's deriveSlugBase (design §8) for the read-only preview. */
function deriveSlugPreview(title: string): string {
  const collapsed = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const truncated = collapsed.slice(0, 64).replace(/-+$/g, '')
  return truncated.length > 0 ? truncated : 'share'
}

function folderSourceLabel(root: ShareRoot, dir: string): string {
  return dir ? `${root}/${dir}` : root
}

const CreateShareFormSchema = z.object({
  title: z.string().min(1, 'Required'),
  note: z.string(),
  root: z.enum(['fuji', 'share']),
  dir: z.string(),
})

type FormValues = z.infer<typeof CreateShareFormSchema>

type Props = {
  opened: boolean
  onClose: () => void
  source?: CreateShareModalSource
  /** Fired after a successful create, before navigation — the Library page
   * uses this to clear its selection state. */
  onCreated?: (share: ShareDto) => void
}

/** A folder source's live, always-recursive count (folder shares are
 * unconditionally recursive server-side, design §7) — fetched fresh here so
 * the summary is accurate regardless of the Library page's own "include
 * subfolders" view toggle. */
function useFolderSummary(source: CreateShareModalSource | undefined) {
  const folder = source?.type === 'folder' ? source : undefined
  const { data } = useQuery({
    ...libraryQueries.images({
      root: folder?.root,
      dir: folder?.dir,
      recursive: true,
      minRating: folder?.minRating ?? undefined,
      page: 1,
      limit: 1,
    }),
    enabled: folder !== undefined,
  })
  if (!folder) return undefined
  const total = data?.total
  const ratingPart = folder.minRating ? ` · ${folder.minRating}★ and up` : ''
  const countPart = total === undefined ? '…' : `${total} image${total === 1 ? '' : 's'}`
  return `Folder ${folderSourceLabel(folder.root, folder.dir)} (incl. subfolders) · ${countPart}${ratingPart}`
}

export function CreateShareModal({ opened, onClose, source, onCreated }: Props) {
  const navigate = useNavigate()
  const createShare = useCreateShare()
  const folderSummary = useFolderSummary(source)

  const form = useBasaltForm<FormValues>({
    initialValues: { title: '', note: '', root: 'fuji', dir: '' },
    schema: CreateShareFormSchema,
    mode: 'controlled',
  })

  function handleClose() {
    form.reset()
    onClose()
  }

  function handleSubmit(values: FormValues) {
    const resolvedSource: ShareSourceInput = source ?? {
      type: 'folder',
      root: values.root,
      dir: values.dir,
      minRating: null,
    }

    const body: CreateShareInput = {
      title: values.title,
      note: values.note === '' ? null : values.note,
      source: resolvedSource,
    }

    void notifyPromise(createShare.mutateAsync(body), {
      loading: 'Creating share…',
      success: 'Share created',
      error: 'Could not create share',
    })
      .then((share) => {
        onCreated?.(share)
        handleClose()
        void navigate({ to: '/shares/$id', params: { id: String(share.id) } })
      })
      .catch(() => {
        /* toast already shown by notifyPromise */
      })
  }

  const slugPreview = deriveSlugPreview(form.values.title)

  return (
    <Modal opened={opened} onClose={handleClose} title="Create share" size="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="sm">
          <FormErrorSummary form={form} />

          {source?.type === 'selection' && (
            <Text size="sm" c="dimmed">
              {source.imageIds.length} selected image{source.imageIds.length === 1 ? '' : 's'}
            </Text>
          )}
          {source?.type === 'folder' && folderSummary && (
            <Text size="sm" c="dimmed">
              {folderSummary}
            </Text>
          )}

          {source === undefined && (
            <Group grow>
              <Select
                label="Root"
                data={[
                  { value: 'fuji', label: 'Fuji' },
                  { value: 'share', label: 'Share' },
                ]}
                allowDeselect={false}
                {...field(form, 'root')}
              />
              <TextInput label="Directory" placeholder="2026/mallorca" {...field(form, 'dir')} />
            </Group>
          )}

          <TextInput
            label="Title"
            placeholder="Mallorca 2026"
            autoFocus
            description={form.values.title !== '' ? `share.jkrumm.com/${slugPreview}` : undefined}
            {...field(form, 'title')}
          />
          <Textarea
            label="Note"
            placeholder="Optional note — markdown is supported"
            autosize
            minRows={2}
            {...field(form, 'note')}
          />

          <Button type="submit" loading={createShare.isPending}>
            Create share
          </Button>
        </Stack>
      </form>
    </Modal>
  )
}
