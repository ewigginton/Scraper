/**
 * lib/date/business-today.ts — single chokepoint for "what calendar day is
 * it right now, for due-date/overdue/aging purposes".
 *
 * Every prior call site used `new Date().toISOString().slice(0, 10)`, which
 * is always the UTC calendar day. For roughly half the day in US timezones
 * (e.g. after ~19:00 US-Central, which is already past midnight UTC), that
 * is a DIFFERENT calendar day than the business's actual local "today" —
 * misclassifying same-day-due tasks/issues as overdue, and vice versa for
 * the "no actionable task" exception queue's future-dated check.
 *
 * Fix: resolve "today" in the business's configured IANA timezone via the
 * built-in Intl.DateTimeFormat (no new dependency). `en-CA` formats dates as
 * YYYY-MM-DD directly, so no manual field reassembly is needed.
 */

const DEFAULT_BUSINESS_TZ = 'America/Chicago';

export const BUSINESS_TZ = process.env.ISSUES_BUSINESS_TZ?.trim() || DEFAULT_BUSINESS_TZ;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Returns the current calendar date (YYYY-MM-DD) in the business's configured timezone. */
export function businessTodayIso(now: Date = new Date()): string {
  return formatter.format(now);
}
