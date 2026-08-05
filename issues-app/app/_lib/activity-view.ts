/**
 * app/_lib/activity-view.ts — URL <-> query-object plumbing for the two
 * activity screens (roadmap "Global Activity feed" / "Admin activity
 * metrics", spec §8.2 coordinator-performance reporting, §29.11 shared
 * timeline projection). Same split as app/_lib/issues-view.ts: pure param
 * parsing/href-building here, actual DB access through
 * lib/repositories/audit-metrics-repo.ts (the real trust boundary —
 * VALID_OBJECT_TABLES there re-validates everything this module produces).
 *
 * Grouped category allowlist: the task brief asks for a coarser filter than
 * audit-metrics-repo's raw object_table ("action category (grouped
 * allowlist: workflow/holds/tasks/payments/config/other)"). This module
 * owns that grouping and expands one category into the object_table[]
 * audit-metrics-repo actually filters on. `config` and `other` currently
 * have no or few live object_table members (no config_* table is audited
 * today; see audit-metrics-repo.ts's VALID_OBJECT_TABLES doc comment) —
 * they're kept as selectable categories anyway so the filter UI doesn't
 * need to change shape the day config auditing ships.
 */

export const ACTIVITY_CATEGORIES = ['workflow', 'holds', 'tasks', 'payments', 'config', 'other'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/** category -> object_table[] (values audit-metrics-repo.VALID_OBJECT_TABLES actually accepts). */
export const CATEGORY_OBJECT_TABLES: Record<ActivityCategory, string[]> = {
  workflow: ['issues'],
  holds: ['holds'],
  tasks: ['tasks'],
  payments: ['payment_requests'],
  config: ['saved_views'],
  other: ['approvals', 'possession_records', 'stale_acknowledgments'],
};

export function isActivityCategory(value: unknown): value is ActivityCategory {
  return typeof value === 'string' && (ACTIVITY_CATEGORIES as readonly string[]).includes(value);
}

export function categoryLabel(category: ActivityCategory): string {
  switch (category) {
    case 'workflow':
      return 'Workflow (issues)';
    case 'holds':
      return 'Holds';
    case 'tasks':
      return 'Tasks';
    case 'payments':
      return 'Payments';
    case 'config':
      return 'Config (saved views)';
    case 'other':
      return 'Other';
  }
}

// ---------------------------------------------------------------------
// Shared param helpers
// ---------------------------------------------------------------------

export type SearchParams = Record<string, string | string[] | undefined>;

export function firstString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const MAX_QS_LEN = 200;

/** Trims + length-bounds any free-text querystring value before it ever reaches a repo param. */
export function sanitizeQueryString(v: string | undefined): string | null {
  const trimmed = v?.trim().slice(0, MAX_QS_LEN);
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------
// /activity feed params + href
// ---------------------------------------------------------------------

export interface ActivityFeedView {
  category: ActivityCategory | null;
  actor: string | null;
  from: string | null;
  to: string | null;
  cursor: string | null;
}

export function parseActivityFeedParams(sp: SearchParams): ActivityFeedView {
  const categoryRaw = firstString(sp.category);
  return {
    category: isActivityCategory(categoryRaw) ? categoryRaw : null,
    actor: sanitizeQueryString(firstString(sp.actor)),
    from: sanitizeQueryString(firstString(sp.from)),
    to: sanitizeQueryString(firstString(sp.to)),
    cursor: sanitizeQueryString(firstString(sp.after)),
  };
}

export type ActivityHrefOverrides = Partial<Record<string, string | null>>;

export function buildActivityHref(sp: SearchParams, overrides: ActivityHrefOverrides = {}): string {
  const merged: SearchParams = { ...sp };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) if (item) usp.append(key, item);
  }
  const qs = usp.toString();
  return qs ? `/activity?${qs}` : '/activity';
}

// ---------------------------------------------------------------------
// /admin/activity params + href
// ---------------------------------------------------------------------

export type AdminActivityRangePreset = '7' | '30' | '90' | 'custom';

export interface AdminActivityView {
  preset: AdminActivityRangePreset;
  category: ActivityCategory | null;
  from: string | null;
  to: string | null;
}

const VALID_PRESETS = new Set<AdminActivityRangePreset>(['7', '30', '90', 'custom']);

/** Resolves the effective [from, to] ISO date-time bounds for a preset/custom range, `to` defaulting to "now". */
export function resolveAdminActivityRange(view: AdminActivityView, now: Date = new Date()): { from: string | null; to: string | null } {
  if (view.preset === 'custom') {
    return { from: view.from, to: view.to };
  }
  const days = Number(view.preset);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days);
  return { from: from.toISOString(), to: now.toISOString() };
}

export function parseAdminActivityParams(sp: SearchParams): AdminActivityView {
  const presetRaw = firstString(sp.range);
  const preset = VALID_PRESETS.has(presetRaw as AdminActivityRangePreset) ? (presetRaw as AdminActivityRangePreset) : '30';
  const categoryRaw = firstString(sp.category);
  return {
    preset,
    category: isActivityCategory(categoryRaw) ? categoryRaw : null,
    from: preset === 'custom' ? sanitizeQueryString(firstString(sp.from)) : null,
    to: preset === 'custom' ? sanitizeQueryString(firstString(sp.to)) : null,
  };
}

/**
 * Merges several activitiesByActor() result sets (one per object_table in a
 * selected grouped category — audit-metrics-repo.activitiesByActor only
 * ever filters on a single object_table, see its `category` param) into one
 * actor -> total-count list, summed and re-sorted busiest-first. With a
 * single input set (no category selected, or a category with exactly one
 * underlying object_table) this is equivalent to that one set, just
 * re-sorted defensively.
 */
export function mergeActorCounts(sets: Array<Array<{ actor: string; count: number }>>): Array<{ actor: string; count: number }> {
  const totals = new Map<string, number>();
  for (const rows of sets) {
    for (const row of rows) {
      totals.set(row.actor, (totals.get(row.actor) ?? 0) + row.count);
    }
  }
  return [...totals.entries()].map(([actor, count]) => ({ actor, count })).sort((a, b) => b.count - a.count || a.actor.localeCompare(b.actor));
}

export function buildAdminActivityHref(sp: SearchParams, overrides: ActivityHrefOverrides = {}): string {
  const merged: SearchParams = { ...sp };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) if (item) usp.append(key, item);
  }
  const qs = usp.toString();
  return qs ? `/admin/activity?${qs}` : '/admin/activity';
}
