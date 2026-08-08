import { z } from 'zod'
import type { ShareDetailDto, ShareSourceInput, UpdateShareInput } from '../../lib/queries/shares'

// The two share forms' schemas and their pure value→payload translations.
// Extracted from the modal/route components because these are exactly the
// places where the count preview and the created share can drift apart.

// ── Create ───────────────────────────────────────────────────────────────────

/** Mirrors the server's deriveSlugBase (design §8) for the read-only preview. */
export function deriveSlugPreview(title: string): string {
  const collapsed = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const truncated = collapsed.slice(0, 64).replace(/-+$/g, '')
  return truncated.length > 0 ? truncated : 'share'
}

export const CreateShareFormSchema = z.object({
  title: z.string().min(1, 'Required'),
  note: z.string(),
  // ── Picker mode only (no ambient source) ───────────────────────────────────
  // Album first: the Fuji tree is one flat directory, so "folder" can only ever
  // offer the whole root — the keyword hierarchy is the axis that has structure.
  scope: z.enum(['album', 'folder']),
  root: z.enum(['fuji', 'share']),
  album: z.string(),
  dir: z.string(),
  recursive: z.boolean(),
  minRating: z.number().int().min(0).max(5),
  // ── Links ─────────────────────────────────────────────────────────────────
  role: z.enum(['view', 'download', 'full']),
  secondLink: z.boolean(),
  secondRole: z.enum(['view', 'download', 'full']),
  secondLabel: z.string(),
})

export type CreateShareFormValues = z.infer<typeof CreateShareFormSchema>

export const CREATE_SHARE_INITIAL_VALUES: CreateShareFormValues = {
  title: '',
  note: '',
  scope: 'album',
  root: 'fuji',
  album: '',
  dir: '',
  recursive: true,
  minRating: 0,
  role: 'view',
  secondLink: false,
  secondRole: 'full',
  secondLabel: '',
}

/**
 * The ONE resolved source, used verbatim by both the count preview and the POST
 * body. Anything assembled twice is a place where the preview and the share can
 * disagree, which is the invariant the create modal exists to protect.
 *
 * `ambient` is the source the Library page's entry points fix (a selection, the
 * folder or the album currently browsed); when it is absent the modal shows a
 * picker and the form values are the scope. Returns null when nothing is picked
 * yet — an empty album means "every tagged image" server-side and is rejected by
 * POST /api/shares, so it is not a scope.
 */
export function resolveShareSource(
  values: Pick<
    CreateShareFormValues,
    'scope' | 'root' | 'album' | 'dir' | 'recursive' | 'minRating'
  >,
  ambient?: ShareSourceInput,
): ShareSourceInput | null {
  if (ambient) return ambient
  const { scope, root, album, dir, recursive, minRating } = values
  const rating = minRating === 0 ? null : minRating
  if (scope === 'album') {
    return album === '' ? null : { type: 'album', root, album, recursive, minRating: rating }
  }
  return { type: 'folder', root, dir, recursive, minRating: rating }
}

/** The subset of `scope-preview.ts`'s `ScopePreview` the submit guard reads. */
export interface SharePreviewState {
  /** Images the share will contain — `undefined` whenever that is UNKNOWN. */
  total: number | undefined
  /** The count on screen was computed for the source about to be POSTed. */
  fresh: boolean
}

/**
 * Whether "Create share" must stay disabled.
 *
 * The invariant (scope-preview.ts): a share can never be minted against a scope
 * the operator never saw a count for. `fresh === false` (a keystroke debounce
 * still settling) is only ONE way for that to happen — the other is
 * `total === undefined`, which is the entire time the preview request is in
 * flight or retrying, and it stays undefined once the retries are exhausted and
 * the "Could not verify the image count" alert is showing. Testing staleness
 * alone therefore left submit enabled on exactly the run where the operator was
 * told the count is unknowable, which is the one case the rule was written for.
 *
 * Kept here, pure, rather than inline in the modal: the hook it reads from
 * cannot be imported by a test (it pulls in the Eden client, which touches
 * `window` at load — design §13).
 */
export function isCreateShareBlocked(
  source: ShareSourceInput | null,
  preview: SharePreviewState,
): boolean {
  if (source === null) return true
  if (source.type === 'selection') return source.imageIds.length === 0
  if (!preview.fresh) return true
  return preview.total === undefined || preview.total === 0
}

// ── Settings (share detail) ──────────────────────────────────────────────────

export const SettingsFormSchema = z.object({
  note: z.string(),
  expiresAt: z.string(),
  minRating: z.number().int().min(0).max(5),
  recursive: z.boolean(),
})

export type SettingsFormValues = z.infer<typeof SettingsFormSchema>

export function settingsInitialValues(
  share: Pick<ShareDetailDto, 'note' | 'expiresAt' | 'minRating' | 'recursive'>,
): SettingsFormValues {
  return {
    note: share.note ?? '',
    expiresAt: share.expiresAt ?? '',
    minRating: share.minRating ?? 0,
    recursive: share.recursive,
  }
}

/**
 * The PATCH body for the settings form. `minRating` and `recursive` are folder-
 * AND album-scope fields; PATCH rejects both only on a selection share, so they
 * are omitted there rather than sent and 400'd.
 */
export function toUpdateSharePatch(
  share: Pick<ShareDetailDto, 'id' | 'sourceType'>,
  values: SettingsFormValues,
): UpdateShareInput {
  const scoped = share.sourceType !== 'selection'
  return {
    id: share.id,
    note: values.note === '' ? null : values.note,
    expiresAt: values.expiresAt === '' ? null : values.expiresAt,
    ...(scoped
      ? {
          // 0 is "no filter", same as the create modal — storing a literal 0
          // would mean `rating >= 0`, which drops every unrated image.
          minRating: values.minRating === 0 ? null : values.minRating,
          recursive: values.recursive,
        }
      : {}),
  }
}

/**
 * Human-readable scope line for a resolved source, e.g.
 * `Album fuji/Ereignisse|Segeln 25 (incl. sub-albums)`. Reads the SAME object
 * the count preview and the POST body are built from, so the sentence on screen
 * cannot describe a different share than the one that gets created.
 */
export function shareScopeLabel(source: ShareSourceInput): string {
  if (source.type === 'selection') return 'Selected images'
  const rating = source.minRating ? ` · ${source.minRating}★ and up` : ''
  if (source.type === 'album') {
    const depth = source.recursive ? ' (incl. sub-albums)' : ' (this album only)'
    return `Album ${source.root}/${source.album}${depth}${rating}`
  }
  const where = source.dir ? `${source.root}/${source.dir}` : source.root
  const depth = source.recursive ? ' (incl. subfolders)' : ' (this folder only)'
  return `Folder ${where}${depth}${rating}`
}
