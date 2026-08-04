/**
 * saved-views-repo — all DB access for the `saved_views` table (spec §15).
 * No business rules here (name/params validation, audit) — that's
 * lib/services/saved-view-service.ts's job.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { savedViews, type NewSavedView, type SavedView } from '../db/schema.ts';

/** A single owner's saved views are a small, bounded list; this bound exists so the query still explicitly carries a LIMIT (never an unbounded read). */
const LIST_LIMIT = 200;

/** List an owner's saved views, alphabetically, with a stable id tiebreaker. */
export async function listForOwner(db: DbHandle, ownerExternalId: string): Promise<SavedView[]> {
  return db
    .select()
    .from(savedViews)
    .where(eq(savedViews.ownerExternalId, ownerExternalId))
    .orderBy(asc(savedViews.name), asc(savedViews.id))
    .limit(LIST_LIMIT);
}

/** Fetch one of an owner's saved views by id. Undefined if it doesn't exist OR belongs to a different owner (never leaks existence across owners). */
export async function getForOwner(db: DbHandle, ownerExternalId: string, id: string): Promise<SavedView | undefined> {
  const [row] = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.ownerExternalId, ownerExternalId), eq(savedViews.id, id)));
  return row;
}

/** Look up an owner's saved view by name (the natural key for the unique constraint). */
export async function findByOwnerAndName(db: DbHandle, ownerExternalId: string, name: string): Promise<SavedView | undefined> {
  const [row] = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.ownerExternalId, ownerExternalId), eq(savedViews.name, name)));
  return row;
}

/** Insert a new saved_views row and return it. */
export async function create(db: DbHandle, data: NewSavedView): Promise<SavedView> {
  const [row] = await db.insert(savedViews).values(data).returning();
  if (!row) {
    throw new Error('saved-views-repo.create: insert returned no row');
  }
  return row;
}

/** Delete an owner's saved view by id. Returns the deleted row, or undefined if no row matched (wrong id OR wrong owner). */
export async function remove(db: DbHandle, ownerExternalId: string, id: string): Promise<SavedView | undefined> {
  const [row] = await db
    .delete(savedViews)
    .where(and(eq(savedViews.ownerExternalId, ownerExternalId), eq(savedViews.id, id)))
    .returning();
  return row;
}
