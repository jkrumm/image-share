// i18n catalogues (Stage 3 brief §E) — de/en/es shipped inline in every page
// response (a handful of strings) and swapped client-side with no reload and
// no server round-trip. `messagesJson()` embeds the full catalogue for
// client.ts to read; the server picks the INITIAL locale from `Accept-Language`
// (see `parseAcceptLanguage`), and the client overrides it from
// `localStorage['image-share.lang']` before first paint if the visitor
// previously chose one explicitly.

export type Locale = 'de' | 'en' | 'es'

export const LOCALES: readonly Locale[] = ['de', 'en', 'es']

export interface Messages {
  viewGroupLabel: string
  viewStream: string
  viewBento: string
  viewGrid: string
  themeGroupLabel: string
  themeLight: string
  themeDark: string
  themeSystem: string
  langGroupLabel: string
  langDe: string
  langEn: string
  langEs: string
  downloadAll: string
  downloadAllBusy: string
  /**
   * Replaces the size line while the archive is being prepared. The server
   * builds the whole ZIP before it sends anything, so a large share shows no
   * download at all for minutes — without this the page looks broken.
   */
  downloadAllWait: string
  emptyState: string
  showMore: string
  lightboxClose: string
  lightboxPrev: string
  lightboxNext: string
  lightboxLoading: string
  lightboxDownload: string
  lightboxDownloadRaw: string
  lightboxRawHint: string
  /** Screen-reader alt text; `{i}` = 1-based position, `{n}` = share total. */
  photoAlt: string
  /** Shown in the lightbox in place of the photo when it fails to decode/load. */
  lightboxLoadFailed: string
  /** Shown under "Show more photos" when a fragment fetch fails. */
  moreLoadFailed: string
  noscriptHint: string
  switcherLabel: string
  switcherHeading: string
  landingEmpty: string
  landingHeading: string
  landingLastOpened: string
  landingRemove: string
  landingOpen: string
  landingRedirect: string
  notFoundTitle: string
  notFoundBody: string
}

const MESSAGES: Record<Locale, Messages> = {
  en: {
    viewGroupLabel: 'View',
    viewStream: 'Stream view',
    viewBento: 'Bento view',
    viewGrid: 'Grid view',
    themeGroupLabel: 'Theme',
    themeLight: 'Light theme',
    themeDark: 'Dark theme',
    themeSystem: 'System theme',
    langGroupLabel: 'Language',
    langDe: 'Deutsch',
    langEn: 'English',
    langEs: 'Español',
    downloadAll: 'Download all (.zip)',
    downloadAllBusy: 'Preparing download…',
    downloadAllWait: 'Packing the archive — large shares take a few minutes. It starts on its own.',
    emptyState: 'No photos in this share yet.',
    showMore: 'Show more photos',
    lightboxClose: 'Close',
    lightboxPrev: 'Previous',
    lightboxNext: 'Next',
    lightboxLoading: 'Loading photo',
    lightboxDownload: 'Download JPEG',
    lightboxDownloadRaw: 'Download RAW',
    lightboxRawHint: 'RAW — most phones cannot open this file',
    photoAlt: 'Photo {i} of {n}',
    lightboxLoadFailed: "Couldn't load this photo.",
    moreLoadFailed: "Couldn't load more photos. Try again.",
    noscriptHint: 'JavaScript is off — open a photo with the link on its tile.',
    switcherLabel: 'Switch share',
    switcherHeading: 'Your shares',
    landingEmpty: 'Nothing to see here.',
    landingHeading: 'Your shares',
    landingLastOpened: 'Last opened',
    landingRemove: 'Remove',
    landingOpen: 'Open',
    landingRedirect: 'Opening your share…',
    notFoundTitle: 'This share does not exist or has been revoked',
    notFoundBody:
      'The link may be mistyped, the access token may have been rolled, or the share may have expired.',
  },
  de: {
    viewGroupLabel: 'Ansicht',
    viewStream: 'Stream-Ansicht',
    viewBento: 'Bento-Ansicht',
    viewGrid: 'Raster-Ansicht',
    themeGroupLabel: 'Design',
    themeLight: 'Helles Design',
    themeDark: 'Dunkles Design',
    themeSystem: 'System-Design',
    langGroupLabel: 'Sprache',
    langDe: 'Deutsch',
    langEn: 'English',
    langEs: 'Español',
    downloadAll: 'Alle herunterladen (.zip)',
    downloadAllBusy: 'Download wird vorbereitet…',
    downloadAllWait:
      'Archiv wird gepackt — bei großen Shares dauert das ein paar Minuten. Es startet von selbst.',
    emptyState: 'Noch keine Fotos in diesem Share.',
    showMore: 'Weitere Fotos anzeigen',
    lightboxClose: 'Schließen',
    lightboxPrev: 'Zurück',
    lightboxNext: 'Weiter',
    lightboxLoading: 'Foto wird geladen',
    lightboxDownload: 'JPEG herunterladen',
    lightboxDownloadRaw: 'RAW herunterladen',
    lightboxRawHint: 'RAW — die meisten Handys können diese Datei nicht öffnen',
    photoAlt: 'Foto {i} von {n}',
    lightboxLoadFailed: 'Dieses Foto konnte nicht geladen werden.',
    moreLoadFailed: 'Weitere Fotos konnten nicht geladen werden. Bitte erneut versuchen.',
    noscriptHint: 'JavaScript ist aus — öffne ein Foto über den Link auf der Kachel.',
    switcherLabel: 'Share wechseln',
    switcherHeading: 'Deine Shares',
    landingEmpty: 'Hier gibt es nichts zu sehen.',
    landingHeading: 'Deine Shares',
    landingLastOpened: 'Zuletzt geöffnet',
    landingRemove: 'Entfernen',
    landingOpen: 'Öffnen',
    landingRedirect: 'Dein Share wird geöffnet…',
    notFoundTitle: 'Dieser Share existiert nicht oder wurde widerrufen',
    notFoundBody:
      'Der Link könnte falsch sein, das Zugriffstoken wurde erneuert, oder der Share ist abgelaufen.',
  },
  es: {
    viewGroupLabel: 'Vista',
    viewStream: 'Vista de flujo',
    viewBento: 'Vista bento',
    viewGrid: 'Vista de cuadrícula',
    themeGroupLabel: 'Tema',
    themeLight: 'Tema claro',
    themeDark: 'Tema oscuro',
    themeSystem: 'Tema del sistema',
    langGroupLabel: 'Idioma',
    langDe: 'Deutsch',
    langEn: 'English',
    langEs: 'Español',
    downloadAll: 'Descargar todo (.zip)',
    downloadAllBusy: 'Preparando la descarga…',
    downloadAllWait: 'Preparando el archivo: en shares grandes tarda unos minutos. Empieza solo.',
    emptyState: 'Todavía no hay fotos en este share.',
    showMore: 'Mostrar más fotos',
    lightboxClose: 'Cerrar',
    lightboxPrev: 'Anterior',
    lightboxNext: 'Siguiente',
    lightboxLoading: 'Cargando la foto',
    lightboxDownload: 'Descargar JPEG',
    lightboxDownloadRaw: 'Descargar RAW',
    lightboxRawHint: 'RAW — la mayoría de los móviles no pueden abrir este archivo',
    photoAlt: 'Foto {i} de {n}',
    lightboxLoadFailed: 'No se pudo cargar esta foto.',
    moreLoadFailed: 'No se pudieron cargar más fotos. Inténtalo de nuevo.',
    noscriptHint: 'JavaScript está desactivado — abre una foto con el enlace de su miniatura.',
    switcherLabel: 'Cambiar de share',
    switcherHeading: 'Tus shares',
    landingEmpty: 'Aquí no hay nada que ver.',
    landingHeading: 'Tus shares',
    landingLastOpened: 'Abierto por última vez',
    landingRemove: 'Eliminar',
    landingOpen: 'Abrir',
    landingRedirect: 'Abriendo tu share…',
    notFoundTitle: 'Este share no existe o fue revocado',
    notFoundBody:
      'El enlace puede ser incorrecto, el token de acceso pudo haberse renovado, o el share pudo haber expirado.',
  },
}

export function messages(locale: Locale): Messages {
  return MESSAGES[locale]
}

/** The full catalogue, embedded client-side for reload-free language switching. */
export function allMessages(): Record<Locale, Messages> {
  return MESSAGES
}

/** Localized "N photos" label — the only string needing per-locale pluralization. */
export function photoCountLabel(locale: Locale, count: number): string {
  switch (locale) {
    case 'de':
      return count === 1 ? '1 Foto' : `${count} Fotos`
    case 'es':
      return count === 1 ? '1 foto' : `${count} fotos`
    default:
      return count === 1 ? '1 photo' : `${count} photos`
  }
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const

/**
 * Localized byte size for the ZIP/download labels ("1,9 GB" in de, "1.9 GB" in
 * en). Decimal (1000-based) units, matching what every OS file manager and
 * browser download panel shows — a friend comparing "1.9 GB" against their
 * phone's free space should see the same number.
 *
 * Mirrored by `formatBytes` in `client.ts`'s `mainScript`, which recomputes the
 * label after a language switch without a round-trip. Keep the two in step.
 */
export function formatBytes(locale: Locale, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let unit = 0
  let value = bytes
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} ${BYTE_UNITS[unit]}`
}

/** Substitute `{key}` placeholders in a catalogue string (`photoAlt`). */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  )
}

function isLocale(tag: string): tag is Locale {
  return (LOCALES as readonly string[]).includes(tag)
}

/**
 * Parse an `Accept-Language` header into one of the three supported locales
 * (design §E), highest `q` first, falling back to `en` when the header is
 * missing or matches none of them.
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return 'en'
  const entries = header
    .split(',')
    .map((part) => {
      const [rawTag, ...params] = part.trim().split(';')
      const qParam = params.find((p) => p.trim().startsWith('q='))
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1
      return { tag: (rawTag ?? '').trim().toLowerCase(), q: Number.isNaN(q) ? 1 : q }
    })
    .filter((e) => e.tag !== '')
    .toSorted((a, b) => b.q - a.q)

  for (const { tag } of entries) {
    const primary = tag.split('-')[0] ?? ''
    if (isLocale(primary)) return primary
  }
  return 'en'
}
