/**
 * exceptions-repo — bounded aggregate + row queries for the §13
 * alerts/exception-reporting/data-quality dashboard ("ownership, age,
 * reason, and next action — not simply red flags"). Every queue here is a
 * COUNT (or count(distinct ...)) computed by Postgres plus a capped row
 * list (ORDER BY + LIMIT) — never an unbounded read scanned in application
 * code. No business rules live here (DESIGN.md §6): these are read-only
 * data-quality signals, not enforcement (nothing here blocks a transition
 * or writes anything — see lib/services/transition-engine.ts for the
 * actual `gates_release`/eligibility enforcement this module's
 * "ready-to-release-shaped" queue is a read-only echo of).
 *
 * Scope decisions (spec §13 names each flag but not its exact SQL shape):
 * - "active non-passive issues" is read literally as
 *   lifecycle_status = 'active' (excludes 'passive_wait', which is
 *   deliberately dormant pending a wake_event/review_date, and 'closed').
 * - Stale-case and short-summary queues exclude 'closed' and 'passive_wait'
 *   for the same reason — a passive-wait issue not seeing activity for two
 *   weeks is by design, not a data-quality gap.
 * - "Ready to relist but not released/closed" is operationalized as: the
 *   issue's OPEN/IN_PROGRESS current phase_instance's phase_key is one a
 *   config transition definition names as the `from_phase` of a
 *   `gates_release: true` edge (supabase/migrations/
 *   20260731090600_issues_config_v2_transitions.sql) — i.e. the phase whose
 *   very next step IS the release — AND the property carries an active
 *   hold older than the configurable N-day window (default 14). This
 *   duplicates the literal phase-key set as a runtime allowlist rather than
 *   reading config_versions at request time, same convention as
 *   issues-query-repo.ts's VALID_ISSUE_TYPES (a fixed, hand-verified
 *   mirror of the DB's real values, not a live introspection).
 */

import { count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { issues, propertyRefs, tasks, type Issue, type PropertyRef, type Task } from '../db/schema.ts';
import { businessTodayIso } from '../date/business-today.ts';

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;

function clampLimit(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_ROW_LIMIT;
  return Math.min(Math.floor(raw), MAX_ROW_LIMIT);
}

export interface ExceptionQueueParams {
  limit?: number | null;
  /** ISO date (YYYY-MM-DD) or timestamp used as "now" for age comparisons; defaults to current time. Overridable for tests. */
  today?: string;
}

export interface IssueExceptionRow {
  issue: Issue;
  property: PropertyRef;
  /** Days since the signal this row is queued for (created_at for most queues, hold effective_start for the release-blocked queue, last-activity for stale cases) — the page's "age" column. */
  ageDays: number;
}

export interface ExceptionQueueResult<T> {
  count: number;
  rows: T[];
}

// ---------------------------------------------------------------------
// 1. Active, non-passive issues with no open task or no future due date
// ---------------------------------------------------------------------

/**
 * Active (lifecycle_status = 'active') issues where either no open/
 * in_progress task exists at all, or none of them has a future
 * (>= today) due_date. A single NOT EXISTS semi-join covers both cases in
 * one pass: "no open task with due_date >= today" is true whether there
 * are zero open tasks or several, none of them due in the future.
 */
export async function noActionableTaskQueue(db: DbHandle, params: ExceptionQueueParams = {}): Promise<ExceptionQueueResult<IssueExceptionRow>> {
  const limit = clampLimit(params.limit);
  const today = params.today ?? businessTodayIso();

  const condition = sql`${issues.lifecycleStatus} = 'active' and not exists (
    select 1 from tasks t
    where t.issue_id = ${issues.id}
      and t.status in ('open', 'in_progress')
      and t.due_date is not null
      and t.due_date >= ${today}
  )`;

  return countAndListByAge(db, condition, sql`${issues.createdAt}`, today, limit);
}

// ---------------------------------------------------------------------
// 2. Missing/short summary (<15 chars)
// ---------------------------------------------------------------------

const SHORT_SUMMARY_MIN_LEN = 15;

/** Non-closed, non-passive issues whose trimmed summary is shorter than SHORT_SUMMARY_MIN_LEN (covers both "missing" — empty string, summary is NOT NULL at the schema level — and "too short to be clear"). */
export async function missingOrShortSummaryQueue(
  db: DbHandle,
  params: ExceptionQueueParams = {},
): Promise<ExceptionQueueResult<IssueExceptionRow>> {
  const limit = clampLimit(params.limit);
  const today = params.today ?? businessTodayIso();

  const condition = sql`${issues.lifecycleStatus} not in ('closed', 'passive_wait')
    and length(trim(${issues.summary})) < ${SHORT_SUMMARY_MIN_LEN}`;

  return countAndListByAge(db, condition, sql`${issues.createdAt}`, today, limit);
}

// ---------------------------------------------------------------------
// 3. Ready-to-release-shaped cases blocked >N days
// ---------------------------------------------------------------------

/**
 * phase_key values that are the `from_phase` of a `gates_release: true`
 * transition (supabase/migrations/20260731090600_issues_config_v2_transitions.sql)
 * across every issue_type's transition set — i.e. the phase an issue sits
 * in immediately before the config-defined release step. See this file's
 * top doc comment for why this is a hand-verified literal set, not a live
 * config_versions read.
 */
export const RELEASE_TRACK_PHASE_KEYS = ['cleanup', 'buyer_cleanup', 'relisting', 'assessment', 'resolution'] as const;

const DEFAULT_RELEASE_BLOCKED_DAYS = 14;

export interface ReleaseBlockedParams extends ExceptionQueueParams {
  /** Minimum age (days) of the active hold for a case to count as "blocked". Default 14, per roadmap. */
  minBlockedDays?: number;
}

/**
 * Issues whose CURRENT phase_instance (open/in_progress) has a phase_key in
 * RELEASE_TRACK_PHASE_KEYS, AND whose property carries an active hold
 * (released_at IS NULL) with effective_start older than minBlockedDays. A
 * property can carry more than one qualifying hold; ageDays is always
 * computed from the OLDEST active hold's effective_start
 * (min(effective_start), the same scalar subquery driving the EXISTS
 * check's age comparison), never an arbitrary one.
 */
export async function readyToReleaseBlockedQueue(
  db: DbHandle,
  params: ReleaseBlockedParams = {},
): Promise<ExceptionQueueResult<IssueExceptionRow>> {
  const limit = clampLimit(params.limit);
  const today = params.today ?? businessTodayIso();
  const minDays = Number.isFinite(params.minBlockedDays) && (params.minBlockedDays ?? 0) > 0 ? Math.floor(params.minBlockedDays!) : DEFAULT_RELEASE_BLOCKED_DAYS;

  const oldestActiveHoldStart = sql`(
    select min(h.effective_start) from holds h
    where h.property_ref_id = ${issues.propertyRefId} and h.released_at is null
  )`;

  const condition = sql`exists (
      select 1 from phase_instances pi
      where pi.id = ${issues.currentPhaseInstanceId}
        and pi.status in ('open', 'in_progress')
        and pi.phase_key in (${sql.join(RELEASE_TRACK_PHASE_KEYS.map((k) => sql`${k}`), sql`, `)})
    )
    and exists (
      select 1 from holds h
      where h.property_ref_id = ${issues.propertyRefId}
        and h.released_at is null
        and h.effective_start < (${today}::timestamptz - make_interval(days => ${minDays}))
    )`;

  return countAndListByAge(db, condition, sql`${oldestActiveHoldStart}::timestamptz`, today, limit);
}

// ---------------------------------------------------------------------
// 4. Stale cases (no audit activity in 14+ days) — bounded LATERAL max query
// ---------------------------------------------------------------------

const DEFAULT_STALE_DAYS = 14;

export interface StaleCasesParams extends ExceptionQueueParams {
  minStaleDays?: number;
}

/**
 * Non-closed, non-passive issues whose most recent audit_events row
 * (object_table = 'issues', object_id = issue.id) — or, if none exists,
 * the issue's own created_at — is older than minStaleDays. "Most recent
 * audit row per issue" is a bounded MAX(occurred_at) scalar subquery
 * correlated on the indexed (object_table, object_id) pair
 * (audit_events_object_table_object_id_idx) — a single aggregate lookup
 * per candidate row, never an unbounded per-issue scan, matching the task
 * brief's "bounded lateral/max query" requirement (Postgres commonly plans
 * a correlated MAX() subquery like this as an index-backed nested-loop,
 * the same physical shape a LATERAL ... ORDER BY ... LIMIT 1 would use).
 */
export async function staleCasesQueue(db: DbHandle, params: StaleCasesParams = {}): Promise<ExceptionQueueResult<IssueExceptionRow>> {
  const limit = clampLimit(params.limit);
  const today = params.today ?? businessTodayIso();
  const minDays = Number.isFinite(params.minStaleDays) && (params.minStaleDays ?? 0) > 0 ? Math.floor(params.minStaleDays!) : DEFAULT_STALE_DAYS;

  const lastAuditActivity = sql`(
    select max(ae.occurred_at) from audit_events ae
    where ae.object_table = 'issues' and ae.object_id = ${issues.id}
  )`;
  const lastActivityExpr = sql`coalesce(${lastAuditActivity}, ${issues.createdAt})`;

  const condition = sql`${issues.lifecycleStatus} not in ('closed', 'passive_wait')
    and ${lastActivityExpr} < (${today}::timestamptz - make_interval(days => ${minDays}))`;

  return countAndListByAge(db, condition, lastActivityExpr, today, limit);
}

// ---------------------------------------------------------------------
// 5. Tasks open >30 days
// ---------------------------------------------------------------------

const DEFAULT_TASK_OPEN_DAYS = 30;

export interface TaskExceptionRow {
  task: Task;
  issueId: string;
  ageDays: number;
}

export interface TasksOpenOverDaysParams extends ExceptionQueueParams {
  minOpenDays?: number;
}

/**
 * Open/in_progress tasks whose created_at is older than minOpenDays (30 by
 * default), restricted to tasks linked to an issue (issue_id IS NOT NULL)
 * — the task brief requires "every row links to its case", so a
 * case-less task has no row to render here.
 */
export async function tasksOpenOverDaysQueue(db: DbHandle, params: TasksOpenOverDaysParams = {}): Promise<ExceptionQueueResult<TaskExceptionRow>> {
  const limit = clampLimit(params.limit);
  const today = params.today ?? businessTodayIso();
  const minDays = Number.isFinite(params.minOpenDays) && (params.minOpenDays ?? 0) > 0 ? Math.floor(params.minOpenDays!) : DEFAULT_TASK_OPEN_DAYS;

  const ageExpr = sql<number>`extract(day from (${today}::timestamptz - ${tasks.createdAt}))`;
  const condition: SQL = sql`${tasks.status} in ('open', 'in_progress')
    and ${tasks.issueId} is not null
    and ${tasks.createdAt} < (${today}::timestamptz - make_interval(days => ${minDays}))`;

  const [countRow] = await db.select({ value: count() }).from(tasks).where(condition);
  const total = countRow?.value ?? 0;

  const rows = await db
    .select({ task: tasks, ageDays: ageExpr })
    .from(tasks)
    .where(condition)
    .orderBy(desc(ageExpr))
    .limit(limit);

  return {
    count: total,
    rows: rows
      .filter((r) => r.task.issueId !== null)
      .map((r) => ({ task: r.task, issueId: r.task.issueId as string, ageDays: Math.trunc(Number(r.ageDays)) })),
  };
}

// ---------------------------------------------------------------------
// Shared count-and-list-by-age helper (queues 1-3: an issues-scoped
// condition plus a "how old is this row" timestamp expression)
// ---------------------------------------------------------------------

async function countAndListByAge(
  db: DbHandle,
  condition: SQL,
  ageSourceExpr: SQL,
  today: string,
  limit: number,
): Promise<ExceptionQueueResult<IssueExceptionRow>> {
  const ageExpr = sql<number>`extract(day from (${today}::timestamptz - (${ageSourceExpr})))`;

  const [countRow] = await db
    .select({ value: count() })
    .from(issues)
    .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
    .where(condition);
  const total = countRow?.value ?? 0;

  const rows = await db
    .select({ issue: issues, property: propertyRefs, ageDays: ageExpr })
    .from(issues)
    .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
    .where(condition)
    .orderBy(desc(ageExpr))
    .limit(limit);

  return {
    count: total,
    rows: rows.map((r) => ({ issue: r.issue, property: r.property, ageDays: Math.trunc(Number(r.ageDays)) })),
  };
}

