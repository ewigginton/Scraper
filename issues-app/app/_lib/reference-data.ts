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

import { asc } from 'drizzle-orm';
import type { DbHandle } from '../../lib/repositories/db-handle.ts';
import { personRefs, propertyRefs, type PersonRef, type PropertyRef } from '../../lib/db/schema.ts';
import * as configRepo from '../../lib/repositories/config-repo.ts';

const LIST_LIMIT = 500;

export async function listProperties(db: DbHandle): Promise<PropertyRef[]> {
  return db.select().from(propertyRefs).orderBy(asc(propertyRefs.displayName)).limit(LIST_LIMIT);
}

export async function listPeople(db: DbHandle): Promise<PersonRef[]> {
  return db.select().from(personRefs).orderBy(asc(personRefs.displayName)).limit(LIST_LIMIT);
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
