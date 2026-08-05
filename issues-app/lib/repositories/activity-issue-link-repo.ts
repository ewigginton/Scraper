/**
 * activity-issue-link-repo — read-only helper for the global Activity feed
 * (roadmap "Global Activity feed", spec §29.11 "every relevant canonical
 * event shall appear on each authorized related ... Issue history"). Given
 * a bounded batch of audit_events rows, resolves each one to the `issues.id`
 * it relates to (when it relates to exactly one), so the feed page can
 * render a "view case" link.
 *
 * Resolution rule, per object_table:
 * - 'issues': the event's own object_id IS the issue id.
 * - 'holds' / 'tasks' / 'payment_requests' / 'possession_records' /
 *   'stale_acknowledgments': these tables carry a nullable-or-required
 *   issue_id column (lib/db/schema.ts) — one extra batched lookup per
 *   distinct object_table present in the page, each capped at the page
 *   size so this can never become an unbounded read.
 * - 'approvals' / 'saved_views': no direct or single-hop issue relationship
 *   (approvals point at an arbitrary object_table/object_id pair themselves,
 *   which would require unbounded recursive resolution to chase — out of
 *   scope here); these rows simply resolve to no link, matching the spec's
 *   "when object resolves to one" qualifier.
 *
 * No business rules here (DESIGN.md §6) — reads only, and never mutates.
 */

import { inArray } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { holds, tasks, paymentRequests, possessionRecords, staleAcknowledgments, issues, type AuditEvent } from '../db/schema.ts';
import { isUuid, sanitizeUuidArray } from './id-guard.ts';

/** Tables whose rows carry a single issue_id column resolvable in one batched query. */
const ISSUE_LINKED_TABLES = {
  holds,
  tasks,
  payment_requests: paymentRequests,
  possession_records: possessionRecords,
  stale_acknowledgments: staleAcknowledgments,
} as const;

export interface IssueLinkInfo {
  issueId: string;
  issueSummary: string | null;
}

/**
 * Returns a map of audit_events.id -> resolved issue link, for whichever of
 * `events` resolve to exactly one issue. Bounded to the input batch size —
 * callers pass one already-paginated page of audit_events (never the full
 * table).
 */
export async function resolveIssueLinks(db: DbHandle, events: AuditEvent[]): Promise<Map<string, IssueLinkInfo>> {
  const result = new Map<string, IssueLinkInfo>();
  if (events.length === 0) return result;

  // Direct case: object_table === 'issues', object_id IS the issue id.
  const directIssueIds = sanitizeUuidArray(events.filter((e) => e.objectTable === 'issues').map((e) => e.objectId));

  // One-hop case: batch by object_table, one query per distinct table present.
  const oneHopIssueIds = new Set<string>();
  const eventsByTable = new Map<string, AuditEvent[]>();
  for (const event of events) {
    if (event.objectTable === 'issues') continue;
    if (!(event.objectTable in ISSUE_LINKED_TABLES)) continue;
    const list = eventsByTable.get(event.objectTable) ?? [];
    list.push(event);
    eventsByTable.set(event.objectTable, list);
  }

  const rowIssueByTableAndId = new Map<string, Map<string, string | null>>();
  for (const [tableName, tableEvents] of eventsByTable) {
    const table = ISSUE_LINKED_TABLES[tableName as keyof typeof ISSUE_LINKED_TABLES];
    const ids = sanitizeUuidArray(tableEvents.map((e) => e.objectId));
    if (ids.length === 0) continue;
    const rows = await db
      .select({ id: table.id, issueId: table.issueId })
      .from(table)
      .where(inArray(table.id, ids))
      .limit(ids.length);
    const byId = new Map<string, string | null>();
    for (const row of rows) {
      byId.set(row.id, row.issueId ?? null);
      if (row.issueId) oneHopIssueIds.add(row.issueId);
    }
    rowIssueByTableAndId.set(tableName, byId);
  }

  const allIssueIds = [...new Set([...directIssueIds, ...oneHopIssueIds])].filter(isUuid);
  const summaryById = new Map<string, string | null>();
  if (allIssueIds.length > 0) {
    const issueRows = await db
      .select({ id: issues.id, summary: issues.summary })
      .from(issues)
      .where(inArray(issues.id, allIssueIds))
      .limit(allIssueIds.length);
    for (const row of issueRows) summaryById.set(row.id, row.summary ?? null);
  }

  for (const event of events) {
    if (event.objectTable === 'issues') {
      if (isUuid(event.objectId) && summaryById.has(event.objectId)) {
        result.set(event.id, { issueId: event.objectId, issueSummary: summaryById.get(event.objectId) ?? null });
      }
      continue;
    }
    const byId = rowIssueByTableAndId.get(event.objectTable);
    const issueId = byId?.get(event.objectId);
    if (issueId && summaryById.has(issueId)) {
      result.set(event.id, { issueId, issueSummary: summaryById.get(issueId) ?? null });
    }
  }

  return result;
}
