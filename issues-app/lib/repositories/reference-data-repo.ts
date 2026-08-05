/**
 * reference-data-repo — read-only lookups over property_refs/person_refs
 * used by pickers (the intake form) and cross-table display joins (the case
 * view, the personal work screen). No business rules here (DESIGN.md §6);
 * lifecycle/eligibility rules live in lib/services/*.
 */

import { asc, count, inArray } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { personRefs, propertyRefs, type PersonRef, type PropertyRef } from '../db/schema.ts';

const LIST_LIMIT = 500;
/** Bound on a batch id-lookup, so this can never become an unbounded read regardless of how many ids a caller passes. */
const MANY_BY_IDS_LIMIT = 1000;

export interface LimitedList<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/**
 * ADVERSARIAL-REVIEW FIX (carried over from app/_lib/reference-data.ts):
 * listProperties/listPeople used to hard-cap at LIST_LIMIT with no
 * offset/pagination and no truncation signal at all — once property_refs or
 * person_refs passes 500 rows, entries alphabetically past the 500th
 * silently become unselectable in the intake form pickers, and neither the
 * UI nor the caller could tell the list was truncated (it looks complete).
 * Full search/filter pagination is a larger UI change; this at minimum
 * returns a total count and hasMore flag so the caller can render "showing
 * 500 of N — search to narrow" instead of silently hiding the gap.
 */
export async function listProperties(db: DbHandle): Promise<LimitedList<PropertyRef>> {
  const [items, [totalRow]] = await Promise.all([
    db.select().from(propertyRefs).orderBy(asc(propertyRefs.displayName), asc(propertyRefs.id)).limit(LIST_LIMIT),
    db.select({ value: count() }).from(propertyRefs),
  ]);
  const total = totalRow?.value ?? items.length;
  return { items, total, hasMore: total > items.length };
}

export async function listPeople(db: DbHandle): Promise<LimitedList<PersonRef>> {
  const [items, [totalRow]] = await Promise.all([
    db.select().from(personRefs).orderBy(asc(personRefs.displayName), asc(personRefs.id)).limit(LIST_LIMIT),
    db.select({ value: count() }).from(personRefs),
  ]);
  const total = totalRow?.value ?? items.length;
  return { items, total, hasMore: total > items.length };
}

/** Batch property_refs lookup by id, for display-field joins (e.g. the personal work screen). Bounded via MANY_BY_IDS_LIMIT, never an unbounded read. */
export async function getPropertiesByIds(db: DbHandle, ids: string[]): Promise<PropertyRef[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(propertyRefs)
    .where(inArray(propertyRefs.id, ids.slice(0, MANY_BY_IDS_LIMIT)))
    .orderBy(asc(propertyRefs.id));
}
