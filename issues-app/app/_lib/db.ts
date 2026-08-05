/**
 * app/_lib/db.ts — thin availability guard around lib/db/client.ts, scoped to
 * the UI layer so screens can render a friendly empty state instead of
 * crashing the build/render when DATABASE_URL isn't set (task brief:
 * "graceful empty states ... don't crash the build"). Does not modify
 * lib/db/client.ts (out of this lane's assigned paths); getDb() there is
 * already lazy, so calling it here only throws at request time, never at
 * module-import/build time.
 */

import { getDb } from '../../lib/db/client.ts';
import type { DbHandle } from '../../lib/repositories/db-handle.ts';

/** Returns the shared DB handle, or null if DATABASE_URL is not configured. */
export function tryGetDb(): DbHandle | null {
  try {
    return getDb() as unknown as DbHandle;
  } catch {
    return null;
  }
}

/** Throws a clear error if DATABASE_URL is missing; use in server actions (a missing DB there is a real failure, not a renderable empty state). */
export function requireDb(): DbHandle {
  const db = tryGetDb();
  if (!db) {
    throw new Error('DATABASE_URL is not configured. Copy .env.example to .env.local and set it before submitting this form.');
  }
  return db;
}
