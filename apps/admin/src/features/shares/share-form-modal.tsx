import {
  Button,
  Checkbox,
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

const ShareFormSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Lowercase letters, digits, hyphens — must start alphanumeric'),
  // 'raws' is intentionally excluded — a raws-rooted share can never contain an
  // image (every raws row is kind='raw'; the share query requires kind='jpeg').
  root: z.enum(['library', 'uploads']),
  dir: z.string(),
  minRating: z.union([z.number().int().min(0).max(5), z.literal('')]),
  sizeLimit: z.enum(['medium', 'full']),
  includeRaws: z.boolean(),
  password: z.string(),
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

/** Coerce any root down to a shareable one — 'raws' can't back a share, so it
 * collapses to 'library' (the entry points never open this modal on raws, this
 * only keeps the type honest for edit/prefill). */
function shareableRoot(root: LibraryRoot): FormValues['root'] {
  return root === 'raws' ? 'library' : root
}

function toFormValues(share: ShareDto | undefined, initial: Props['initial']): FormValues {
  if (share) {
    return {
      slug: share.slug,
      root: shareableRoot(share.root),
      dir: share.dir,
      minRating: share.minRating ?? '',
      sizeLimit: share.sizeLimit,
      includeRaws: share.includeRaws,
      password: '',
      expiresAt: share.expiresAt ?? '',
      note: share.note ?? '',
    }
  }
  return {
    slug: '',
    root: initial ? shareableRoot(initial.root) : 'library',
    dir: initial?.dir ?? '',
    minRating: '',
    sizeLimit: 'medium',
    includeRaws: false,
    password: '',
    expiresAt: '',
    note: '',
  }
}

export function ShareFormModal({ opened, onClose, share, initial }: Props) {
  const form = useBasaltForm<FormValues>({
    initialValues: toFormValues(share, initial),
    schema: ShareFormSchema,
    // Controlled: small form, and the "include RAWs" checkbox needs to react
    // live to the sizeLimit field (uncontrolled mode wouldn't re-render on that).
    mode: 'controlled',
  })
  const createShare = useCreateShare()
  const updateShare = useUpdateShare()
  const isEdit = share !== undefined
  const pending = createShare.isPending || updateShare.isPending

  function handleSubmit(values: FormValues) {
    const body: CreateShareInput = {
      slug: values.slug,
      root: values.root,
      dir: values.dir,
      minRating: values.minRating === '' ? null : values.minRating,
      sizeLimit: values.sizeLimit,
      includeRaws: values.includeRaws,
      expiresAt: values.expiresAt === '' ? null : values.expiresAt,
      note: values.note === '' ? null : values.note,
      // Empty password on edit means "leave unchanged" — omit it entirely.
      // On create, empty means no password.
      ...(values.password !== '' ? { password: values.password } : {}),
    }

    const action = isEdit
      ? updateShare.mutateAsync({ id: share.id, ...body })
      : createShare.mutateAsync(body)

    notifyPromise(action, {
      loading: isEdit ? 'Saving share…' : 'Creating share…',
      success: isEdit ? 'Share updated' : 'Share created',
      error: isEdit ? 'Could not update share' : 'Could not create share',
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
      title={isEdit ? `Edit share — ${share.slug}` : 'Create share'}
      size="md"
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="sm">
          <FormErrorSummary form={form} />
          <TextInput
            label="Slug"
            description="share.jkrumm.com/<slug>?token=…"
            placeholder="mallorca-2026"
            disabled={isEdit}
            {...field(form, 'slug')}
          />
          <Group grow>
            <Select
              label="Root"
              data={[
                { value: 'library', label: 'Library' },
                { value: 'uploads', label: 'Uploads' },
              ]}
              allowDeselect={false}
              {...field(form, 'root')}
            />
            <TextInput label="Directory" placeholder="2026/mallorca" {...field(form, 'dir')} />
          </Group>
          <Group grow>
            <NumberInput
              label="Minimum rating"
              placeholder="Any"
              min={0}
              max={5}
              {...field(form, 'minRating')}
            />
            <Select
              label="Size limit"
              data={[
                { value: 'medium', label: 'Medium (web-sized)' },
                { value: 'full', label: 'Full (originals)' },
              ]}
              allowDeselect={false}
              {...field(form, 'sizeLimit')}
            />
          </Group>
          <Checkbox
            label="Include RAW download links (only with size limit = full)"
            disabled={form.values.sizeLimit !== 'full'}
            {...form.getInputProps('includeRaws', { type: 'checkbox' })}
          />
          <TextInput
            label={isEdit ? 'Set/replace password' : 'Password (optional)'}
            description={isEdit ? 'Leave blank to keep the current password' : undefined}
            placeholder="Leave blank for no password"
            {...field(form, 'password')}
          />
          <TextInput
            type="date"
            label="Expires"
            description="Leave blank for no expiry"
            {...field(form, 'expiresAt')}
          />
          <Textarea label="Note" placeholder="Optional note" autosize {...field(form, 'note')} />
          <Text size="xs" c="dimmed">
            Rolling or adding tokens happens after the share is created, from the shares list.
          </Text>
          <Button type="submit" loading={pending}>
            {isEdit ? 'Save changes' : 'Create share'}
          </Button>
        </Stack>
      </form>
    </Modal>
  )
}
