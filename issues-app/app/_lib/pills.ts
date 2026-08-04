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

/** Turns a snake_case enum value into "Title Case" for pill/label text. */
export function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}
