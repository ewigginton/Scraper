/**
 * phase-instances-repo — DB access for the `phase_instances` table beyond
 * what issues-repo already covers via issue-scoped joins. No business rules
 * here (DESIGN.md §6) — phase transition legality lives in
 * lib/services/transition-engine.ts.
 */

import { asc, inArray } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { phaseInstances, type PhaseInstance } from '../db/schema.ts';

/** Bound on a batch id-lookup, so this can never become an unbounded read regardless of how many ids a caller passes. */
const MANY_BY_IDS_LIMIT = 1000;

/** Batch phase_instances lookup by id, for display-field joins (e.g. the personal work screen's per-issue current stage). */
export async function getManyByIds(db: DbHandle, ids: string[]): Promise<PhaseInstance[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(phaseInstances)
    .where(inArray(phaseInstances.id, ids.slice(0, MANY_BY_IDS_LIMIT)))
    .orderBy(asc(phaseInstances.id));
}
