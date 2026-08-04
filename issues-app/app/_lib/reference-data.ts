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

/**
 * The ONLY person_refs.contact_snapshot keys any renderer in this app is
 * allowed to display. contact_snapshot is a sync-owned read-model cache
 * with an external writer (person_refs has no RLS access_classification
 * column to restrict it, unlike evidence_files — see 20260731090200_
 * issues_rls.sql's own comment) and docs/data-dictionary.md scopes the
 * column to "Cached phone/email/address snapshot" — but nothing in code
 * enforced that shape before this allowlist existed. Without it, the day
 * the upstream sync adds an identity field to this jsonb (SSN last-4, DOB,
 * a safety/do-not-contact note), it would render instantly on every hover
 * card and person page with no review and no way for RLS to intervene —
 * exactly what requirements line 872's "unauthorized users shall not
 * receive [restricted content] through ... summaries" clause exists to
 * prevent. If contact_snapshot legitimately grows a new displayable field,
 * add it here deliberately — that is the point of an allowlist.
 */
const DISPLAYABLE_CONTACT_KEYS = ['phone', 'mobile', 'email', 'address', 'preferred_contact'] as const;

/** Shared by HoverCard.tsx's PersonHoverCard, app/people/[id]/page.tsx, and app/people/page.tsx — the ONE place all three renderers of contact_snapshot agree on what's safe to show. */
export function displayableContactEntries(snapshot: unknown): Array<[string, string]> {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return [];
  const rec = snapshot as Record<string, unknown>;
  return DISPLAYABLE_CONTACT_KEYS.flatMap((key): Array<[string, string]> => {
    const value = rec[key];
    return typeof value === 'string' && value.length > 0 ? [[key, value]] : [];
  });
}
