import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { env } from '../env.js'
import { rootBaseDir } from '../lib/paths.js'
import { attachment } from './attachment.js'
import {
  buildShareZip,
  estimateShareZipBytes,
  keepRequestAlive,
  parseRangeHeader,
  zipSpoolKey,
  zipSpoolPath,
} from './zip.js'

// Unique temp subtree under the real (dev-default) roots so buildShareZip's
// env-based path resolution finds the fixtures. Never touches real photo trees.
const SUB = `ziptest-${process.pid}-${Date.now()}`
const fujiBase = rootBaseDir('fuji')
const rawsBase = rootBaseDir('raws')

// The archive is spooled under DATA_DIR (zip.ts), so this file gets its own
// throwaway DATA_DIR — same isolation the rendition cache tests use — and every
// spool assertion below can count files without seeing the dev cache.
const originalDataDir = env.DATA_DIR
let dataDir: string

function spoolFiles(): string[] {
  try {
    return readdirSync(join(env.DATA_DIR, 'zip-spool')).toSorted()
  } catch {
    return []
  }
}

function shareOf(over: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    slug: 'trip',
    title: 'Trip',
    sourceType: 'folder',
    root: 'fuji',
    dir: SUB,
    album: null,
    recursive: true,
    minRating: null,
    expiresAt: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function imageOf(over: Partial<ImageRow> = {}): ImageRow {
  return {
    id: 10,
    root: 'fuji',
    relPath: `${SUB}/DSCF0001.JPG`,
    dir: SUB,
    stem: 'DSCF0001',
    ext: 'jpg',
    kind: 'jpeg',
    fileSize: 0,
    mtimeMs: 1,
    captureAt: '2026-06-01T00:00:00.000Z',
    orientation: 1,
    rating: 5,
    width: 4000,
    height: 3000,
    rawPath: null,
    indexedAt: '2026-06-02T00:00:00.000Z',
    keywordsIndexedAt: '2026-06-02T00:00:00.000Z',
    ...over,
  }
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ziptest-data-'))
  env.DATA_DIR = dataDir
  mkdirSync(join(fujiBase, SUB), { recursive: true })
  mkdirSync(join(rawsBase, SUB), { recursive: true })
  // Non-trivial JPEG-ish payloads (content is irrelevant to the zip container).
  writeFileSync(join(fujiBase, SUB, 'DSCF0001.JPG'), Buffer.alloc(2048, 0x11))
  writeFileSync(join(fujiBase, SUB, 'DSCF0002.JPG'), Buffer.alloc(3072, 0x22))
  writeFileSync(join(rawsBase, SUB, 'DSCF0001.RAF'), Buffer.alloc(4096, 0x33))
})

afterAll(() => {
  rmSync(join(fujiBase, SUB), { recursive: true, force: true })
  rmSync(join(rawsBase, SUB), { recursive: true, force: true })
  env.DATA_DIR = originalDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer())
}

/** Poll until `pred` holds, so a test never has to guess a build's duration. */
async function waitFor(pred: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(2)
  }
}

/** Latin1 view so ASCII filenames stored in zip headers are searchable. */
function asLatin1(buf: Uint8Array): string {
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return s
}

describe('buildShareZip (download/full roles)', () => {
  it('streams a valid non-trivial zip with a local-file-header signature', async () => {
    const share = shareOf()
    const images = [
      imageOf({ id: 10 }),
      imageOf({ id: 11, relPath: `${SUB}/DSCF0002.JPG`, stem: 'DSCF0002' }),
    ]
    const res = await buildShareZip({ share, images, role: 'download' })
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('trip.zip')
    // Content-Length is predicted up front (files on disk, sizes known).
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)

    const buf = await bytesOf(res)
    // PK\x03\x04 local file header.
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x50, 0x4b, 0x03, 0x04])
    // Larger than the two payloads → real container overhead present.
    expect(buf.length).toBeGreaterThan(2048 + 3072)
    // Both entry names (relative to the share dir) appear in the archive.
    const text = asLatin1(buf)
    expect(text).toContain('DSCF0001.JPG')
    expect(text).toContain('DSCF0002.JPG')
    // The predicted Content-Length matches the produced byte length.
    expect(buf.length).toBe(Number(res.headers.get('content-length')))
  })

  it('includes the paired RAF only for a full-role token', async () => {
    const image = imageOf({ id: 10, rawPath: `${SUB}/DSCF0001.RAF` })

    const withoutRaw = await bytesOf(
      await buildShareZip({ share: shareOf(), images: [image], role: 'download' }),
    )
    expect(asLatin1(withoutRaw)).not.toContain('DSCF0001.RAF')

    const withRaw = await bytesOf(
      await buildShareZip({ share: shareOf(), images: [image], role: 'full' }),
    )
    expect(asLatin1(withRaw)).toContain('DSCF0001.RAF')
    expect(withRaw.length).toBeGreaterThan(withoutRaw.length)
  })

  it('skips a file that is indexed but missing on disk, keeping the rest', async () => {
    // The visitor-facing failure must stay "the other photos still download",
    // never an error page — a single stale row would otherwise kill the share.
    const images = [
      imageOf({ id: 10 }),
      imageOf({ id: 12, relPath: `${SUB}/GONE.JPG`, stem: 'GONE' }),
      imageOf({ id: 11, relPath: `${SUB}/DSCF0002.JPG`, stem: 'DSCF0002' }),
    ]
    const res = await buildShareZip({ share: shareOf(), images, role: 'download' })
    expect(res.status).toBe(200)
    const text = asLatin1(await bytesOf(res))
    expect(text).toContain('DSCF0001.JPG')
    expect(text).toContain('DSCF0002.JPG')
    expect(text).not.toContain('GONE.JPG')
  })

  it('escapes the slug in Content-Disposition via the shared RFC 5987 helper', async () => {
    const res = await buildShareZip({
      share: shareOf({ slug: 'sömmer "24"' }),
      images: [imageOf()],
      role: 'download',
    })
    const cd = res.headers.get('content-disposition') ?? ''
    // The quoted-string fallback must not be terminable by the slug itself.
    expect(cd).toBe(attachment('sömmer "24".zip'))
    expect(cd).toContain('filename="s_mmer _24_.zip"')
    expect(cd).toContain("filename*=UTF-8''s%C3%B6mmer%20%2224%22.zip")
  })

  it('produces a byte length equal to the predicted content-length for a full-role zip', async () => {
    const image = imageOf({ id: 10, rawPath: `${SUB}/DSCF0001.RAF` })
    const res = await buildShareZip({ share: shareOf(), images: [image], role: 'full' })
    const buf = await bytesOf(res)
    expect(buf.length).toBe(Number(res.headers.get('content-length')))
  })
})

// The bounded-memory contract (design §7): the archive is materialized on disk
// and served as a `Bun.file`, so no part of the response is ever produced by
// JavaScript and Bun's unbounded ReadableStream sink (oven-sh/bun#32469) is
// never involved. These tests pin that property rather than the RSS number,
// which is what actually survives a refactor.
describe('buildShareZip spooling', () => {
  const share = shareOf()
  const images = [
    imageOf({ id: 10 }),
    imageOf({ id: 11, relPath: `${SUB}/DSCF0002.JPG`, stem: 'DSCF0002' }),
  ]

  it('materializes the whole archive on disk before the response exists', async () => {
    const res = await buildShareZip({ share, images, role: 'download' })
    const entries = [
      {
        name: 'DSCF0001.JPG',
        size: 2048,
        lastModified: statSync(join(fujiBase, SUB, 'DSCF0001.JPG')).mtime,
      },
      {
        name: 'DSCF0002.JPG',
        size: 3072,
        lastModified: statSync(join(fujiBase, SUB, 'DSCF0002.JPG')).mtime,
      },
    ]
    const path = zipSpoolPath(zipSpoolKey({ share, role: 'download', entries }))
    // Complete on disk already — nothing is left for a stream to produce.
    expect(statSync(path).size).toBe(Number(res.headers.get('content-length')))
    expect(statSync(path).size).toBe((await bytesOf(res)).length)
  })

  it('serves the archive from the spool even after every source file is gone', async () => {
    // The strongest available proof that the response is file-backed rather
    // than streamed out of the originals: delete the sources, then serve. If a
    // single byte still came from a `Bun.file` of a source path, this fails.
    const gone = `${SUB}-vanishing`
    mkdirSync(join(fujiBase, gone), { recursive: true })
    writeFileSync(join(fujiBase, gone, 'A.JPG'), Buffer.alloc(4096, 0x44))
    const vanishing = shareOf({ slug: 'vanishing', dir: gone })
    const rows = [imageOf({ id: 90, relPath: `${gone}/A.JPG`, dir: gone, stem: 'A' })]

    const res = await buildShareZip({ share: vanishing, images: rows, role: 'download' })
    const expectedLength = Number(res.headers.get('content-length'))
    // The body has not been touched yet. Pull the originals out from under it.
    rmSync(join(fujiBase, gone), { recursive: true, force: true })

    const buf = await bytesOf(res)
    expect(buf.length).toBe(expectedLength)
    expect(buf.length).toBeGreaterThan(4096)
    expect(asLatin1(buf)).toContain('A.JPG')
  })

  it('reuses the spool on a repeat request instead of building a second archive', async () => {
    const uniq = shareOf({ slug: 'reuse' })
    const before = spoolFiles().length
    const first = await bytesOf(await buildShareZip({ share: uniq, images, role: 'download' }))
    const afterFirst = spoolFiles()
    const second = await bytesOf(await buildShareZip({ share: uniq, images, role: 'download' }))
    expect(spoolFiles()).toEqual(afterFirst)
    expect(afterFirst.length).toBe(before + 1)
    expect(second).toEqual(first)
  })

  it('joins concurrent requests for the same archive into a single spool', async () => {
    const uniq = shareOf({ slug: 'concurrent' })
    const before = spoolFiles().length
    const [a, b, c] = await Promise.all([
      buildShareZip({ share: uniq, images, role: 'download' }).then(bytesOf),
      buildShareZip({ share: uniq, images, role: 'download' }).then(bytesOf),
      buildShareZip({ share: uniq, images, role: 'download' }).then(bytesOf),
    ])
    expect(spoolFiles().length).toBe(before + 1)
    expect(b).toEqual(a!)
    expect(c).toEqual(a!)
  })

  it('rebuilds rather than serving a stale archive when a source file changes', async () => {
    const churn = `${SUB}-churn`
    mkdirSync(join(fujiBase, churn), { recursive: true })
    writeFileSync(join(fujiBase, churn, 'B.JPG'), Buffer.alloc(1024, 0x55))
    const s = shareOf({ slug: 'churn', dir: churn })
    const rows = [imageOf({ id: 91, relPath: `${churn}/B.JPG`, dir: churn, stem: 'B' })]

    const first = await bytesOf(await buildShareZip({ share: s, images: rows, role: 'download' }))
    // Different size AND a later mtime — both are in the spool key.
    writeFileSync(join(fujiBase, churn, 'B.JPG'), Buffer.alloc(9999, 0x66))
    const second = await bytesOf(await buildShareZip({ share: s, images: rows, role: 'download' }))

    expect(second.length).not.toBe(first.length)
    rmSync(join(fujiBase, churn), { recursive: true, force: true })
  })

  it('aborts the spool on client disconnect, leaving no partial archive behind', async () => {
    const uniq = shareOf({ slug: 'aborted' })
    const before = spoolFiles()
    const ac = new AbortController()
    const pending = buildShareZip({ share: uniq, images, role: 'download', signal: ac.signal })
    // Same tick: `buildShareZip` has not passed its first `await` (the stat
    // pass), so the pre-spool guard is guaranteed to see the aborted signal and
    // no build is ever started.
    ac.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    // No published archive, and no orphaned `.part` file either.
    expect(spoolFiles()).toEqual(before)
  })

  it('rejects immediately when handed an already-aborted signal', async () => {
    const uniq = shareOf({ slug: 'pre-aborted' })
    const before = spoolFiles()
    await expect(
      buildShareZip({ share: uniq, images, role: 'download', signal: AbortSignal.abort() }),
    ).rejects.toThrow(/aborted/)
    expect(spoolFiles()).toEqual(before)
  })

  it('one visitor hanging up does not cancel an archive another is still waiting for', async () => {
    const uniq = shareOf({ slug: 'refcounted' })
    const ac = new AbortController()
    const quitter = buildShareZip({ share: uniq, images, role: 'download', signal: ac.signal })
    const stayer = buildShareZip({ share: uniq, images, role: 'download' })
    ac.abort()
    await expect(quitter).rejects.toThrow(/aborted/)
    // The surviving waiter still gets a complete, valid archive.
    const buf = await bytesOf(await stayer)
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(asLatin1(buf)).toContain('DSCF0002.JPG')
  })

  // Real `Bun.serve` round trips (not `buildShareZip` called directly), so
  // these exercise the actual wire path: `fetch` handler reads the incoming
  // `Range` header and hands it to `buildShareZip`, exactly like
  // share/routes.ts. This is deliberate — a bare, un-sliced `Bun.file(path)`
  // response would ALSO answer these correctly via Bun's own automatic
  // dispatch (that was the pre-fix behavior), so a test built on
  // `buildShareZip` output alone cannot tell "our own parsing" from "Bun's
  // unsuppressible auto-dispatch" apart. Going over a real socket is what
  // pins that the fix, not the old behavior, is what is answering.
  describe('Range request handling (every shape a client can send)', () => {
    const uniq = shareOf({ slug: 'resumable' })

    async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
      const server = Bun.serve({
        port: 0,
        fetch: async (req) =>
          await buildShareZip({
            share: uniq,
            images,
            role: 'download',
            rangeHeader: req.headers.get('range'),
          }),
      })
      try {
        await fn(server.url.toString())
      } finally {
        server.stop(true)
      }
    }

    it('normal range: 206 + correct Content-Range + correct bytes', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const res = await fetch(url, { headers: { range: 'bytes=8-23' } })
        expect(res.status).toBe(206)
        expect(res.headers.get('content-range')).toBe(`bytes 8-23/${whole.length}`)
        expect(res.headers.get('content-length')).toBe('16')
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole.slice(8, 24))
      })
    })

    it('suffix range (`-N`): last N bytes', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const res = await fetch(url, { headers: { range: 'bytes=-16' } })
        expect(res.status).toBe(206)
        const start = whole.length - 16
        expect(res.headers.get('content-range')).toBe(
          `bytes ${start}-${whole.length - 1}/${whole.length}`,
        )
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole.slice(start))
      })
    })

    it('open-ended range (`N-`): from N to the end', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const start = whole.length - 32
        const res = await fetch(url, { headers: { range: `bytes=${start}-` } })
        expect(res.status).toBe(206)
        expect(res.headers.get('content-range')).toBe(
          `bytes ${start}-${whole.length - 1}/${whole.length}`,
        )
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole.slice(start))
      })
    })

    it('reversed range (first > last): syntactically invalid, ignored — full 200 body', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const res = await fetch(url, { headers: { range: 'bytes=500-100' } })
        expect(res.status).toBe(200)
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole)
      })
    })

    it('out-of-bounds range: 416 with Content-Range: bytes */size, no body', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const total = whole.length
        const res = await fetch(url, {
          headers: { range: `bytes=${total + 1000}-${total + 2000}` },
        })
        expect(res.status).toBe(416)
        expect(res.headers.get('content-range')).toBe(`bytes */${total}`)
        expect((await res.arrayBuffer()).byteLength).toBe(0)
      })
    })

    it('absurdly large end offset: clamped to size - 1, not rejected or hung', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const res = await fetch(url, { headers: { range: 'bytes=0-99999999999999' } })
        expect(res.status).toBe(206)
        expect(res.headers.get('content-range')).toBe(`bytes 0-${whole.length - 1}/${whole.length}`)
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole)
      })
    })

    it('multi-range list: unsupported, ignored — full 200 body', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const res = await fetch(url, { headers: { range: 'bytes=0-99,200-299' } })
        expect(res.status).toBe(200)
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole)
      })
    })

    it('malformed range (non-numeric): ignored — full 200 body', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const res = await fetch(url, { headers: { range: 'bytes=abc-def' } })
        expect(res.status).toBe(200)
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole)
      })
    })

    it('malformed range (wrong unit): ignored — full 200 body', async () => {
      await withServer(async (url) => {
        const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const res = await fetch(url, { headers: { range: 'notbytes=0-10' } })
        expect(res.status).toBe(200)
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole)
      })
    })

    it('the server still answers after every shape above — the loop is not wedged', async () => {
      await withServer(async (url) => {
        const ranges = [
          'bytes=8-23',
          'bytes=-16',
          'bytes=500-100',
          'bytes=999999999-999999999999',
          'bytes=0-99999999999999',
          'bytes=0-99,200-299',
          'bytes=abc-def',
        ]
        for (const range of ranges) {
          await fetch(url, { headers: { range } })
        }
        const res = await fetch(url)
        expect(res.status).toBe(200)
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
      })
    })
  })

  it('holds flat memory serving a Range response to a consumer that stalls before reading anything', async () => {
    // The production wedge left no memory signature (ExitCode 0, not OOM), but
    // this pins the OTHER hazard a naive Range fix could reintroduce: falling
    // back to a `ReadableStream`/`.stream()` body to dodge Bun's automatic
    // dispatch, which inherits oven-sh/bun#32469 and balloons unbounded (see
    // zip.ts's header comment). A `.slice()`-backed 206 must stay
    // `sendfile`-flat exactly like the plain download path already is.
    const uniq = shareOf({ slug: 'range-slow-consumer' })
    const server = Bun.serve({
      port: 0,
      fetch: async (req) =>
        await buildShareZip({
          share: uniq,
          images,
          role: 'download',
          rangeHeader: req.headers.get('range'),
        }),
    })
    try {
      const res = await fetch(server.url, { headers: { range: 'bytes=0-' } })
      expect(res.status).toBe(206)
      const reader = res.body!.getReader()
      const baselineRss = process.memoryUsage().rss
      // Never drain the stream before checking — the response is already fully
      // available server-side (a completed spool), so any accumulation here is
      // the server buffering it into memory rather than letting the socket
      // pace it, exactly the failure mode `.stream()`/`ReadableStream` bodies
      // have on this Bun version.
      await Bun.sleep(300)
      const afterRss = process.memoryUsage().rss
      expect(afterRss - baselineRss).toBeLessThan(50 * 1024 * 1024)
      // Drain and confirm the server is still responsive afterwards.
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      const followUp = await fetch(server.url)
      expect(followUp.status).toBe(200)
      await followUp.arrayBuffer()
    } finally {
      server.stop(true)
    }
  })

  it('delivers the complete archive to a consumer that stalls mid-download', async () => {
    const uniq = shareOf({ slug: 'slow-consumer' })
    const server = Bun.serve({
      port: 0,
      fetch: async () => await buildShareZip({ share: uniq, images, role: 'download' }),
    })
    try {
      const expected = new Uint8Array(await (await fetch(server.url)).arrayBuffer())
      const res = await fetch(server.url)
      const reader = res.body!.getReader()
      const chunks: Uint8Array[] = []
      let stalled = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!stalled) {
          stalled = true
          await Bun.sleep(250)
        }
        chunks.push(value)
      }
      const got = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let at = 0
      for (const c of chunks) {
        got.set(c, at)
        at += c.byteLength
      }
      expect(got).toEqual(expected)
    } finally {
      server.stop(true)
    }
  })
})

// Everything below needs a build long enough to observe while it is running —
// the 5 KB fixtures above are done before anything can happen concurrently, and
// "what happens DURING a multi-GB spool" is the whole subject here.
describe('buildShareZip during a long build', () => {
  const BIG = `${SUB}-big`
  const CHUNK = 24 * 1024 * 1024
  const FILES = 4
  const bigImages = Array.from({ length: FILES }, (_, i) =>
    imageOf({ id: 200 + i, relPath: `${BIG}/F${i}.JPG`, dir: BIG, stem: `F${i}` }),
  )

  function bigEntries(): { name: string; size: number; lastModified: Date }[] {
    return Array.from({ length: FILES }, (_, i) => ({
      name: `F${i}.JPG`,
      size: CHUNK,
      lastModified: statSync(join(fujiBase, BIG, `F${i}.JPG`)).mtime,
    }))
  }

  beforeAll(() => {
    mkdirSync(join(fujiBase, BIG), { recursive: true })
    for (let i = 0; i < FILES; i++) {
      writeFileSync(join(fujiBase, BIG, `F${i}.JPG`), Buffer.alloc(CHUNK, i + 1))
    }
  })

  afterAll(() => {
    rmSync(join(fujiBase, BIG), { recursive: true, force: true })
  })

  it('hands the event loop back while the archive is building', async () => {
    // The spool loop has no real suspension point (page-cached reads and sink
    // flushes both settle as microtasks, CRC32 is pure CPU), so without an
    // explicit yield it drains the microtask queue for its entire duration:
    // measured over 400 MiB, a 50 ms interval ticked ZERO times. That starves
    // the container HEALTHCHECK into a restart mid-build, queues every other
    // visitor behind the archive, and makes the disconnect handling below
    // undeliverable. This is the test that pins the fix.
    const share = shareOf({ slug: 'yielding', dir: BIG })
    let ticks = 0
    const interval = setInterval(() => {
      ticks++
    }, 5)
    const started = performance.now()
    await buildShareZip({ share, images: bigImages, role: 'download' })
    const elapsed = performance.now() - started
    clearInterval(interval)

    // Premise check: a build this short would prove nothing either way.
    expect(elapsed).toBeGreaterThan(50)
    expect(ticks).toBeGreaterThan(2)
  })

  it('finishes a build its last visitor walked away from, so the retry is a cache hit', async () => {
    // Cloudflare's ~100 s origin timeout can drop the 19 GB archive's connection
    // (design §7). Aborting the build on the last waiter's exit unlinked the
    // `.part`, so the retry restarted from zero and 524'd again — forever. The
    // build now outlives the visitor and publishes.
    const share = shareOf({ slug: 'abandoned', dir: BIG })
    const spoolPath = zipSpoolPath(zipSpoolKey({ share, role: 'download', entries: bigEntries() }))
    const ac = new AbortController()
    const pending = buildShareZip({ share, images: bigImages, role: 'download', signal: ac.signal })

    // Abort strictly mid-build, not before it: the `.part` only exists while the
    // spool loop is running. That the abort is delivered at all is itself the
    // event-loop yield doing its job.
    await waitFor(() => spoolFiles().some((f) => f.endsWith('.part')), 'the spool to start')
    ac.abort()
    await expect(pending).rejects.toThrow(/aborted/)

    await waitFor(() => existsSync(spoolPath), 'the abandoned build to publish')
    expect(spoolFiles().some((f) => f.endsWith('.part'))).toBe(false)

    const retryStarted = performance.now()
    const res = await buildShareZip({ share, images: bigImages, role: 'download' })
    const retryMs = performance.now() - retryStarted
    expect(Number(res.headers.get('content-length'))).toBe(statSync(spoolPath).size)
    // A rebuild of this fixture takes hundreds of ms; a cache hit is a stat.
    expect(retryMs).toBeLessThan(50)
  })

  it('joins a build already in flight instead of starting a second one', async () => {
    // The repeat-tap case: the visitor taps again while the archive is still
    // being built. Both requests must land on the same build.
    const share = shareOf({ slug: 'rejoined', dir: BIG })
    const before = spoolFiles().length
    const first = buildShareZip({ share, images: bigImages, role: 'download' })
    await waitFor(() => spoolFiles().some((f) => f.endsWith('.part')), 'the spool to start')
    const second = buildShareZip({ share, images: bigImages, role: 'download' })

    const [a, b] = await Promise.all([first.then(bytesOf), second.then(bytesOf)])
    expect(spoolFiles().length).toBe(before + 1)
    expect(b).toEqual(a!)
  })
})

/**
 * A server whose handler produces nothing for 12 s, scaled down ~50x from
 * production (255 s re-armed every 30 s): a 2 s idle timeout and a 5 s re-arm
 * every 500 ms. The silence is more than double the re-arm, so surviving
 * REQUIRES the heartbeat to keep resetting the timer rather than having set it
 * once — and 5 s rather than something smaller because uWS's timer has a ~4 s
 * granularity, where a re-arm of 4 s or less can still be swept at the next tick.
 */
function serveSilently(keepAlive: boolean) {
  return Bun.serve({
    port: 0,
    idleTimeout: 2,
    fetch: async (request, self) => {
      const release = keepAlive
        ? keepRequestAlive({ server: self, request, intervalMs: 500, seconds: 5 })
        : () => {}
      try {
        await Bun.sleep(12_000)
      } finally {
        release()
      }
      return new Response('spooled')
    },
  })
}

describe('keepRequestAlive', () => {
  it('re-arms repeatedly at the server ceiling, and stops the moment it is released', async () => {
    const calls: number[] = []
    const release = keepRequestAlive({
      server: {
        timeout: (_request, seconds) => {
          calls.push(seconds)
        },
      },
      request: new Request('http://localhost/s/x/zip'),
      intervalMs: 5,
    })
    await Bun.sleep(60)
    release()

    // Many re-arms, all at Bun's maximum (`Bun.serve` throws above 255).
    expect(calls.length).toBeGreaterThan(2)
    expect(calls.every((seconds) => seconds === 255)).toBe(true)

    // A released heartbeat must not outlive its request — it holds a reference
    // to it, and the socket has to be allowed to die once we are done with it.
    const afterRelease = calls.length
    await Bun.sleep(30)
    expect(calls.length).toBe(afterRelease)
  })

  it('holds a request that produces no bytes open past the server idleTimeout', async () => {
    // A spooling request is silent until the archive is complete, so uWS's idle
    // timer — capped at 255 s, `Bun.serve` throws above it — would kill a
    // multi-GB build at the ORIGIN, which no tunnel setting can fix.
    // Two origins rather than two paths: Bun's fetch pools connections per
    // origin, and the control's dead socket would take the other request with it.
    const control = serveSilently(false)
    const server = serveSilently(true)
    try {
      // Both at once, so the control's ~4 s death is not added to the clock.
      const [silent, kept] = await Promise.allSettled([fetch(control.url), fetch(server.url)])
      // Control: without the heartbeat the origin drops the silent request.
      expect(silent.status).toBe('rejected')
      expect(kept.status).toBe('fulfilled')
      if (kept.status !== 'fulfilled') return
      expect(kept.value.status).toBe(200)
      expect(await kept.value.text()).toBe('spooled')
    } finally {
      control.stop(true)
      server.stop(true)
    }
  }, 30_000)
})

describe('parseRangeHeader', () => {
  const SIZE = 1000

  it('no header at all → full', () => {
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: 'full' })
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'full' })
  })

  it('a normal range', () => {
    expect(parseRangeHeader('bytes=100-200', SIZE)).toEqual({ kind: 'range', start: 100, end: 200 })
  })

  it('a suffix range (last N bytes)', () => {
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({ kind: 'range', start: 500, end: 999 })
  })

  it('a suffix range longer than the whole file clamps to byte 0', () => {
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 })
  })

  it('an open-ended range (N-) runs to the end', () => {
    expect(parseRangeHeader('bytes=500-', SIZE)).toEqual({ kind: 'range', start: 500, end: 999 })
  })

  it('a reversed range (first > last) is syntactically invalid → full, not 416', () => {
    expect(parseRangeHeader('bytes=500-100', SIZE)).toEqual({ kind: 'full' })
  })

  it('an out-of-bounds start → unsatisfiable', () => {
    expect(parseRangeHeader('bytes=1000-2000', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('an absurdly large end is clamped to size - 1, never overflows or throws', () => {
    expect(parseRangeHeader('bytes=0-99999999999999', SIZE)).toEqual({
      kind: 'range',
      start: 0,
      end: 999,
    })
  })

  it('a multi-range list is unsupported → full', () => {
    expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'full' })
  })

  it('malformed (non-numeric) → full', () => {
    expect(parseRangeHeader('bytes=abc-def', SIZE)).toEqual({ kind: 'full' })
  })

  it('wrong unit → full', () => {
    expect(parseRangeHeader('notbytes=0-10', SIZE)).toEqual({ kind: 'full' })
  })

  it('empty/bare "bytes=-" → full', () => {
    expect(parseRangeHeader('bytes=-', SIZE)).toEqual({ kind: 'full' })
  })

  it('a zero-byte file is always unsatisfiable', () => {
    expect(parseRangeHeader('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('estimateShareZipBytes', () => {
  it('uses the indexed file-size sum for a download-role share (no syscalls)', async () => {
    const bytes = await estimateShareZipBytes({
      totalFileSize: 1_900_000_000,
      role: 'download',
      // Ignored for a download role — RAFs are not in that archive.
      rawPaths: [`${SUB}/DSCF0001.RAF`],
    })
    expect(bytes).toBe(1_900_000_000)
  })

  it('adds the on-disk RAF sizes for a full-role share', async () => {
    const bytes = await estimateShareZipBytes({
      totalFileSize: 2048,
      role: 'full',
      rawPaths: [`${SUB}/DSCF0001.RAF`],
    })
    expect(bytes).toBe(2048 + 4096)
  })

  it('ignores a missing RAF rather than throwing', async () => {
    const bytes = await estimateShareZipBytes({
      totalFileSize: 2048,
      role: 'full',
      rawPaths: [`${SUB}/DSCF0001.RAF`, `${SUB}/NOPE.RAF`],
    })
    expect(bytes).toBe(2048 + 4096)
  })
})

describe('attachment', () => {
  it('sanitizes the ASCII fallback and percent-encodes the UTF-8 variant', () => {
    expect(attachment('a/b/DSCF "1".JPG')).toBe(
      `attachment; filename="DSCF _1_.JPG"; filename*=UTF-8''DSCF%20%221%22.JPG`,
    )
  })

  it('strips a directory component and any newline injection attempt', () => {
    const value = attachment('x/\r\nX-Evil: 1\r\n.jpg')
    expect(value).not.toContain('\r')
    expect(value).not.toContain('\n')
  })
})
