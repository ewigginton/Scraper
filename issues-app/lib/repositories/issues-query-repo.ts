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
import { cursorTimestampExpr, isValidCursorTimestamp } from './keyset-cursor.ts';
import { priorityRankExpr } from './priority-rank.ts';
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
/**
 * ROUND-4 FIX (P2): `priority`'s sort column used to be the bare
 * `issues.priority` text column, which sorts LEXICOGRAPHICALLY, not by
 * business importance — VALID_PRIORITIES is {low, normal, high, urgent},
 * and ASCII-wise 'high' < 'low' < 'normal' < 'urgent', so a descending
 * "most urgent first" sort on the /issues work-queue actually returned
 * `urgent, normal, low, high` — every `high`-priority issue silently
 * buried at the very bottom, under `low`. Mapping each value to its
 * CHECK-constrained business rank (urgent=4 > high=3 > normal=2 > low=1)
 * here — instead of at the JS/UI layer — keeps this a single ORDER BY/
 * keyset expression pair, so the cursor (minted from this SAME expression
 * via cursorValueExprFor) and the WHERE predicate (keysetPredicate, which
 * also reads this same expr) automatically agree with the ORDER BY on page
 * 2+, exactly like every other sort key in this allowlist.
 *
 * ROUND-5 FIX (P2): hoisted into ./priority-rank.ts, column-parameterized,
 * so tasks-repo.ts's inboxForUser queues (identical lexicographic defect on
 * tasks.priority, same domain) sort by the SAME expression instead of
 * re-deriving their own copy. See priority-rank.ts's doc comment.
 *
 * ROUND-5 FIX (P3): matched by a new expression index
 * (supabase/migrations/20260805100000_issues_priority_rank_index.sql) so
 * this sort stays index-assisted — the expression here and the index's
 * expression must stay byte-identical; see priority-rank.ts's doc comment.
 */
const PRIORITY_RANK_EXPR = priorityRankExpr(issues.priority);

const SORT_ALLOWLIST: Record<SortKey, SortColumnSpec> = {
  updated_at: { expr: sql`${issues.updatedAt}`, nullable: false, valueType: 'timestamp' },
  created_at: { expr: sql`${issues.createdAt}`, nullable: false, valueType: 'timestamp' },
  priority: { expr: PRIORITY_RANK_EXPR, nullable: false, valueType: 'text' },
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
  /**
   * P3 FIX (round 5): the SortKey this cursor was minted under (see
   * validCursorForSort's doc comment below for why this is required, not
   * just carried along informationally). Typed as plain `string`, not
   * `SortKey` — an untrusted cursor's key is only ever COMPARED against the
   * already-allowlist-resolved `sort.key`, never used to index/look
   * anything up, so no allowlist validation is needed at decode time.
   */
  sortKey: string;
  sortValue: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(sortKey: string, sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, sortValue, id]), 'utf8').toString('base64url');
}

/** Returns null (meaning: treat as the first page) on ANY malformed input — never throws. */
export function decodeCursor(raw: string | null | undefined): DecodedCursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    // P3 FIX (round 5): the payload grew a leading sortKey element (was
    // [sortValue, id], now [sortKey, sortValue, id]) — see
    // validCursorForSort's doc comment. A 2-element legacy cursor (minted
    // before this fix shipped, e.g. sitting in a bookmarked/shared URL)
    // fails this length check and decodes to null, which is exactly the
    // documented "malformed cursor -> page 1" contract, not a thrown error.
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [sortKey, sortValue, id] = parsed as [unknown, unknown, unknown];
    if (typeof sortKey !== 'string' || typeof sortValue !== 'string' || typeof id !== 'string') return null;
    if (!UUID_RE.test(id)) return null;
    // INJECTION FUZZ finding (round 2): sortValue is bound directly as a
    // text-typed parameter for non-timestamp sorts (keysetPredicate's
    // castParam) — a crafted `after=` cursor carrying a NUL byte here
    // would reach the wire as a bound parameter's value and 500 with a
    // raw Postgres "invalid byte sequence" error. Reject outright (treat
    // as an invalid/stale cursor -> page 1) rather than silently
    // stripping, since silently altering a cursor's sort value could
    // otherwise reorder/skip rows. sortKey gets the same guard — it never
    // reaches SQL (only compared in JS against the resolved sort.key), but
    // there is no reason to let a NUL-carrying value past decode either.
    if (containsNulByte(sortValue) || containsNulByte(sortKey)) return null;
    return { sortKey, sortValue, id };
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
 *
 * P3 FIX (round 5): the value-type shape check below is necessary but not
 * sufficient — it only catches a cross-sort replay when the two sorts
 * happen to disagree on `valueType` (e.g. priority [text] vs updated_at
 * [timestamp]). Two TEXT sorts (e.g. priority vs lifecycle_status) both
 * pass this check trivially, so the stale cursor's `sortValue` (still
 * meaningful under the OLD sort) got bound as-is into the new sort's
 * `keysetPredicate` — and after PRIORITY_RANK_EXPR started emitting digit
 * ranks ('4'..'1') instead of the priority words, that stale digit compared
 * against every OTHER text sort's real values and matched none of them:
 * `lifecycle_status < '4'` is true for every lifecycle_status value's first
 * byte, so a `desc` replay returned EVERY row after a strictly-less
 * comparison miscount, and an `asc` replay could return ZERO — reproduced
 * as zero rows (see this file's regression test), contradicting this
 * function's own "stale cursor -> page 1" contract. The general fix: bind
 * the cursor to the exact SortKey it was minted under (encodeCursor's new
 * `sortKey` element) and discard it outright on ANY sort-key change, not
 * just a valueType mismatch — this closes the whole class (any sort-key
 * change with a live cursor), the same way the round-3 timestamp-shape
 * check above closed its narrower class.
 */
function validCursorForSort(cursor: DecodedCursor | null, sortKey: SortKey, spec: SortColumnSpec): DecodedCursor | null {
  if (!cursor) return null;
  if (cursor.sortKey !== sortKey) return null;
  if (spec.valueType === 'timestamp') {
    // ROUND-3 FIX (P2): the round-2 fix canonicalized via
    // `new Date(Date.parse(x)).toISOString()`, which is a NO-OP for ISO
    // 8601 extended-year (`+010000-01-01T...`) and year-0000
    // (`0000-01-01T...`) strings — both parse fine in JS and round-trip
    // byte-for-byte through `toISOString()`, then blow up as a raw
    // `date/time field value out of range`/`time zone displacement out of
    // range` driver error at the `${value}::timestamptz` cast in
    // castParam/keysetPredicate below, exactly the crash the "malformed
    // cursor -> page 1" contract was supposed to prevent. Validate against
    // the EXACT shape extractSortValue's cursorValue expression always
    // produces instead (see keyset-cursor.isValidCursorTimestamp's doc
    // comment) — this also means the value is NEVER round-tripped through
    // a JS Date, so the microsecond precision a real cursor carries (P1 fix
    // below) survives unchanged.
    if (!isValidCursorTimestamp(cursor.sortValue)) return null;
    return cursor;
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

/**
 * The SQL expression that produces the cursor's opaque `sortValue` for the
 * currently resolved sort column.
 *
 * P1 FIX (round 3): previously this was computed in JS from the already-
 * fetched row (`row.issue.updatedAt.toISOString()` for the timestamp
 * sorts), which truncates to millisecond resolution while the column it's
 * compared against is `timestamptz` (microsecond resolution) — a boundary
 * row whose timestamp carried a non-zero sub-millisecond component (the
 * routine case: `created_at`/`updated_at` both default `now()`, the
 * TRANSACTION timestamp, so any bulk import/seed/backfill produces ties)
 * had its cursor silently truncated downward, excluding every remaining
 * row in that microsecond group and reporting the feed complete. Selecting
 * Postgres's own text rendering of the boundary column instead (via
 * `cursorTimestampExpr`, same fix as comms-repo.ts/audit-metrics-repo.ts/
 * timeline-repo.ts) means no JS Date is ever involved, so no precision is
 * lost. For non-timestamp sorts this is unaffected (plain text/enum
 * columns have no sub-value precision to lose) — cast through the same
 * nullable-coalescing `orderExprFor` the ORDER BY itself uses, so the
 * cursor value always matches what determined this row's position.
 */
function cursorValueExprFor(spec: SortColumnSpec): SQL<string> {
  return spec.valueType === 'timestamp' ? cursorTimestampExpr(spec.expr) : sql<string>`(${orderExprFor(spec)})::text`;
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
  const cursor = validCursorForSort(decodeCursor(params.cursor ?? null), sort.key, spec);

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
    .select({ issue: issues, property: propertyRefs, cursorValue: cursorValueExprFor(spec) })
    .from(issues)
    .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow ? encodeCursor(sort.key, lastRow.cursorValue, lastRow.issue.id) : null;

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
