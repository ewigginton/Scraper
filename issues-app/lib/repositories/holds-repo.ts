/**
 * holds-repo — all DB access for the `holds` table. No business rules
 * (e.g. whether a hold type blocks release) live here — that is
 * lib/services/eligibility-service.ts's job (DESIGN.md hard rule #1).
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { holds, type Hold, type NewHold } from '../db/schema.ts';

/** Active holds (released_at IS NULL) for a property. */
export async function activeForProperty(db: DbHandle, propertyRefId: string): Promise<Hold[]> {
  return db
    .select()
    .from(holds)
    .where(and(eq(holds.propertyRefId, propertyRefId), isNull(holds.releasedAt)));
}

/** Active holds (released_at IS NULL) originated from a given issue. */
export async function activeForIssue(db: DbHandle, issueId: string): Promise<Hold[]> {
  return db
    .select()
    .from(holds)
    .where(and(eq(holds.issueId, issueId), isNull(holds.releasedAt)));
}

/** Insert a new hold row and return it. */
export async function apply(db: DbHandle, data: NewHold): Promise<Hold> {
  const [row] = await db.insert(holds).values(data).returning();
  if (!row) {
    throw new Error('holds-repo.apply: insert returned no row');
  }
  return row;
}

/**
 * Release a hold: sets released_at/released_by/release_reason. The
 * `holds_release_documented_check` DB constraint requires releasedBy and
 * releaseReason whenever releasedAt is set — this function always supplies
 * all three together so it can never violate that constraint.
 */
export async function release(
  db: DbHandle,
  id: string,
  releasedBy: string,
  releaseReason: string,
  releasedAt: Date = new Date(),
): Promise<Hold | undefined> {
  const [row] = await db
    .update(holds)
    .set({ releasedAt, releasedBy, releaseReason })
    .where(eq(holds.id, id))
    .returning();
  return row;
}
