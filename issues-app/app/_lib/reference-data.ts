/**
 * app/_lib/reference-data.ts — read-only lookups the intake form and case
 * view need (property_refs / person_refs pickers, issue-type display names)
 * that no repository in lib/repositories/ currently exposes (issues-repo
 * only fetches a property/person by way of an issue; there is no
 * list-properties/list-people repo function). lib/repositories/ is outside
 * this lane's assigned paths, so these stay here as thin, business-rule-free
 * reads (select + order by) rather than being added there. Documented gap:
 * these belong in lib/repositories/ long-term.
 */

import { asc, count } from 'drizzle-orm';
import type { DbHandle } from '../../lib/repositories/db-handle.ts';
import { personRefs, propertyRefs, type PersonRef, type PropertyRef } from '../../lib/db/schema.ts';
import * as configRepo from '../../lib/repositories/config-repo.ts';

const LIST_LIMIT = 500;

/**
 * ADVERSARIAL-REVIEW FIX: listProperties/listPeople used to hard-cap at
 * LIST_LIMIT with no offset/pagination and no truncation signal at all —
 * once property_refs or person_refs passes 500 rows, entries alphabetically
 * past the 500th silently become unselectable in the intake form pickers,
 * and neither the UI nor the caller could tell the list was truncated (it
 * looks complete). Full search/filter pagination is a larger UI change;
 * this at minimum returns a total count and hasMore flag so the caller can
 * render "showing 500 of N — search to narrow" instead of silently hiding
 * the gap.
 */
export interface LimitedList<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export async function listProperties(db: DbHandle): Promise<LimitedList<PropertyRef>> {
  const [items, [totalRow]] = await Promise.all([
    db.select().from(propertyRefs).orderBy(asc(propertyRefs.displayName)).limit(LIST_LIMIT),
    db.select({ value: count() }).from(propertyRefs),
  ]);
  const total = totalRow?.value ?? items.length;
  return { items, total, hasMore: total > items.length };
}

export async function listPeople(db: DbHandle): Promise<LimitedList<PersonRef>> {
  const [items, [totalRow]] = await Promise.all([
    db.select().from(personRefs).orderBy(asc(personRefs.displayName)).limit(LIST_LIMIT),
    db.select({ value: count() }).from(personRefs),
  ]);
  const total = totalRow?.value ?? items.length;
  return { items, total, hasMore: total > items.length };
}

export interface IssueTypeConfig {
  display_name: string;
  description?: string;
  phases: string[];
}

/** Issue-type display names + phase lists from config_entries('phase_1_defaults','issue_types'), spec §4/§12. */
export async function listIssueTypes(db: DbHandle): Promise<Array<{ key: string; config: IssueTypeConfig }>> {
  const entry = await configRepo.get<Record<string, IssueTypeConfig>>(db, 'phase_1_defaults', 'issue_types');
  if (!entry) return [];
  return Object.entries(entry).map(([key, config]) => ({ key, config }));
}

export function propertyLabel(property: PropertyRef | undefined | null): string {
  if (!property) return 'Unknown property';
  const parts = [property.displayName, property.development, property.tract].filter(Boolean);
  return parts.length > 0 ? String(parts[0]) : property.id;
}
