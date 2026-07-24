// Indexer scan (design §5). Walks FUJI_ROOT, RAWS_ROOT, and SHARE_ROOT;
// upserts image rows by (root, rel_path); prunes vanished files; pairs fuji
// JPEGs to their RAF. Single-flight via a module-level flag.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../db/index.js'
import { b2Objects, images, type NewImageRow } from '../db/schema.js'
import { env } from '../env.js'
import { safeJoin } from '../lib/paths.js'
import { extractMetadata, type ImageKind } from './metadata.js'

// Injectable db (mirrors lib/share-auth.ts's setShareDb / lib/s3.ts's setS3):
// production defaults to the app-wide singleton; tests inject an isolated
// `createDb(':memory:')` instance via setScanDb.
let activeDb: Db = defaultDb

export function setScanDb(database: Db): void {
  activeDb = database
}

export interface ScanRootsConfig {
  fuji: string
  raws: string
  share: string
}

// env.ts parses process.env exactly once at import time, so it can't be
// re-pointed per test file after the fact (module-load ordering across a
// multi-file `bun test` run is not deterministic enough to rely on). Roots
// are read lazily through this indirection so tests can inject temp
// directories via setScanRoots regardless of when scan.ts happened to load.
let rootsOverride: ScanRootsConfig | null = null

export function setScanRoots(roots: ScanRootsConfig | null): void {
  rootsOverride = roots
}

function getRoots(): ScanRootsConfig {
  return (
    rootsOverride ?? {
      fuji: env.FUJI_ROOT,
      raws: env.RAWS_ROOT,
      share: env.SHARE_ROOT,
    }
  )
}

export interface ScanCounts {
  scanned: number
  added: number
  updated: number
  removed: number
}

export interface IndexStatus {
  running: boolean
  startedAt: string | null
  lastFinishedAt: string | null
  lastCounts: ScanCounts | null
  lastError: string | null
}

// Single source of truth for index status, returned by GET /api/index/status
// and surfaced in /api/stats. Mutated by runScan.
const status: IndexStatus = {
  running: false,
  startedAt: null,
  lastFinishedAt: null,
  lastCounts: null,
  lastError: null,
}

/** Current indexer status snapshot (design §5). */
export function getIndexStatus(): IndexStatus {
  return { ...status }
}

type Root = 'fuji' | 'raws' | 'share'

// Extension → kind (design §5). Anything not listed here is skipped entirely
// (never written to the DB) — includes `.xmp` sidecars and `.photo` files.
// Exported so POST /api/images (ingest.ts) can validate uploads against the
// exact same recognized-extension set instead of inventing a second list.
export const EXT_KIND: Record<string, ImageKind> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'image',
  webp: 'image',
  avif: 'image',
  heic: 'image',
  raf: 'raw',
}

// Metadata reads (exifr / exiftool-vendored) run with bounded concurrency
// (design §5: "Concurrency ~8 for metadata reads").
const METADATA_CONCURRENCY = 8

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  async function lane(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await worker(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()))
}

interface DirNode {
  dirAbs: string
  dirRel: string
  entries: Dirent[]
}

/**
 * Recursively walk a directory tree, yielding one node per directory
 * (including the root) with its visible entries pre-filtered. Hidden
 * files/dirs (`.` prefix) are always skipped. A missing root directory yields
 * nothing rather than throwing.
 */
async function* walkDirs(rootAbs: string, relDir: string): AsyncGenerator<DirNode> {
  let entries: Dirent[]
  try {
    entries = await readdir(join(rootAbs, relDir), { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const visible = entries.filter((e) => !e.name.startsWith('.'))
  yield { dirAbs: join(rootAbs, relDir), dirRel: relDir, entries: visible }
  for (const entry of visible) {
    if (!entry.isDirectory()) continue
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
    yield* walkDirs(rootAbs, childRel)
  }
}

interface Candidate {
  relPath: string
  dir: string
  stem: string
  ext: string
  kind: ImageKind
  absPath: string
  sidecarAbsPath?: string
  sidecarMtimeMs?: number
}

/** Collect every recognized image file under `rootAbs`, pairing RAF sidecars
 * (`X.RAF` → `X.xmp` or `X.RAF.xmp`, same directory) along the way. */
async function collectCandidates(rootAbs: string): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for await (const node of walkDirs(rootAbs, '')) {
    const files = node.entries.filter((e) => e.isFile())
    const byLowerName = new Map(files.map((f) => [f.name.toLowerCase(), f.name]))

    for (const file of files) {
      const dotExt = extname(file.name)
      if (!dotExt) continue
      const ext = dotExt.slice(1).toLowerCase()
      const kind = EXT_KIND[ext]
      if (!kind) continue

      const stem = file.name.slice(0, file.name.length - dotExt.length)
      const relPath = node.dirRel ? `${node.dirRel}/${file.name}` : file.name
      const candidate: Candidate = {
        relPath,
        dir: node.dirRel,
        stem,
        ext,
        kind,
        absPath: join(node.dirAbs, file.name),
      }

      if (kind === 'raw') {
        const sidecarName =
          byLowerName.get(`${stem.toLowerCase()}.xmp`) ??
          byLowerName.get(`${file.name.toLowerCase()}.xmp`)
        if (sidecarName) {
          const sidecarAbsPath = join(node.dirAbs, sidecarName)
          const sidecarStat = await stat(sidecarAbsPath)
          candidate.sidecarAbsPath = sidecarAbsPath
          candidate.sidecarMtimeMs = Math.trunc(sidecarStat.mtimeMs)
        }
      }

      candidates.push(candidate)
    }
  }
  return candidates
}

/** Reconcile one root against the DB: upsert changed/new files, skip
 * unchanged ones (no metadata re-read), and prune vanished ones. Mutates
 * `counts` in place so all three roots accumulate into one ScanCounts. */
async function scanRoot(root: Root, rootAbs: string, counts: ScanCounts): Promise<void> {
  const candidates = await collectCandidates(rootAbs)

  const existingRows = await activeDb.select().from(images).where(eq(images.root, root))
  const existingByRelPath = new Map(existingRows.map((row) => [row.relPath, row]))
  const seen = new Set<string>()

  await runWithConcurrency(candidates, METADATA_CONCURRENCY, async (candidate) => {
    const fileStat = await stat(candidate.absPath)
    const fileSize = fileStat.size
    const mtimeMs = Math.trunc(fileStat.mtimeMs)
    seen.add(candidate.relPath)
    counts.scanned++

    const existing = existingByRelPath.get(candidate.relPath)
    const sidecarIsNewer =
      existing !== undefined &&
      candidate.sidecarMtimeMs !== undefined &&
      candidate.sidecarMtimeMs > new Date(existing.indexedAt).getTime()
    const unchanged =
      existing !== undefined &&
      existing.fileSize === fileSize &&
      existing.mtimeMs === mtimeMs &&
      !sidecarIsNewer
    if (unchanged) return

    const metadata = await extractMetadata({
      absPath: candidate.absPath,
      kind: candidate.kind,
      sidecarPath: candidate.sidecarAbsPath,
      mtimeMs,
    })

    const values: NewImageRow = {
      root,
      relPath: candidate.relPath,
      dir: candidate.dir,
      stem: candidate.stem,
      ext: candidate.ext,
      kind: candidate.kind,
      fileSize,
      mtimeMs,
      captureAt: metadata.captureAt,
      orientation: metadata.orientation,
      rating: metadata.rating,
      width: metadata.width,
      height: metadata.height,
      rawPath: existing?.rawPath ?? null,
      indexedAt: new Date().toISOString(),
    }

    if (existing) {
      await activeDb.update(images).set(values).where(eq(images.id, existing.id))
      counts.updated++
    } else {
      await activeDb.insert(images).values(values)
      counts.added++
    }
  })

  const vanished = existingRows.filter((row) => !seen.has(row.relPath))
  if (vanished.length > 0) {
    const vanishedIds = vanished.map((row) => row.id)
    // Detach any published B2 mirror rows first. `b2_objects.published_image_id`
    // is an FK to images.id with ON DELETE NO ACTION (foreign_keys=ON), so
    // deleting a still-referenced image throws 'FOREIGN KEY constraint failed'
    // and aborts the entire prune batch (and the rest of the scan). Nulling the
    // link keeps the mirror row as an out-of-band object — exactly the nullable
    // semantics design §4/§8 document for published_image_id.
    await activeDb
      .update(b2Objects)
      .set({ publishedImageId: null })
      .where(inArray(b2Objects.publishedImageId, vanishedIds))
    await activeDb.delete(images).where(inArray(images.id, vanishedIds))
    counts.removed += vanished.length
  }
}

/** Pair every `fuji` JPEG to its RAF by stem (design §5) — RAWS_ROOT is a
 * flat tree, so pairing ignores directory and matches on stem only. Clears
 * `raw_path` when a previously-paired RAF has vanished. */
async function pairRawFiles(): Promise<void> {
  const rawRows = await activeDb
    .select({ stem: images.stem, relPath: images.relPath })
    .from(images)
    .where(eq(images.root, 'raws'))
  const rawPathByStem = new Map<string, string>()
  for (const row of rawRows) {
    if (!rawPathByStem.has(row.stem)) rawPathByStem.set(row.stem, row.relPath)
  }

  const jpegRows = await activeDb
    .select({ id: images.id, stem: images.stem, rawPath: images.rawPath })
    .from(images)
    .where(and(eq(images.root, 'fuji'), eq(images.kind, 'jpeg')))

  for (const row of jpegRows) {
    const pairedRawPath = rawPathByStem.get(row.stem) ?? null
    if (pairedRawPath !== row.rawPath) {
      await activeDb.update(images).set({ rawPath: pairedRawPath }).where(eq(images.id, row.id))
    }
  }
}

// The roots a scan actually walks. Any images row carrying a different `root`
// is an orphan from a retired root (e.g. the pre-rework 'library' root) and is
// purged by pruneRetiredRoots below.
const KNOWN_ROOTS = ['fuji', 'raws', 'share'] as const

/**
 * Purge rows whose `root` is no longer a configured root. scanRoot only prunes
 * WITHIN each scanned root (its `existingRows` is filtered to that root), so a
 * root rename leaves orphaned rows that no scan pass ever visits — and their
 * now-invalid `root` value breaks response-schema validation on the library
 * reads. Detaches dependent b2_objects.published_image_id first (the FK is
 * ON DELETE NO ACTION under foreign_keys=ON), mirroring scanRoot's own
 * vanished-prune. Predicate-based (no id list) so a full stale index of any
 * size deletes in one statement, clear of SQLite's bound-variable limit.
 */
async function pruneRetiredRoots(counts: ScanCounts): Promise<void> {
  const retiredImageIds = activeDb
    .select({ id: images.id })
    .from(images)
    .where(notInArray(images.root, KNOWN_ROOTS as unknown as string[]))
  await activeDb
    .update(b2Objects)
    .set({ publishedImageId: null })
    .where(inArray(b2Objects.publishedImageId, retiredImageIds))
  const removed = await activeDb
    .delete(images)
    .where(notInArray(images.root, KNOWN_ROOTS as unknown as string[]))
    .returning({ id: images.id })
  counts.removed += removed.length
}

/**
 * Run a full reconcile scan across all roots. Single-flight: a concurrent call
 * while `running` returns the last completed counts without starting a second
 * pass (the /api/index/rescan route surfaces `alreadyRunning` via
 * GET /api/index/status.running).
 */
export async function runScan(): Promise<ScanCounts> {
  if (status.running) {
    return status.lastCounts ?? { scanned: 0, added: 0, updated: 0, removed: 0 }
  }

  status.running = true
  status.startedAt = new Date().toISOString()
  status.lastError = null
  const counts: ScanCounts = { scanned: 0, added: 0, updated: 0, removed: 0 }

  try {
    const roots = getRoots()
    await scanRoot('fuji', roots.fuji, counts)
    await scanRoot('raws', roots.raws, counts)
    await scanRoot('share', roots.share, counts)
    await pruneRetiredRoots(counts)
    await pairRawFiles()
    status.lastCounts = counts
    status.lastFinishedAt = new Date().toISOString()
    return counts
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    status.running = false
  }
}

/**
 * Index (or re-index) a single file immediately after an upload and return its
 * image id — used by POST /api/images (design §8). `relPath` is validated
 * against SHARE_ROOT via safeJoin (design §3 hard rule) before touching disk.
 */
export async function indexSinglePath(input: { root: 'share'; relPath: string }): Promise<number> {
  const absPath = safeJoin(getRoots().share, input.relPath)
  const fileName = basename(input.relPath)
  const dotExt = extname(fileName)
  const ext = dotExt.slice(1).toLowerCase()
  const kind = EXT_KIND[ext]
  if (!kind) throw new Error(`indexSinglePath: unsupported file extension ".${ext}"`)

  const fileStat = await stat(absPath)
  const mtimeMs = Math.trunc(fileStat.mtimeMs)
  const stem = fileName.slice(0, fileName.length - dotExt.length)
  const rawDir = dirname(input.relPath)
  const dir = rawDir === '.' ? '' : rawDir

  const metadata = await extractMetadata({ absPath, kind, mtimeMs })

  const values: NewImageRow = {
    root: 'share',
    relPath: input.relPath,
    dir,
    stem,
    ext,
    kind,
    fileSize: fileStat.size,
    mtimeMs,
    captureAt: metadata.captureAt,
    orientation: metadata.orientation,
    rating: metadata.rating,
    width: metadata.width,
    height: metadata.height,
    rawPath: null,
    indexedAt: new Date().toISOString(),
  }

  const [row] = await activeDb
    .insert(images)
    .values(values)
    .onConflictDoUpdate({ target: [images.root, images.relPath], set: values })
    .returning({ id: images.id })
  if (!row) throw new Error('indexSinglePath: insert returned no row')
  return row.id
}
