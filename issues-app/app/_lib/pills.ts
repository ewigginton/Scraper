/**
 * app/_lib/pills.ts — single source of truth for colored-pill mapping
 * (docs/notion-redesign.md "Look and feel — Pills/tags"). Maps domain enum
 * values to one of the soft `n-pill-*` colors defined in globals.css. Purely
 * presentational: no business logic, no DB access.
 *
 * Every mapper falls back to `gray` for any value it doesn't recognize, so
 * an unexpected/new enum value still renders (no thrown error, no blank
 * pill) — callers should not need to update this file in lockstep with
 * every schema change to stay safe, only to stay accurately colored.
 */

export type PillColor = 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red';

const ISSUE_TYPE_COLOR: Record<string, PillColor> = {
  default_recovery: 'blue',
  covenant_violation: 'orange',
  market_readiness: 'green',
  property_legal: 'red',
  buyer_cleanup: 'purple',
};

const PRIORITY_COLOR: Record<string, PillColor> = {
  low: 'gray',
  normal: 'blue',
  high: 'orange',
  urgent: 'red',
};

const LIFECYCLE_COLOR: Record<string, PillColor> = {
  intake: 'gray',
  active: 'blue',
  waiting: 'yellow',
  blocked: 'red',
  on_hold: 'orange',
  passive_wait: 'brown',
  closed: 'green',
};

/** app/_lib/case-view.ts's HistoryCategory -> pill color, for the change-log feed (Wave 2b). Keys are duplicated as plain strings rather than importing HistoryCategory to avoid a circular app/_lib import; historyCategoryPillColor's `?? 'gray'` fallback keeps that safe. */
const HISTORY_CATEGORY_COLOR: Record<string, PillColor> = {
  business_event: 'blue',
  workflow_transition: 'purple',
  tasks: 'green',
  holds_releases: 'orange',
  vendor_cost: 'yellow',
  field_edit: 'gray',
};

const HOLD_TYPE_COLOR: Record<string, PillColor> = {
  legal: 'red',
  safety: 'red',
  occupancy: 'orange',
  cleanup: 'yellow',
  foreclosure: 'red',
  title: 'purple',
  covenant: 'orange',
  stop_work: 'red',
  existing_contract_active: 'blue',
  other: 'gray',
};

export function issueTypePillColor(issueType: string): PillColor {
  return ISSUE_TYPE_COLOR[issueType] ?? 'gray';
}

export function priorityPillColor(priority: string): PillColor {
  return PRIORITY_COLOR[priority] ?? 'gray';
}

export function lifecyclePillColor(lifecycleStatus: string): PillColor {
  return LIFECYCLE_COLOR[lifecycleStatus] ?? 'gray';
}

export function holdTypePillColor(holdType: string): PillColor {
  return HOLD_TYPE_COLOR[holdType] ?? 'gray';
}

export function historyCategoryPillColor(category: string): PillColor {
  return HISTORY_CATEGORY_COLOR[category] ?? 'gray';
}

/** lib/repositories/timeline-repo.ts's TimelineKind -> pill color, for the case Timeline view (Wave 2b). */
const TIMELINE_KIND_COLOR: Record<string, PillColor> = {
  communication: 'green',
  audit: 'gray',
  phase_open: 'blue',
  phase_close: 'purple',
  notice: 'orange',
  issue_link: 'blue',
};

export function timelineKindPillColor(kind: string): PillColor {
  return TIMELINE_KIND_COLOR[kind] ?? 'gray';
}

/** Turns a snake_case enum value into "Title Case" for pill/label text. */
export function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}
