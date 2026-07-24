import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { env } from '../env.js'
import { mintAssetToken, verifyAssetToken } from './asset-token.js'

// Mirrors the private `sign()` helper in asset-token.ts — used here only to
// hand-construct tokens (e.g. an already-expired one) that mintAssetToken()
// can't produce on its own.
function signExp(exp: number): string {
  return createHmac('sha256', env.API_SECRET).update(`asset-token:v1:${exp}`).digest('hex')
}

describe('mintAssetToken / verifyAssetToken', () => {
  it('round-trips: a freshly minted token verifies', () => {
    const { token } = mintAssetToken()
    expect(verifyAssetToken(token)).toBe(true)
  })

  it('rejects garbage, empty, and undefined', () => {
    expect(verifyAssetToken('not-a-token')).toBe(false)
    expect(verifyAssetToken('')).toBe(false)
    expect(verifyAssetToken(undefined)).toBe(false)
    expect(verifyAssetToken(null)).toBe(false)
  })

  it('rejects a tampered signature', () => {
    const { token } = mintAssetToken()
    const [exp] = token.split('.')
    const tampered = `${exp}.${'0'.repeat(64)}`
    expect(verifyAssetToken(tampered)).toBe(false)
  })

  it('rejects a tampered exp (signature no longer matches)', () => {
    const { token } = mintAssetToken()
    const [exp, sig] = token.split('.')
    const tamperedExp = String(Number(exp) + 1000)
    expect(verifyAssetToken(`${tamperedExp}.${sig}`)).toBe(false)
  })

  it('rejects an expired token even with a correct signature', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60
    const token = `${pastExp}.${signExp(pastExp)}`
    expect(verifyAssetToken(token)).toBe(false)
  })

  it('rejects a token with the right signature but the wrong number of parts', () => {
    const { token } = mintAssetToken()
    expect(verifyAssetToken(`${token}.extra`)).toBe(false)
  })
})
