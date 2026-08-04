/**
 * dashboard-repo — bounded, single-pass GROUP BY aggregates for the
 * General Issues dashboard (spec §8.2: "open issues by type/stage/state/
 * coordinator, open/past-due tasks by coordinator, aging, bottlenecks,
 * off-market properties") and the §13 data-quality/exception queue.
 *
 * No business rules here (DESIGN.md §6) — every function is a read-only
 * GROUP BY / COUNT over issues/tasks/holds/audit_events. Nothing here
 * loops per-row in application code: every count is computed by Postgres.
 *
 * Every list-shaped export takes/returns a bounded row set (LIMIT) and
 * every group-by export is bounded by construction (a small fixed enum, or
 * GROUP BY + ORDER BY + LIMIT). See exceptions-repo.ts for the §13 queue
 * queries, which follow the same convention.
 */

import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { holds, issues, propertyRefs, tasks, type HoldType, type IssueType, type LifecycleStatus } from '../db/schema.ts';

const MAX_GROUP_ROWS = 200;

// ---------------------------------------------------------------------
// Open issues by type / by lifecycle status / by state / by coordinator-or-queue
// ---------------------------------------------------------------------

export interface CountRow {
  key: string;
  count: number;
}

/** Open (lifecycle_status <> 'closed') issue counts grouped by issue_type. Bounded: issue_type is a 5-value CHECK enum. */
export async function openIssuesByType(db: DbHandle): Promise<CountRow[]> {
  const rows = await db
    .select({ key: issues.issueType, count: count() })
    .from(issues)
    .where(sql`${issues.lifecycleStatus} <> 'closed'`)
    .groupBy(issues.issueType)
    .orderBy(desc(count()))
    .limit(MAX_GROUP_ROWS);
  return rows.map((r) => ({ key: r.key, count: r.count }));
}

/** Open issue counts grouped by lifecycle_status (includes 'closed' itself so the bar set is the full lifecycle picture, not just "open"). Bounded: 7-value CHECK enum. */
export async function issuesByLifecycleStatus(db: DbHandle): Promise<CountRow[]> {
  const rows = await db
    .select({ key: issues.lifecycleStatus, count: count() })
    .from(issues)
    .groupBy(issues.lifecycleStatus)
    .orderBy(desc(count()))
    .limit(MAX_GROUP_ROWS);
  return rows.map((r) => ({ key: r.key, count: r.count }));
}

/** Open issue counts grouped by property state (property_refs.state — nullable, coalesced to 'Unknown'). Bounded to MAX_GROUP_ROWS distinct states, worst-case-then-safe for a runaway data-quality import. */
export async function openIssuesByState(db: DbHandle): Promise<CountRow[]> {
  const stateExpr = sql<string>`coalesce(${propertyRefs.state}, 'Unknown')`;
  const rows = await db
    .select({ key: stateExpr, count: count() })
    .from(issues)
    .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
    .where(sql`${issues.lifecycleStatus} <> 'closed'`)
    .groupBy(stateExpr)
    .orderBy(desc(count()))
    .limit(MAX_GROUP_ROWS);
  return rows;
}

/** Open issue counts grouped by coordinator_id (falls back to queue when no coordinator is set, then 'Unassigned') — matches issues-query-repo's single coordinatorOrQueue filter control. Bounded to MAX_GROUP_ROWS distinct owners. */
export async function openIssuesByCoordinatorOrQueue(db: DbHandle): Promise<CountRow[]> {
  const ownerExpr = sql<string>`coalesce(${issues.coordinatorId}, ${issues.queue}, 'Unassigned')`;
  const rows = await db
    .select({ key: ownerExpr, count: count() })
    .from(issues)
    .where(sql`${issues.lifecycleStatus} <> 'closed'`)
    .groupBy(ownerExpr)
    .orderBy(desc(count()))
    .limit(MAX_GROUP_ROWS);
  return rows;
}

// ---------------------------------------------------------------------
// Overdue task counts by coordinator (assignee, falling back to queue)
// ---------------------------------------------------------------------

/** Open/in_progress tasks whose due_date has passed, grouped by assignee (falls back to queue, then 'Unassigned'). Bounded to MAX_GROUP_ROWS distinct owners. */
export async function overdueTaskCountsByCoordinator(db: DbHandle, today?: string): Promise<CountRow[]> {
  const todayValue = today ?? new Date().toISOString().slice(0, 10);
  const ownerExpr = sql<string>`coalesce(${tasks.assigneeId}, ${tasks.queue}, 'Unassigned')`;
  const rows = await db
    .select({ key: ownerExpr, count: count() })
    .from(tasks)
    .where(and(sql`${tasks.status} in ('open', 'in_progress')`, sql`${tasks.dueDate} is not null`, sql`${tasks.dueDate} < ${todayValue}`))
    .groupBy(ownerExpr)
    .orderBy(desc(count()))
    .limit(MAX_GROUP_ROWS);
  return rows;
}

// ---------------------------------------------------------------------
// Aging buckets of open issues (days since created)
// ---------------------------------------------------------------------

export type AgingBucketKey = '0-7' | '8-30' | '31-90' | '90+';

export const AGING_BUCKETS: AgingBucketKey[] = ['0-7', '8-30', '31-90', '90+'];

/**
 * Open (lifecycle_status <> 'closed') issue counts bucketed by days since
 * created_at, computed entirely in the aggregate query (a single CASE
 * expression fed into GROUP BY) — never a per-row date diff in application
 * code. Always returns all four buckets (count 0 included) so the caller
 * can render a stable bar set without checking for missing keys.
 */
export async function agingBucketsOfOpenIssues(db: DbHandle, today?: string): Promise<Record<AgingBucketKey, number>> {
  const todayValue = today ?? new Date().toISOString().slice(0, 10);
  const ageDays = sql<number>`extract(day from (${todayValue}::timestamptz - ${issues.createdAt}))`;
  const bucketExpr = sql<string>`case
    when ${ageDays} <= 7 then '0-7'
    when ${ageDays} <= 30 then '8-30'
    when ${ageDays} <= 90 then '31-90'
    else '90+'
  end`;
  const rows = await db
    .select({ key: bucketExpr, count: count() })
    .from(issues)
    .where(sql`${issues.lifecycleStatus} <> 'closed'`)
    .groupBy(bucketExpr);

  const result: Record<AgingBucketKey, number> = { '0-7': 0, '8-30': 0, '31-90': 0, '90+': 0 };
  for (const row of rows) {
    if (row.key === '0-7' || row.key === '8-30' || row.key === '31-90' || row.key === '90+') {
      result[row.key] = row.count;
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// Off-market signal: active holds by hold type
// ---------------------------------------------------------------------

/** Count of DISTINCT properties with at least one active hold (released_at IS NULL), grouped by hold_type — spec §8.2 "off-market properties". A property with two active holds of the same type counts once for that type; distinct-by-property, not distinct-by-hold-row. Bounded: hold_type is a 10-value CHECK enum. */
export async function activeHoldPropertyCountsByType(db: DbHandle): Promise<CountRow[]> {
  const rows = await db
    .select({ key: holds.holdType, count: sql<number>`count(distinct ${holds.propertyRefId})`.mapWith(Number) })
    .from(holds)
    .where(isNull(holds.releasedAt))
    .groupBy(holds.holdType)
    .orderBy(desc(sql`count(distinct ${holds.propertyRefId})`))
    .limit(MAX_GROUP_ROWS);
  return rows.map((r) => ({ key: r.key, count: r.count }));
}

/** Total distinct properties with at least one active hold — the dashboard's single off-market headline number, computed by the same WHERE clause as activeHoldPropertyCountsByType (never derived by summing that grouped result, which would double-count a property carrying two hold types). */
export async function activeHoldPropertyCount(db: DbHandle): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(distinct ${holds.propertyRefId})`.mapWith(Number) })
    .from(holds)
    .where(isNull(holds.releasedAt));
  return row?.value ?? 0;
}

export type { HoldType, IssueType, LifecycleStatus };
