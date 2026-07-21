import { defineConfig } from 'drizzle-kit'

// SQLite dialect (bun:sqlite at runtime). `generate` needs only schema + out;
// the credentials url is used by `migrate`/`push` and points at the local dev
// database under .dev/ by default (prod uses the runtime bun:sqlite migrator in
// src/db/index.ts, not drizzle-kit).
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env['DB_FILE'] ?? '../../.dev/data/db/image-share.sqlite',
  },
})
