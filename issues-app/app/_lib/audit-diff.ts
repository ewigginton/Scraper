/**
 * app/_lib/audit-diff.ts — pure field-level diff computation over
 * audit_events before/after jsonb (Wave 2b "readable change-log feed",
 * spec §29.2/§31.4). Extracted from app/_components/ChangeLogFeed.tsx so it
 * is independently unit-testable (task brief: "extract it to
 * app/_lib/audit-diff.ts so it's testable").
 *
 * before/after shapes vary by call site (grepped across lib/services/*.ts):
 * sometimes a full row (`before: existing`), sometimes a narrow projection
 * (`before: { lifecycleStatus: existing.lifecycleStatus }`), sometimes null
 * (creation events, `before: null`), sometimes a denial-shaped object that
 * isn't really a before/after pair at all (transition-engine.ts's blocked-
 * transition audit row: `after: { attemptedPhaseKey, denialCode, reasons }`
 * with no corresponding `before` keys). This module never assumes a schema —
 * it diffs whatever two plain objects it's given, key by key, and returns an
 * EMPTY diff (never throws, never guesses) whenever before/after aren't both
 * plain objects. The caller (ChangeLogFeed) falls back to "action + reason"
 * for an empty diff, matching the task brief's "unknown shapes fall back to
 * action + reason".
 *
 * No presentation/JSX here (DESIGN.md §6) — plain data in, plain data out.
 */

import { formatDateTime } from './dates.ts';
import { humanize } from './pills.ts';

export interface FieldDiff {
  /** Raw before/after object key, e.g. "priority". */
  field: string;
  /** Human label, e.g. "Priority". */
  label: string;
  /** Human-formatted "before" value, e.g. "Normal" or "—" for null/undefined. */
  before: string;
  /** Human-formatted "after" value. */
  after: string;
}

/**
 * Bookkeeping columns every row-shaped before/after carries that are never
 * meaningful to a user reading a change log: `id`/`createdAt` never change
 * between a before/after pair (so the equality check below already drops
 * them), and `updatedAt` changes on EVERY update regardless of which field
 * actually moved — without this exclusion every diff would carry a noisy
 * "Updated At: ... → ..." line.
 */
const NOISE_KEYS = new Set(['id', 'createdAt', 'updatedAt']);

const MAX_FIELDS = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
/** snake_case / lowercase enum-ish token, e.g. "high", "vacancy_verified" — humanized for readability; anything else (free text, mixed case, punctuation) is shown verbatim so real prose isn't mangled. */
const ENUM_LIKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Formats one before/after leaf value into a human string. Best-effort and type-agnostic (this module has no schema to consult) — never throws. */
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return formatDateTime(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.length === 0) return '—';
    if (ISO_DATE_RE.test(value)) return formatDateTime(value);
    if (ENUM_LIKE_RE.test(value)) return humanize(value);
    return value;
  }
  return stableStringify(value);
}

/** Turns a camelCase (or snake_case) object key into a "Title Case" label, e.g. "lifecycleStatus" -> "Lifecycle Status", "due_date" -> "Due Date". */
export function humanizeFieldName(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Computes the changed-fields diff between `before` and `after`. Returns []
 * (never throws) whenever either side isn't a plain object — this is the ONE
 * signal ChangeLogFeed uses to decide "render a fallback line" vs "render a
 * field diff", so it must be conservative: no diff is ever fabricated from a
 * shape this function doesn't understand.
 *
 * Field order: `after`'s own key order first (the shape a caller usually
 * cares about most), then any keys that exist only in `before` (a field that
 * was removed). Bounded to MAX_FIELDS so a pathological before/after can't
 * blow up rendering.
 */
export function computeFieldDiffs(before: unknown, after: unknown): FieldDiff[] {
  if (!isPlainObject(before) || !isPlainObject(after)) return [];

  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(after)) {
    if (!seen.has(k)) {
      seen.add(k);
      orderedKeys.push(k);
    }
  }
  for (const k of Object.keys(before)) {
    if (!seen.has(k)) {
      seen.add(k);
      orderedKeys.push(k);
    }
  }

  const diffs: FieldDiff[] = [];
  for (const key of orderedKeys) {
    if (NOISE_KEYS.has(key)) continue;
    const beforeValue = before[key];
    const afterValue = after[key];
    if (stableStringify(beforeValue) === stableStringify(afterValue)) continue;
    diffs.push({ field: key, label: humanizeFieldName(key), before: formatDiffValue(beforeValue), after: formatDiffValue(afterValue) });
    if (diffs.length >= MAX_FIELDS) break;
  }
  return diffs;
}
