/**
 * app/_lib/reference-data.ts — read-only lookups the intake form and case
 * view need (property_refs / person_refs pickers, issue-type display names).
 *
 * ADVERSARIAL-REVIEW FOLLOW-UP (Issues UI v2, scale foundation): the raw
 * property_refs/person_refs reads that used to live here directly now go
 * through lib/repositories/reference-data-repo.ts — closing the
 * architectural gap this module's previous doc comment flagged
 * ("lib/repositories/ is outside this lane's assigned paths ... documented
 * gap: these belong in lib/repositories/ long-term"). This module is now a
 * thin re-export plus listIssueTypes/propertyLabel, which were never raw
 * reads (listIssueTypes already goes through config-repo.ts).
 */

import type { DbHandle } from '../../lib/repositories/db-handle.ts';
import type { PropertyRef } from '../../lib/db/schema.ts';
import * as configRepo from '../../lib/repositories/config-repo.ts';
import * as referenceDataRepo from '../../lib/repositories/reference-data-repo.ts';

export type { LimitedList } from '../../lib/repositories/reference-data-repo.ts';

export const listProperties = referenceDataRepo.listProperties;
export const listPeople = referenceDataRepo.listPeople;

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
