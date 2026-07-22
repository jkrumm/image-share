import { describe, expect, it } from 'bun:test'
import { env } from '../env.js'
import { cdnOriginalUrl, cdnThumbUrl } from './cdn.js'

describe('cdn url helpers', () => {
  it('cdnOriginalUrl strips the img/ prefix and emits the short form', () => {
    expect(cdnOriginalUrl('img/fuji/sunset.jpg')).toBe(`${env.CDN_BASE}/fuji/sunset.jpg`)
  })

  it('cdnOriginalUrl leaves a key untouched if it lacks the prefix', () => {
    expect(cdnOriginalUrl('misc/already-bare.jpg')).toBe(`${env.CDN_BASE}/misc/already-bare.jpg`)
  })

  it('cdnThumbUrl inserts an rs:fit processing-options segment before the key', () => {
    expect(cdnThumbUrl('img/fuji/sunset.jpg', 480)).toBe(
      `${env.CDN_BASE}/rs:fit:480/fuji/sunset.jpg`,
    )
  })
})
