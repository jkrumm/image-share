import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core'
import { field, FormErrorSummary, useBasaltForm } from 'basalt-ui/forms'
import { notifyPromise } from 'basalt-ui/notifications'
import { z } from 'zod'
import type { LibraryRoot } from '../../lib/queries/library'
import {
  useCreateShare,
  useUpdateShare,
  type CreateShareInput,
  type ShareDto,
} from '../../lib/queries/shares'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// This modal only creates/edits FOLDER shares (Stage 2 wires up
// selection-share creation from a multi-select in the Library grid). 'raws' is
// excluded — a raws-rooted share can never contain an image (every raws row
// is kind='raw'; the share query requires kind='jpeg').
const ShareFormSchema = z.object({
  slug: z.union([z.string().regex(SLUG_RE, 'Lowercase letters, digits, hyphens'), z.literal('')]),
  title: z.string().min(1, 'Required'),
  root: z.enum(['fuji', 'share']),
  dir: z.string(),
  minRating: z.union([z.number().int().min(0).max(5), z.literal('')]),
  expiresAt: z.string(),
  note: z.string(),
})

type FormValues = z.infer<typeof ShareFormSchema>

type Props = {
  opened: boolean
  onClose: () => void
  /** Present in edit mode; omitted (undefined) creates a new share. */
  share?: ShareDto
  /** Prefill for the "create share from this folder" flow off the Library page. */
  initial?: { root: LibraryRoot; dir: string }
}

/** Coerce any root down to a shareable one — 'raws' can't back a folder
 * share, so it collapses to 'fuji' (the entry points never open this modal on
 * raws, this only keeps the type honest for edit/prefill). */
function shareableRoot(root: LibraryRoot): FormValues['root'] {
  return root === 'raws' ? 'fuji' : root
}

function toFormValues(share: ShareDto | undefined, initial: Props['initial']): FormValues {
  if (share) {
    return {
      slug: share.slug,
      title: share.title,
      root: share.root ? shareableRoot(share.root) : 'fuji',
      dir: share.dir ?? '',
      minRating: share.minRating ?? '',
      expiresAt: share.expiresAt ?? '',
      note: share.note ?? '',
    }
  }
  return {
    slug: '',
    title: '',
    root: initial ? shareableRoot(initial.root) : 'fuji',
    dir: initial?.dir ?? '',
    minRating: '',
    expiresAt: '',
    note: '',
  }
}

export function ShareFormModal({ opened, onClose, share, initial }: Props) {
  const form = useBasaltForm<FormValues>({
    initialValues: toFormValues(share, initial),
    schema: ShareFormSchema,
    mode: 'controlled',
  })
  const createShare = useCreateShare()
  const updateShare = useUpdateShare()
  const isEdit = share !== undefined
  const pending = createShare.isPending || updateShare.isPending

  function handleSubmit(values: FormValues) {
    if (isEdit) {
      void notifyPromise(
        updateShare.mutateAsync({
          id: share.id,
          title: values.title,
          minRating: values.minRating === '' ? null : values.minRating,
          expiresAt: values.expiresAt === '' ? null : values.expiresAt,
          note: values.note === '' ? null : values.note,
        }),
        {
          loading: 'Saving share…',
          success: 'Share updated',
          error: 'Could not update share',
        },
      )
        .then(() => {
          form.reset()
          onClose()
        })
        .catch(() => {
          /* toast already shown by notifyPromise */
        })
      return
    }

    const body: CreateShareInput = {
      ...(values.slug !== '' ? { slug: values.slug } : {}),
      title: values.title,
      expiresAt: values.expiresAt === '' ? null : values.expiresAt,
      note: values.note === '' ? null : values.note,
      source: {
        type: 'folder',
        root: values.root,
        dir: values.dir,
        minRating: values.minRating === '' ? null : values.minRating,
      },
    }

    void notifyPromise(createShare.mutateAsync(body), {
      loading: 'Creating share…',
      success: 'Share created',
      error: 'Could not create share',
    })
      .then(() => {
        form.reset()
        onClose()
      })
      .catch(() => {
        /* toast already shown by notifyPromise */
      })
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isEdit ? `Edit share — ${share.title}` : 'Create share'}
      size="md"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="sm">
          <FormErrorSummary form={form} />
          <TextInput label="Title" placeholder="Mallorca 2026" {...field(form, 'title')} />
          <TextInput
            label="Slug"
            description="share.jkrumm.com/<slug>?token=… — auto-derived from the title if left blank"
            placeholder="mallorca-2026"
            disabled={isEdit}
            {...field(form, 'slug')}
          />
          <Group grow>
            <Select
              label="Root"
              data={[
                { value: 'fuji', label: 'Fuji' },
                { value: 'share', label: 'Share' },
              ]}
              allowDeselect={false}
              disabled={isEdit}
              {...field(form, 'root')}
            />
            <TextInput
              label="Directory"
              placeholder="2026/mallorca"
              disabled={isEdit}
              {...field(form, 'dir')}
            />
          </Group>
          <NumberInput
            label="Minimum rating"
            placeholder="Any"
            min={0}
            max={5}
            {...field(form, 'minRating')}
          />
          <TextInput
            type="date"
            label="Expires"
            description="Leave blank for no expiry"
            {...field(form, 'expiresAt')}
          />
          <Textarea label="Note" placeholder="Optional note" autosize {...field(form, 'note')} />
          <Text size="xs" c="dimmed">
            Tokens (view/download/full) are managed after the share is created, from the shares
            list.
          </Text>
          <Button type="submit" loading={pending}>
            {isEdit ? 'Save changes' : 'Create share'}
          </Button>
        </Stack>
      </form>
    </Modal>
  )
}
