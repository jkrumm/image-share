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
  emptyState: string
  lightboxClose: string
  lightboxPrev: string
  lightboxNext: string
  lightboxDownload: string
  lightboxDownloadRaw: string
  switcherLabel: string
  switcherHeading: string
  landingEmpty: string
  landingHeading: string
  landingLastOpened: string
  landingRemove: string
  landingOpen: string
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
    emptyState: 'No photos in this share yet.',
    lightboxClose: 'Close',
    lightboxPrev: 'Previous',
    lightboxNext: 'Next',
    lightboxDownload: 'Download this photo',
    lightboxDownloadRaw: 'Download RAW',
    switcherLabel: 'Switch share',
    switcherHeading: 'Your shares',
    landingEmpty: 'Nothing to see here.',
    landingHeading: 'Your shares',
    landingLastOpened: 'Last opened',
    landingRemove: 'Remove',
    landingOpen: 'Open',
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
    emptyState: 'Noch keine Fotos in diesem Share.',
    lightboxClose: 'Schließen',
    lightboxPrev: 'Zurück',
    lightboxNext: 'Weiter',
    lightboxDownload: 'Foto herunterladen',
    lightboxDownloadRaw: 'RAW herunterladen',
    switcherLabel: 'Share wechseln',
    switcherHeading: 'Deine Shares',
    landingEmpty: 'Hier gibt es nichts zu sehen.',
    landingHeading: 'Deine Shares',
    landingLastOpened: 'Zuletzt geöffnet',
    landingRemove: 'Entfernen',
    landingOpen: 'Öffnen',
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
    emptyState: 'Todavía no hay fotos en este share.',
    lightboxClose: 'Cerrar',
    lightboxPrev: 'Anterior',
    lightboxNext: 'Siguiente',
    lightboxDownload: 'Descargar esta foto',
    lightboxDownloadRaw: 'Descargar RAW',
    switcherLabel: 'Cambiar de share',
    switcherHeading: 'Tus shares',
    landingEmpty: 'Aquí no hay nada que ver.',
    landingHeading: 'Tus shares',
    landingLastOpened: 'Abierto por última vez',
    landingRemove: 'Eliminar',
    landingOpen: 'Abrir',
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
