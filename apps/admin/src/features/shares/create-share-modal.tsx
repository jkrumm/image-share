import {
  Checkbox,
  Group,
  Modal,
  Rating,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Button,
  Input,
} from '@mantine/core'
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
  | { type: 'folder'; root: ShareRoot; dir: string; recursive: boolean; minRating: number | null }

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
  // Picker mode only (no ambient folder context). Mirrors the Library page's
  // own controls: a Checkbox for subfolders, Mantine `Rating` for minRating
  // (0 = no filter), so both surfaces read identically.
  recursive: z.boolean(),
  minRating: z.number().int().min(0).max(5),
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

type FolderScope = { root: ShareRoot; dir: string; recursive: boolean; minRating: number | null }

/** A folder scope's live count, computed with the SAME root/dir/recursion/
 * rating scope the share will be created with — and the same `kind='jpeg'`
 * restriction folderShareImageFilter applies (design §7) — so the summary
 * matches what the share will actually contain. Used by BOTH entry points:
 * the Library page's fixed folder source and the picker's live form values. */
function useFolderSummary(folder: FolderScope | undefined) {
  const { data } = useQuery({
    ...libraryQueries.images({
      root: folder?.root,
      dir: folder?.dir,
      kind: 'jpeg',
      recursive: folder?.recursive ?? false,
      minRating: folder?.minRating ?? undefined,
      page: 1,
      limit: 1,
    }),
    enabled: folder !== undefined,
  })
  if (!folder) return undefined
  const total = data?.total
  const ratingPart = folder.minRating ? ` · ${folder.minRating}★ and up` : ''
  const scopePart = folder.recursive ? ' (incl. subfolders)' : ' (this folder only)'
  const countPart = total === undefined ? '…' : `${total} image${total === 1 ? '' : 's'}`
  return {
    total,
    label: `Folder ${folderSourceLabel(folder.root, folder.dir)}${scopePart} · ${countPart}${ratingPart}`,
  }
}

export function CreateShareModal({ opened, onClose, source, onCreated }: Props) {
  const navigate = useNavigate()
  const createShare = useCreateShare()

  const form = useBasaltForm<FormValues>({
    initialValues: { title: '', note: '', root: 'fuji', dir: '', recursive: true, minRating: 0 },
    schema: CreateShareFormSchema,
    mode: 'controlled',
  })

  // Picker mode has no ambient folder context, so the scope comes from the live
  // form values — the owner sets root/dir/recursive/rating blind otherwise and
  // routinely mints an empty share (mistyped dir, over-tight rating).
  const folderScope: FolderScope | undefined =
    source?.type === 'folder'
      ? source
      : source === undefined
        ? {
            root: form.values.root,
            dir: form.values.dir,
            recursive: form.values.recursive,
            minRating: form.values.minRating === 0 ? null : form.values.minRating,
          }
        : undefined
  const folderSummary = useFolderSummary(folderScope)

  function handleClose() {
    form.reset()
    onClose()
  }

  function handleSubmit(values: FormValues) {
    const resolvedSource: ShareSourceInput = source ?? {
      type: 'folder',
      root: values.root,
      dir: values.dir,
      recursive: values.recursive,
      minRating: values.minRating === 0 ? null : values.minRating,
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
              {folderSummary.label}
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

          {source === undefined && (
            <Group gap="lg" align="flex-end">
              <Input.Wrapper label="Minimum rating" description="Empty stars = no filter">
                <div>
                  <Rating
                    value={form.values.minRating}
                    onChange={(v) => form.setFieldValue('minRating', v)}
                  />
                </div>
              </Input.Wrapper>
              <Checkbox
                label="Include subfolders"
                checked={form.values.recursive}
                onChange={(e) => form.setFieldValue('recursive', e.currentTarget.checked)}
              />
            </Group>
          )}

          {source === undefined && folderSummary && (
            <Text size="sm" c={folderSummary.total === 0 ? 'red' : 'dimmed'}>
              {folderSummary.total === 0
                ? `No images match ${folderSummary.label} — check the directory path, subfolder toggle and rating.`
                : folderSummary.label}
            </Text>
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

          <Button
            type="submit"
            loading={createShare.isPending}
            disabled={folderSummary?.total === 0}
          >
            Create share
          </Button>
        </Stack>
      </form>
    </Modal>
  )
}
