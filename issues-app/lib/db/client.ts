import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Postgres client singleton (lazy initialization).
 *
 * In production, DATABASE_URL comes from the Hub's .env.local.
 * In tests, the PGlite in-memory Postgres-in-WASM is used instead (see vitest config).
 */

let dbClient: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!dbClient) {
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
