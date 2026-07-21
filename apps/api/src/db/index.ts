import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema.js'
import { env } from '../env.js'

export type Db = BunSQLiteDatabase<typeof schema>

// Resolve the migrations folder relative to THIS source file so it works
// regardless of the process CWD (local dev runs from repo root; the container's
// CMD runs from /app). Mirrors argo's runMigrations resolution.
const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = join(moduleDir, '../../drizzle')

/**
 * Open a bun:sqlite database + drizzle wrapper. WAL mode and foreign keys are
 * enabled on open. Pass `:memory:` (or a temp path) from tests for an isolated
 * database; production uses the default file under DATA_DIR.
 */
export function createDb(dbPath: string): { db: Db; sqlite: Database } {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const sqlite = new Database(dbPath, { create: true })
  // WAL: concurrent readers during a rescan write; foreign_keys: enforce the
  // share_tokens → shares / b2_objects → images references.
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/**
 * Apply all committed drizzle migrations to `database`. Synchronous
 * (bun:sqlite). Idempotent — drizzle tracks applied migrations in its journal
 * table. Tests call this against a `:memory:` db after `createDb(':memory:')`.
 */
export function runMigrations(database: Db = db): void {
  migrate(database, { migrationsFolder })
}

// Default production/runtime database: DATA_DIR/db/image-share.sqlite.
const defaultDbPath = join(env.DATA_DIR, 'db', 'image-share.sqlite')

const { db, sqlite } = createDb(defaultDbPath)

export { db, sqlite }
