/**
 * app/_lib/dates.ts — due-date urgency classification shared by the personal
 * work screen and case view (spec §8.1 "color-coded normal/due-soon/overdue").
 *
 * DECISION: spec §8.1/§8.3 call for configurable color cues but do not name
 * an exact "due soon" window in the Phase-1 schema/config (config_entries
 * seeds only `overdue_manager_alert_days`, which governs escalation, not the
 * UI's due-soon threshold). Simplest defensible default: 3 days, matching
 * the closest configured value's order of magnitude. Documented gap, not a
 * silently invented business rule.
 */

export type Urgency = 'none' | 'normal' | 'due-soon' | 'overdue';

const DUE_SOON_WINDOW_DAYS = 3;

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function classifyDueDate(dueDate: string | null | undefined, today: string = todayIso()): Urgency {
  if (!dueDate) return 'none';
  if (dueDate < today) return 'overdue';
  const soonUntil = addDaysIso(today, DUE_SOON_WINDOW_DAYS);
  if (dueDate <= soonUntil) return 'due-soon';
  return 'normal';
}

export function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return 'No date';
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return 'Unknown time';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
