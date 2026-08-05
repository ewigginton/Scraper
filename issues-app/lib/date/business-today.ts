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

const REQUESTED_BUSINESS_TZ = process.env.ISSUES_BUSINESS_TZ?.trim() || DEFAULT_BUSINESS_TZ;

function buildFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * ROUND-2 FIX (P2): this formatter used to be built directly from
 * ISSUES_BUSINESS_TZ at module load with no validation — an operator typo
 * (e.g. "America/Chicagoo") threw a RangeError at IMPORT time, which is
 * transitively every page and every command in the package, since this
 * module is this codebase's one chokepoint for "what day is it". A single
 * bad env var should degrade like every other misconfiguration in this
 * package (see tryGetDb()/DatabaseUnavailable) — fall back to the documented
 * default and keep running — not brick the entire application with an
 * opaque error that never names the offending value.
 */
let effectiveBusinessTz = REQUESTED_BUSINESS_TZ;
let formatter: Intl.DateTimeFormat;
/** Set to the rejected value + reason when ISSUES_BUSINESS_TZ was invalid and the default was substituted; null otherwise. Exported so a health/diagnostics endpoint can surface a silently-applied fallback instead of it going unnoticed. */
export let BUSINESS_TZ_FALLBACK_REASON: string | null = null;

try {
  formatter = buildFormatter(REQUESTED_BUSINESS_TZ);
} catch (err) {
  if (!(err instanceof RangeError)) throw err;
  const message = err instanceof Error ? err.message : String(err);
  BUSINESS_TZ_FALLBACK_REASON = `ISSUES_BUSINESS_TZ="${REQUESTED_BUSINESS_TZ}" is not a valid IANA timezone (${message}); using default ${DEFAULT_BUSINESS_TZ} instead.`;
  // eslint-disable-next-line no-console
  console.error(`lib/date/business-today.ts: ${BUSINESS_TZ_FALLBACK_REASON}`);
  effectiveBusinessTz = DEFAULT_BUSINESS_TZ;
  formatter = buildFormatter(DEFAULT_BUSINESS_TZ);
}

/** The business timezone actually in effect — REQUESTED_BUSINESS_TZ unless it was invalid, in which case DEFAULT_BUSINESS_TZ (see BUSINESS_TZ_FALLBACK_REASON). */
export const BUSINESS_TZ = effectiveBusinessTz;

/** Returns the current calendar date (YYYY-MM-DD) in the business's configured timezone. */
export function businessTodayIso(now: Date = new Date()): string {
  return formatter.format(now);
}
