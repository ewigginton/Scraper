import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Postgres client singleton (lazy initialization).
 *
 * In production, DATABASE_URL comes from the Hub's .env.local.
 * In tests, the PGlite in-memory Postgres-in-WASM is used instead (see vitest config).
 */

let dbClient: ReturnType<typeof drizzle> | null = null;

/**
 * Demo mode (`npm run demo`, ISSUES_DEMO=1): serve from the persisted
 * PGlite database that scripts/demo-seed.ts built at .demo-db/. PGlite's
 * constructor is synchronous; queries internally await engine readiness.
 * The Hub port never uses this branch (PORTING.md) — it exists so the app
 * can be evaluated with zero database setup.
 */
function createDemoDb(): ReturnType<typeof drizzle> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PGlite } = require('@electric-sql/pglite') as typeof import('@electric-sql/pglite');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle: drizzlePglite } = require('drizzle-orm/pglite') as typeof import('drizzle-orm/pglite');
  const client = new PGlite('.demo-db');
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
