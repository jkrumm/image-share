import { describe, expect, it } from 'bun:test'
import { allMessages, LOCALES, messages, parseAcceptLanguage, photoCountLabel } from './i18n.js'

describe('parseAcceptLanguage', () => {
  it('defaults to en when the header is missing or empty', () => {
    expect(parseAcceptLanguage(null)).toBe('en')
    expect(parseAcceptLanguage(undefined)).toBe('en')
    expect(parseAcceptLanguage('')).toBe('en')
  })

  it('picks a bare supported primary subtag', () => {
    expect(parseAcceptLanguage('de')).toBe('de')
    expect(parseAcceptLanguage('es')).toBe('es')
  })

  it('matches a regional subtag to its primary language', () => {
    expect(parseAcceptLanguage('de-DE')).toBe('de')
    expect(parseAcceptLanguage('en-US')).toBe('en')
  })

  it('honors q-value ordering, highest first', () => {
    expect(parseAcceptLanguage('fr;q=0.9, de;q=0.8, en;q=0.5')).toBe('de')
    expect(parseAcceptLanguage('en;q=0.3, es;q=0.9')).toBe('es')
  })

  it('falls back to en when no listed language is supported', () => {
    expect(parseAcceptLanguage('fr-FR, it-IT, ja-JP')).toBe('en')
  })

  it('skips unsupported languages ahead of a supported one in the list', () => {
    expect(parseAcceptLanguage('fr-FR;q=1, de;q=0.9')).toBe('de')
  })
})

describe('photoCountLabel', () => {
  it('pluralizes per locale', () => {
    expect(photoCountLabel('en', 1)).toBe('1 photo')
    expect(photoCountLabel('en', 2)).toBe('2 photos')
    expect(photoCountLabel('de', 1)).toBe('1 Foto')
    expect(photoCountLabel('de', 3)).toBe('3 Fotos')
    expect(photoCountLabel('es', 1)).toBe('1 foto')
    expect(photoCountLabel('es', 5)).toBe('5 fotos')
  })
})

describe('messages / allMessages', () => {
  it('has a complete catalogue for every supported locale', () => {
    const all = allMessages()
    for (const locale of LOCALES) {
      const m = messages(locale)
      expect(all[locale]).toBe(m)
      expect(Object.values(m).every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
    }
  })
})
