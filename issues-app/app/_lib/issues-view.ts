/**
 * app/_lib/issues-view.ts — URL <-> query-object plumbing for the /issues
 * "All Issues" database view (docs/notion-redesign.md). Two halves:
 *
 * 1. Pure param parsing/URL building (no DB access): turns Next.js's
 *    `searchParams` shape into the typed inputs
 *    lib/repositories/issues-query-repo.ts already validates
 *    (issues-query-repo.ts is the actual trust boundary — normalizeFilters/
 *    resolveSort/decodeCursor there sanitize against allowlists regardless
 *    of what this module produces; this module's own parsing is a second,
 *    page-local layer for the two params issues-query-repo doesn't own:
 *    `cols` and `group`), plus href builders so every control (sort
 *    headers, pagination, group "view all" links, saved views) can produce
 *    a shareable URL without ever hand-concatenating a query string at the
 *    call site.
 * 2. Grouped-view data loading (group=lifecycle_status|issue_type): calls
 *    listIssues/countIssues once per group value — the group axis is
 *    always one of a small fixed enum, so this stays a small, bounded
 *    number of already-LIMITed queries, not a query shape issues-query-repo
 *    needs a new export for.
 *
 * No business rules live here (DESIGN.md §6) — this is UI-layer read
 * orchestration only, the same role app/_lib/work-screen.ts and
 * app/_lib/case-view.ts already play for their screens.
 */

import type { DbHandle } from '../../lib/repositories/db-handle.ts';
import {
  countIssues,
  listIssues,
  type IssueListRow,
  type IssuesQueryFilters,
  type RawSortInput,
  type SortKey,
} from '../../lib/repositories/issues-query-repo.ts';

// ---------------------------------------------------------------------
// Canonical enum lists — intentionally duplicated from lib/db/schema.ts's
// CHECK-constraint values, same as issues-query-repo.ts's own
// VALID_ISSUE_TYPES/VALID_LIFECYCLE_STATUSES/VALID_PRIORITIES (see that
// file's doc comment): the runtime allowlist those CHECK constraints don't
// provide a way to introspect from application code.
// ---------------------------------------------------------------------

export const ISSUE_TYPES = ['default_recovery', 'covenant_violation', 'market_readiness', 'property_legal', 'buyer_cleanup'] as const;
export const LIFECYCLE_STATUSES = ['intake', 'active', 'waiting', 'blocked', 'on_hold', 'passive_wait', 'closed'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

// ---------------------------------------------------------------------
// Columns (URL param `cols=`) — a page-local concern; issues-query-repo has
// no notion of column visibility.
// ---------------------------------------------------------------------

export type ColumnKey = 'property' | 'type' | 'stage' | 'priority' | 'owner' | 'state' | 'updated';

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** The sort key this column's header links to, or null if the column isn't sortable. */
  sortKey: SortKey | null;
}

export const ALL_COLUMNS: ColumnDef[] = [
  { key: 'property', label: 'Property', sortKey: 'property_display_name' },
  { key: 'type', label: 'Type', sortKey: 'issue_type' },
  { key: 'stage', label: 'Stage', sortKey: 'lifecycle_status' },
  { key: 'priority', label: 'Priority', sortKey: 'priority' },
  { key: 'owner', label: 'Coordinator / Queue', sortKey: null },
  { key: 'state', label: 'State', sortKey: null },
  { key: 'updated', label: 'Updated', sortKey: 'updated_at' },
];

const ALL_COLUMN_KEYS = new Set<string>(ALL_COLUMNS.map((c) => c.key));
const COLUMN_ORDER = new Map<ColumnKey, number>(ALL_COLUMNS.map((c, i) => [c.key, i]));

export const DEFAULT_COLUMNS: ColumnKey[] = ALL_COLUMNS.map((c) => c.key);

/** Property is the row's own link/title cell — always rendered regardless of what `cols=` says, same as a spreadsheet's leftmost pinned column. */
const ALWAYS_VISIBLE_COLUMNS: ColumnKey[] = ['property'];

/** Columns the user can actually toggle via the columns menu (everything except the always-visible ones). */
export const TOGGLEABLE_COLUMNS: ColumnDef[] = ALL_COLUMNS.filter((c) => !ALWAYS_VISIBLE_COLUMNS.includes(c.key));

// ---------------------------------------------------------------------
// Group-by (URL param `group=`)
// ---------------------------------------------------------------------

export type GroupKey = 'lifecycle_status' | 'issue_type';
const GROUP_ALLOWLIST = new Set<string>(['lifecycle_status', 'issue_type']);

// ---------------------------------------------------------------------
// searchParams shape (matches Next.js App Router's resolved searchParams).
// ---------------------------------------------------------------------

export type IssuesSearchParams = Record<string, string | string[] | undefined>;

/** Query params saved into a saved view / round-tripped through hrefs — `after` (the pagination cursor) is deliberately excluded from this list everywhere it's used, so neither a saved view nor a "current URL" snapshot ever pins a stale page position. */
const ROUND_TRIP_PARAM_KEYS = ['type', 'status', 'state', 'priority', 'owner', 'overdue', 'q', 'sort', 'dir', 'cols', 'group'] as const;

function firstString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function allStrings(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).slice(0, 50);
}

function splitCommaList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 50);
}

/** Tolerant of ANY string, including garbage — never throws. Anything not on the small `group` allowlist silently becomes "no grouping" (flat mode), matching the "invalid params fall back to defaults silently" acceptance requirement. */
function parseGroup(v: string | string[] | undefined): GroupKey | null {
  const s = firstString(v);
  return s && GROUP_ALLOWLIST.has(s) ? (s as GroupKey) : null;
}

/**
 * Tolerant of ANY input shape — unrecognized/duplicate column names are
 * dropped; an empty or all-invalid `cols=` falls back to DEFAULT_COLUMNS
 * rather than rendering a table with no columns at all. Accepts BOTH the
 * repeated-key form the columns menu's checkboxes submit (`cols=type&cols=
 * stage`, which Next.js hands back as a string[]) and a single
 * comma-joined value (`cols=type,stage`, for a hand-built/shared URL) —
 * `allStrings` flattens the former to individual tokens and this then
 * additionally splits each token on commas, so either form (or a mix)
 * resolves the same way.
 */
function parseColumns(v: string | string[] | undefined): ColumnKey[] {
  if (v === undefined) return DEFAULT_COLUMNS;
  const requested = allStrings(v)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 100);
  if (requested.length === 0) return DEFAULT_COLUMNS;
  const valid = new Set<ColumnKey>(requested.filter((c): c is ColumnKey => ALL_COLUMN_KEYS.has(c)));
  for (const key of ALWAYS_VISIBLE_COLUMNS) valid.add(key);
  if (valid.size === 0) return DEFAULT_COLUMNS;
  return Array.from(valid).sort((a, b) => (COLUMN_ORDER.get(a) ?? 0) - (COLUMN_ORDER.get(b) ?? 0));
}

export interface ParsedIssuesView {
  filters: IssuesQueryFilters;
  sort: RawSortInput;
  cursor: string | null;
  columns: ColumnKey[];
  group: GroupKey | null;
}

/** Turns raw searchParams into the shape listIssues/countIssues expect, plus this page's own `columns`/`group`. Never throws — every sub-parser above is tolerant of malformed input, and issues-query-repo re-validates `filters`/`sort`/`cursor` against its own allowlists regardless of what's produced here (defense in depth, not the only check). */
export function parseIssuesViewParams(sp: IssuesSearchParams): ParsedIssuesView {
  return {
    filters: {
      issueTypes: allStrings(sp.type),
      lifecycleStatuses: allStrings(sp.status),
      states: splitCommaList(firstString(sp.state)),
      priorities: allStrings(sp.priority),
      coordinatorOrQueue: firstString(sp.owner)?.trim() || null,
      overdueOnly: firstString(sp.overdue) === '1',
      searchText: firstString(sp.q)?.trim() || null,
    },
    sort: { key: firstString(sp.sort), direction: firstString(sp.dir) },
    cursor: firstString(sp.after) ?? null,
    columns: parseColumns(sp.cols),
    group: parseGroup(sp.group),
  };
}

// ---------------------------------------------------------------------
// Href building — every clickable control on the page goes through this so
// no call site hand-concatenates a query string.
// ---------------------------------------------------------------------

/** `null` in an override deletes that key; `undefined`/omitted keeps whatever `sp` already had. */
export type IssuesHrefOverrides = Partial<Record<string, string | string[] | null>>;

export function buildIssuesHref(sp: IssuesSearchParams, overrides: IssuesHrefOverrides = {}): string {
  const merged: IssuesSearchParams = { ...sp };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item) usp.append(key, item);
    } else if (value !== '') {
      usp.set(key, value);
    }
  }
  const qs = usp.toString();
  return qs ? `/issues?${qs}` : '/issues';
}

/** The subset of current params worth saving/sharing — drops `after` (pagination position) and anything outside the recognized key list, so a saved view is always "this filter/sort/column/group configuration", never "this exact page". */
export function toPlainParamsObject(sp: IssuesSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of ROUND_TRIP_PARAM_KEYS) {
    const value = sp[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value;
    } else if (value !== '') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Reconstructs a query string from a saved view's stored `params` (jsonb —
 * untrusted shape at the type level even though only its own owner can ever
 * write it, per saved_views' RLS). Only the fixed ROUND_TRIP_PARAM_KEYS are
 * ever read, and only string/string[] values are ever re-serialized — this
 * is a bookmark of a URL, not a bypass of the allowlists parseIssuesViewParams
 * and issues-query-repo.ts's own normalizeFilters/resolveSort apply the
 * moment that URL is loaded.
 */
export function queryStringFromParamsObject(params: unknown): string {
  const usp = new URLSearchParams();
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return '';
  const record = params as Record<string, unknown>;
  for (const key of ROUND_TRIP_PARAM_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item) usp.append(key, item);
    } else if (typeof value === 'string' && value) {
      usp.set(key, value);
    }
  }
  return usp.toString();
}

// ---------------------------------------------------------------------
// Grouped view loading (group=lifecycle_status|issue_type)
// ---------------------------------------------------------------------

const GROUP_ROW_LIMIT = 10;

export interface GroupSection {
  /** The raw enum value (e.g. 'active', 'covenant_violation') — callers render its display via app/_lib/pills.ts's humanize/color mappers. */
  key: string;
  count: number;
  rows: IssueListRow[];
}

/**
 * One listIssues + one countIssues per group VALUE (not per row) — the
 * group axis is always lifecycle_status (7 values) or issue_type (5
 * values), so this is a small, fixed, bounded number of already-LIMITed
 * queries, never proportional to table size. Empty groups (count 0) are
 * dropped so the page doesn't render seven mostly-empty section headers.
 *
 * If the filter bar already narrowed the SAME field being grouped on (e.g.
 * group=lifecycle_status while status=active,waiting is also set), only
 * those already-selected values are iterated rather than the full enum —
 * grouping by a field the user also filtered on should section the filtered
 * subset, not resurrect statuses they explicitly excluded.
 */
export async function loadGroupedIssues(
  db: DbHandle,
  filters: IssuesQueryFilters,
  group: GroupKey,
  sort: RawSortInput,
  today: string,
): Promise<GroupSection[]> {
  const values: readonly string[] =
    group === 'lifecycle_status'
      ? filters.lifecycleStatuses && filters.lifecycleStatuses.length > 0
        ? filters.lifecycleStatuses
        : LIFECYCLE_STATUSES
      : filters.issueTypes && filters.issueTypes.length > 0
        ? filters.issueTypes
        : ISSUE_TYPES;

  const sections = await Promise.all(
    values.map(async (value): Promise<GroupSection> => {
      const groupFilters: IssuesQueryFilters =
        group === 'lifecycle_status' ? { ...filters, lifecycleStatuses: [value] } : { ...filters, issueTypes: [value] };
      const [listResult, total] = await Promise.all([
        listIssues(db, { filters: groupFilters, sort, limit: GROUP_ROW_LIMIT, today }),
        countIssues(db, { filters: groupFilters, today }),
      ]);
      return { key: value, count: total, rows: listResult.rows };
    }),
  );

  return sections.filter((s) => s.count > 0);
}
