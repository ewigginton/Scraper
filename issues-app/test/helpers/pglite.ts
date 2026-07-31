/**
 * Test helper: spin up a fresh @electric-sql/pglite (Postgres-in-WASM)
 * instance, replay every migration under supabase/migrations/ in filename
 * (timestamp) order, and return a Drizzle handle bound to the full schema.
 *
 * Mirrors what `npm run validate` does against a real Postgres — this is
 * the only DB tests in this package ever run against (DESIGN.md §4/§9).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../lib/db/schema.ts';
import * as configRepo from '../../lib/repositories/config-repo.ts';
import type { DbHandle } from '../../lib/repositories/db-handle.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDbHandle {
  db: TestDb;
  client: PGlite;
}

/** List every *.sql file directly under supabase/migrations/, sorted by filename (timestamp) order. */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

/** Apply every migration file (in order) against the given PGlite client. */
export async function applyMigrations(client: PGlite, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = listMigrationFiles(dir);
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await client.exec(sql);
  }
  return files;
}

/**
 * Create a fresh PGlite database, replay all migrations, and return a
 * Drizzle handle over it. Clears lib/repositories/config-repo.ts's
 * process-local cache first (per that module's own doc comment) so config
 * reads in this test see THIS database's freshly-seeded rows rather than a
 * stale value cached from a previous test's PGlite instance.
 */
export async function createTestDb(): Promise<TestDbHandle> {
  configRepo.clearCache();
  const client = new PGlite();
  await applyMigrations(client);
  const db = drizzle(client, { schema });
  return { db, client };
}

/**
 * Set the session-local GUCs the RLS policies (and audit actor defaults)
 * read: app.actor_id and app.roles (see supabase/migrations/..._issues_rls.sql).
 * Takes any DbHandle (a top-level TestDb OR a `tx` inside
 * db.transaction(...)) so it can be called exactly like the production
 * helper (lib/db/actor-context.ts setActorContext) is called from
 * app/actions.ts. Uses is_local=true (see that module's doc comment), so
 * it MUST be called inside an explicit transaction to have any effect
 * beyond the single statement it runs in — see test/rls.test.ts.
 */
export async function setActorContext(db: DbHandle, actorId: string, roles: string[] = []): Promise<void> {
  await db.execute(`select set_config('app.actor_id', '${actorId.replace(/'/g, "''")}', true)`);
  await db.execute(`select set_config('app.roles', '${roles.join(',').replace(/'/g, "''")}', true)`);
}

export async function closeTestDb(handle: TestDbHandle): Promise<void> {
  await handle.client.close();
}
