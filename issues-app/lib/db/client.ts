import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Postgres client singleton (lazy initialization).
 *
 * In production, DATABASE_URL comes from the Hub's .env.local.
 * In tests, the PGlite in-memory Postgres-in-WASM is used instead (see vitest config).
 */

let dbClient: ReturnType<typeof drizzle> | null = null;

const DEMO_DIR = '.demo-db';

/**
 * Written by scripts/demo-seed.ts as the very last step, only after every
 * migration and every fixture insert has committed successfully. Its
 * presence is the only reliable signal that .demo-db/ is a complete,
 * migrated database rather than a directory PGlite happened to create —
 * PGlite's constructor creates the on-disk directory structure on first use
 * regardless of whether anything has been migrated/seeded into it, so
 * "the directory exists" is NOT evidence the database is usable.
 */
const DEMO_SEED_SENTINEL = join(DEMO_DIR, '.seed-complete');

/**
 * Demo mode (`npm run demo`, ISSUES_DEMO=1): serve from the persisted
 * PGlite database that scripts/demo-seed.ts built at .demo-db/. PGlite's
 * constructor is synchronous; queries internally await engine readiness.
 * The Hub port never uses this branch (PORTING.md) — it exists so the app
 * can be evaluated with zero database setup.
 *
 * Throws (synchronously, before ever opening PGlite) when .demo-db/ is
 * missing or was never fully seeded, instead of silently opening/creating
 * an empty, unmigrated PGlite directory — the prior behavior, which made
 * every route 500 with a raw "relation does not exist" error on first
 * query instead of the app's graceful DatabaseUnavailable empty state, and
 * left a broken .demo-db/ on disk that `npm run demo` (without --fresh)
 * would then treat as "already seeded" on every subsequent run. This throw
 * is caught by app/_lib/db.ts's tryGetDb()/requireDb(), the same as the
 * missing-DATABASE_URL case.
 */
function createDemoDb(): ReturnType<typeof drizzle> {
  if (!existsSync(DEMO_SEED_SENTINEL)) {
    throw new Error(
      `Demo database at ${DEMO_DIR}/ is missing or was never fully seeded (no ${DEMO_SEED_SENTINEL} sentinel found). Run \`npm run demo\` to build it (or \`npm run demo -- --fresh\` to rebuild from scratch if ${DEMO_DIR}/ already exists but is broken).`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PGlite } = require('@electric-sql/pglite') as typeof import('@electric-sql/pglite');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle: drizzlePglite } = require('drizzle-orm/pglite') as typeof import('drizzle-orm/pglite');
  const client = new PGlite(DEMO_DIR);
  return drizzlePglite(client) as unknown as ReturnType<typeof drizzle>;
}

export function getDb() {
  if (!dbClient) {
    if (process.env.ISSUES_DEMO === '1') {
      dbClient = createDemoDb();
      return dbClient;
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    const client = postgres(databaseUrl);
    dbClient = drizzle(client);
  }
  return dbClient;
}

export const db = (): ReturnType<typeof drizzle> => getDb();
