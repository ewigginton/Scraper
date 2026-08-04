/**
 * issues-query-repo — the composable filtered/sorted/keyset-paginated query
 * for the /issues "All Issues" database view (spec §15, §25) plus its
 * matching COUNT. All DB access is parameterized via drizzle operators or
 * `sql` template placeholders — client-supplied strings are always bound
 * parameters, never concatenated into query text. The one place a client
 * string could otherwise select which COLUMN gets embedded in the query
 * (the `sort` param) is resolved through the literal SORT_ALLOWLIST map
 * below, never through a dynamic column-name lookup.
 *
 * No business rules live here (DESIGN.md §6) — this module reads issues +
 * their joined property_refs display fields in ONE query (no N+1) and
 * nothing else.
 */

import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { businessTodayIso } from '../date/business-today.ts';
import { containsNulByte, sanitizeText } from './id-guard.ts';
import {
  issues,
  propertyRefs,
  type Issue,
  type IssueType,
  type LifecycleStatus,
  type Priority,
  type PropertyRef,
} from '../db/schema.ts';

// ---------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------

export interface IssuesQueryFilters {
  issueTypes?: string[];
  lifecycleStatuses?: string[];
  states?: string[];
  priorities?: string[];
  /** Matches EITHER issues.coordinator_id OR issues.queue (the filter bar's single "coordinator/queue" control). */
  coordinatorOrQueue?: string | null;
  /** True if the issue has an open/in_progress task whose due_date has passed. */
  overdueOnly?: boolean;
  /**
   * Free text (spec §15 "context-aware search"): matches issues.summary
   * (full-text), property_refs.display_name/development/tract (ILIKE
   * prefix), and any linked person's display_name/phone/email (ILIKE
   * substring, via issue_people -> person_refs) — see buildFilterConditions.
   */
  searchText?: string | null;
}

// CHECK-constraint values (supabase/migrations/20260731090000_issues_core.sql).
// Duplicated here deliberately, same as the inline `check(...)` lists in
// lib/db/schema.ts — this is the runtime allowlist those CHECK constraints
// don't provide a way to introspect from application code.
const VALID_ISSUE_TYPES = new Set(['default_recovery', 'covenant_violation', 'market_readiness', 'property_legal', 'buyer_cleanup']);
const VALID_LIFECYCLE_STATUSES = new Set(['intake', 'active', 'waiting', 'blocked', 'on_hold', 'passive_wait', 'closed']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

const MAX_FILTER_VALUES = 50;
const MAX_STRING_LEN = 200;

/**
 * `requested` distinguishes "the caller didn't ask for this filter" (skip
 * it) from "the caller asked, but every value they sent was invalid/not in
 * the allowlist" (match NOTHING) — collapsing those two cases would silently
 * turn `issueTypes=['not_a_real_type']` into "no issueType filter at all",
 * i.e. every issue, which is the opposite of what was asked.
 */
interface SanitizedArrayFilter {
  requested: boolean;
  values: string[];
}

interface NormalizedFilters {
  issueTypes: SanitizedArrayFilter;
  lifecycleStatuses: SanitizedArrayFilter;
  states: SanitizedArrayFilter;
  priorities: SanitizedArrayFilter;
  coordinatorOrQueue: string | null;
  overdueOnly: boolean;
  searchText: string | null;
}

/**
 * Postgres `text`/`varchar` columns reject the NUL byte outright (driver
 * error: `invalid byte sequence for encoding "UTF8": 0x00`) — unlike SQL
 * injection, parameterization does NOT protect against this, because the
 * byte reaches the wire as a bound parameter's VALUE, not as SQL syntax.
 * Stripping it (INJECTION FUZZ finding: `q=%00%00%00` 500'd countIssues/
 * listIssues) keeps every free-text filter (search, state, coordinator/queue)
 * a safe "matches nothing weirder than usual" instead of an uncaught
 * driver exception reaching the client as a 500. Delegates to
 * id-guard.sanitizeText — the ONE implementation every repo that accepts
 * free-text input now shares (round 2: comms-repo.ts/timeline-repo.ts/
 * audit-metrics-repo.ts had each grown their own copy that omitted this
 * strip entirely).
 */
function sanitizeStringArray(input: unknown, allowlist?: Set<string>): SanitizedArrayFilter {
  if (!Array.isArray(input)) return { requested: false, values: [] };
  const candidates = new Set<string>();
  for (const raw of input) {
    const trimmed = sanitizeText(raw, MAX_STRING_LEN);
    if (!trimmed) continue;
    candidates.add(trimmed);
    if (candidates.size >= MAX_FILTER_VALUES) break;
  }
  if (candidates.size === 0) return { requested: false, values: [] };
  const values = allowlist ? Array.from(candidates).filter((v) => allowlist.has(v)) : Array.from(candidates);
  return { requested: true, values };
}

function sanitizeString(input: unknown): string | null {
  return sanitizeText(input, MAX_STRING_LEN);
}

function normalizeFilters(filters: IssuesQueryFilters | undefined): NormalizedFilters {
  return {
    issueTypes: sanitizeStringArray(filters?.issueTypes, VALID_ISSUE_TYPES),
    lifecycleStatuses: sanitizeStringArray(filters?.lifecycleStatuses, VALID_LIFECYCLE_STATUSES),
    priorities: sanitizeStringArray(filters?.priorities, VALID_PRIORITIES),
    states: sanitizeStringArray(filters?.states),
    coordinatorOrQueue: sanitizeString(filters?.coordinatorOrQueue),
    overdueOnly: filters?.overdueOnly === true,
    searchText: sanitizeString(filters?.searchText),
  };
}

/** requested-but-nothing-valid -> an always-false condition (matches nothing); not requested -> no condition (skip). */
function impossibleIfEmpty(field: SanitizedArrayFilter): SQL | undefined {
  return field.requested && field.values.length === 0 ? sql`false` : undefined;
}

function buildFilterConditions(filters: NormalizedFilters, today: string): SQL[] {
  const conditions: SQL[] = [];

  // Cast is safe: sanitizeStringArray already filtered these arrays against
  // VALID_ISSUE_TYPES/VALID_LIFECYCLE_STATUSES/VALID_PRIORITIES, the same
  // literal sets these TS unions are drawn from.
  if (filters.issueTypes.requested) {
    conditions.push(impossibleIfEmpty(filters.issueTypes) ?? inArray(issues.issueType, filters.issueTypes.values as IssueType[]));
  }
  if (filters.lifecycleStatuses.requested) {
    conditions.push(
      impossibleIfEmpty(filters.lifecycleStatuses) ?? inArray(issues.lifecycleStatus, filters.lifecycleStatuses.values as LifecycleStatus[]),
    );
  }
  if (filters.priorities.requested) {
    conditions.push(impossibleIfEmpty(filters.priorities) ?? inArray(issues.priority, filters.priorities.values as Priority[]));
  }
  if (filters.states.requested) {
    conditions.push(impossibleIfEmpty(filters.states) ?? inArray(propertyRefs.state, filters.states.values));
  }

  if (filters.coordinatorOrQueue) {
    const clause = or(eq(issues.coordinatorId, filters.coordinatorOrQueue), eq(issues.queue, filters.coordinatorOrQueue));
    if (clause) conditions.push(clause);
  }

  if (filters.overdueOnly) {
    // A semi-join (EXISTS), not a real join — stays a single query, no N+1,
    // and does not affect the property_refs join cardinality.
    conditions.push(sql`exists (
      select 1 from tasks t
      where t.issue_id = ${issues.id}
        and t.status in ('open', 'in_progress')
        and t.due_date is not null
        and t.due_date < ${today}
    )`);
  }

  if (filters.searchText) {
    const q = filters.searchText;
    const prefix = `${q}%`;
    const like = `%${q}%`;
    // Person match (spec §15 "search by person, phone/email"): a
    // correlated EXISTS over issue_people -> person_refs, never a real
    // join — keeps this a single query with no N+1 and no effect on the
    // property_refs join cardinality (same pattern as the overdueOnly
    // EXISTS above and comms-repo.ts's participantSearchCondition).
    // Unaliased subquery against the real issue_people/person_refs table
    // objects, correlated to the outer issues row via issues.id.
    const personMatch = sql`exists (
      select 1
      from issue_people
      join person_refs on person_refs.id = issue_people.person_ref_id
      where issue_people.issue_id = ${issues.id}
        and (
          person_refs.display_name ilike ${like}
          or person_refs.contact_snapshot ->> 'phone' ilike ${like}
          or person_refs.contact_snapshot ->> 'email' ilike ${like}
        )
    )`;
    conditions.push(
      sql`(
        ${issues.summaryTsv} @@ plainto_tsquery('simple', ${q})
        OR ${propertyRefs.displayName} ilike ${prefix}
        OR ${propertyRefs.development} ilike ${prefix}
        OR ${propertyRefs.tract} ilike ${prefix}
        OR ${personMatch}
      )`,
    );
  }

  return conditions;
}

// ---------------------------------------------------------------------
// Sort — literal allowlist, never a dynamic column-name lookup
// ---------------------------------------------------------------------

export type SortKey = 'updated_at' | 'created_at' | 'priority' | 'issue_type' | 'lifecycle_status' | 'property_display_name';
export type SortDirection = 'asc' | 'desc';

export interface ResolvedSort {
  key: SortKey;
  direction: SortDirection;
}

export interface RawSortInput {
  key?: unknown;
  direction?: unknown;
}

interface SortColumnSpec {
  /** The real column reference this sort key resolves to. */
  expr: SQL;
  /** True if the underlying column can be NULL (only property_display_name today). */
  nullable: boolean;
  /** Parameter cast needed for the keyset comparison — `text` needs none, `timestamp` needs `::timestamptz`. */
  valueType: 'text' | 'timestamp';
}

// due-date-of-next-task is deliberately OUT of scope (docs/notion-redesign.md
// "Scale work" §1) — there is no single "next task" column on issues to sort
// by without a per-row subquery/join this allowlist doesn't provide.
const SORT_ALLOWLIST: Record<SortKey, SortColumnSpec> = {
  updated_at: { expr: sql`${issues.updatedAt}`, nullable: false, valueType: 'timestamp' },
  created_at: { expr: sql`${issues.createdAt}`, nullable: false, valueType: 'timestamp' },
  priority: { expr: sql`${issues.priority}`, nullable: false, valueType: 'text' },
  issue_type: { expr: sql`${issues.issueType}`, nullable: false, valueType: 'text' },
  lifecycle_status: { expr: sql`${issues.lifecycleStatus}`, nullable: false, valueType: 'text' },
  property_display_name: { expr: sql`${propertyRefs.displayName}`, nullable: true, valueType: 'text' },
};

export const SORT_KEYS = Object.keys(SORT_ALLOWLIST) as SortKey[];

export const DEFAULT_SORT: ResolvedSort = { key: 'updated_at', direction: 'desc' };

/** Resolves an untrusted {key, direction} pair through the literal allowlist. Anything not recognized falls back to DEFAULT_SORT — never throws. */
export function resolveSort(raw: RawSortInput | null | undefined): ResolvedSort {
  const key =
    typeof raw?.key === 'string' && Object.prototype.hasOwnProperty.call(SORT_ALLOWLIST, raw.key)
      ? (raw.key as SortKey)
      : DEFAULT_SORT.key;
  const direction: SortDirection = raw?.direction === 'asc' ? 'asc' : raw?.direction === 'desc' ? 'desc' : DEFAULT_SORT.direction;
  return { key, direction };
}

function orderExprFor(spec: SortColumnSpec): SQL {
  return spec.nullable ? sql`coalesce(${spec.expr}, '')` : spec.expr;
}

// ---------------------------------------------------------------------
// Keyset cursor — base64url JSON [sortValue, id], strict decode
// ---------------------------------------------------------------------

interface DecodedCursor {
  sortValue: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id]), 'utf8').toString('base64url');
}

/** Returns null (meaning: treat as the first page) on ANY malformed input — never throws. */
export function decodeCursor(raw: string | null | undefined): DecodedCursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [sortValue, id] = parsed as [unknown, unknown];
    if (typeof sortValue !== 'string' || typeof id !== 'string') return null;
    if (!UUID_RE.test(id)) return null;
    // INJECTION FUZZ finding (round 2): sortValue is bound directly as a
    // text-typed parameter for non-timestamp sorts (keysetPredicate's
    // castParam) — a crafted `after=` cursor carrying a NUL byte here
    // would reach the wire as a bound parameter's value and 500 with a
    // raw Postgres "invalid byte sequence" error. Reject outright (treat
    // as an invalid/stale cursor -> page 1) rather than silently
    // stripping, since silently altering a cursor's sort value could
    // otherwise reorder/skip rows.
    if (containsNulByte(sortValue)) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

/**
 * A cursor decodes structurally fine but may still carry a sortValue that
 * doesn't fit the CURRENTLY resolved sort's value type (e.g. a cursor
 * minted while sorting by `priority`, then replayed after the URL's `sort`
 * changed to `updated_at`). Cross-validating here — rather than letting an
 * un-parseable timestamp string reach the driver — is what keeps a
 * malformed/stale cursor a safe "start over from page 1" instead of a
 * thrown SQL error.
 */
function validCursorForSort(cursor: DecodedCursor | null, spec: SortColumnSpec): DecodedCursor | null {
  if (!cursor) return null;
  if (spec.valueType === 'timestamp') {
    // ROUND-2 FIX (P2): Date.parse() accepts strings Postgres's timestamptz
    // parser rejects (e.g. RFC-2822-with-trailing-zone-name strings), so a
    // crafted `after=` cursor could pass this guard and then throw a raw
    // driver error at the `${value}::timestamptz` cast in castParam/
    // keysetPredicate below, instead of the safe "malformed cursor -> page
    // 1" fallback this function promises. Canonicalize to a real ISO string
    // rather than merely checking parseability: every legitimate cursor was
    // minted by extractSortValue's `.toISOString()` above, so re-deriving
    // the canonical ISO string never changes a valid cursor's value, and a
    // canonical ISO string always parses in Postgres.
    const ms = Date.parse(cursor.sortValue);
    if (Number.isNaN(ms)) return null;
    return { ...cursor, sortValue: new Date(ms).toISOString() };
  }
  return cursor;
}

function castParam(valueType: SortColumnSpec['valueType'], value: string): SQL {
  return valueType === 'timestamp' ? sql`${value}::timestamptz` : sql`${value}`;
}

/** Standard "seek method" predicate: strictly past the cursor row in the current sort order. */
function keysetPredicate(spec: SortColumnSpec, direction: SortDirection, cursor: DecodedCursor): SQL {
  const orderExpr = orderExprFor(spec);
  const value = castParam(spec.valueType, cursor.sortValue);
  if (direction === 'desc') {
    return sql`((${orderExpr} < ${value}) OR (${orderExpr} = ${value} AND ${issues.id} < ${cursor.id}::uuid))`;
  }
  return sql`((${orderExpr} > ${value}) OR (${orderExpr} = ${value} AND ${issues.id} > ${cursor.id}::uuid))`;
}

function extractSortValue(key: SortKey, row: IssueListRow): string {
  switch (key) {
    case 'updated_at':
      return row.issue.updatedAt.toISOString();
    case 'created_at':
      return row.issue.createdAt.toISOString();
    case 'priority':
      return row.issue.priority;
    case 'issue_type':
      return row.issue.issueType;
    case 'lifecycle_status':
      return row.issue.lifecycleStatus;
    case 'property_display_name':
      return row.property.displayName ?? '';
  }
}

// ---------------------------------------------------------------------
// listIssues / countIssues
// ---------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

export interface IssueListRow {
  issue: Issue;
  property: PropertyRef;
}

export interface ListIssuesParams {
  filters?: IssuesQueryFilters;
  sort?: RawSortInput;
  /** Opaque cursor string from the URL's `after=` param, or null/undefined for the first page. */
  cursor?: string | null;
  limit?: number | null;
  /** ISO date (YYYY-MM-DD) to treat as "today" for overdueOnly; defaults to current date. Overridable for tests. */
  today?: string;
}

export interface ListIssuesResult {
  rows: IssueListRow[];
  /** Opaque cursor for "Load next 50", or null if this was the last page. */
  nextCursor: string | null;
  /** The sort actually applied, after allowlist resolution (lets a caller detect a fallback happened). */
  sort: ResolvedSort;
}

export interface CountIssuesParams {
  filters?: IssuesQueryFilters;
  today?: string;
}

/** Filtered + sorted + keyset-paginated issues, joined to property_refs display fields in ONE query. */
export async function listIssues(db: DbHandle, params: ListIssuesParams = {}): Promise<ListIssuesResult> {
  const sort = resolveSort(params.sort);
  const spec = SORT_ALLOWLIST[sort.key];
  const limit = clampLimit(params.limit);
  const filters = normalizeFilters(params.filters);
  const today = params.today ?? businessTodayIso();
  const cursor = validCursorForSort(decodeCursor(params.cursor ?? null), spec);

  const conditions = buildFilterConditions(filters, today);
  if (cursor) {
    conditions.push(keysetPredicate(spec, sort.direction, cursor));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const orderExpr = orderExprFor(spec);
  const orderBy = sort.direction === 'desc' ? [desc(orderExpr), desc(issues.id)] : [asc(orderExpr), asc(issues.id)];

  // Fetch one extra row to know whether a next page exists without a
  // separate COUNT — the +1 row is trimmed below and never returned.
  const rows = await db
    .select({ issue: issues, property: propertyRefs })
    .from(issues)
    .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow ? encodeCursor(extractSortValue(sort.key, lastRow), lastRow.issue.id) : null;

  return { rows: pageRows, nextCursor, sort };
}

/** Cheap total-count companion to listIssues, ignoring pagination (same filters, no cursor/limit). */
export async function countIssues(db: DbHandle, params: CountIssuesParams = {}): Promise<number> {
  const filters = normalizeFilters(params.filters);
  const today = params.today ?? businessTodayIso();
  const conditions = buildFilterConditions(filters, today);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [row] = await db
    .select({ value: count() })
    .from(issues)
    .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
    .where(where);

  return row?.value ?? 0;
}
