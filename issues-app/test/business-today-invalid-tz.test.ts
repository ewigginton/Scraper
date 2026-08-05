/**
 * business-today-invalid-tz.test.ts — regression coverage for the round-2
 * P2 fix: lib/date/business-today.ts used to build its Intl.DateTimeFormat
 * directly from process.env.ISSUES_BUSINESS_TZ at MODULE LOAD with no
 * validation, so a typo'd timezone (e.g. "America/Chicagoo" — the exact
 * value .env.example documents ISSUES_BUSINESS_TZ=America/Chicago as a
 * supported knob for) threw an opaque RangeError at import time and bricked
 * every route and every service that transitively imports this module
 * (app/_lib/dates.ts, issue-service.ts, task-service.ts, tasks-repo.ts,
 * dashboard-repo.ts, exceptions-repo.ts, issues-query-repo.ts — i.e.
 * essentially the whole package).
 *
 * The fix wraps formatter construction in try/catch: on RangeError, log the
 * invalid value and rebuild with the documented default (America/Chicago)
 * instead, exporting the effective zone (and why a fallback happened, if it
 * did) rather than throwing.
 *
 * Each `it` below uses vi.resetModules() + a fresh dynamic import because
 * this module reads process.env at IMPORT time, not call time (unlike
 * lib/auth/current-user.ts's getCurrentUser(), which re-reads on every
 * call) — the module must be re-evaluated fresh under each env value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_TZ = process.env.ISSUES_BUSINESS_TZ;

function setTz(value: string | undefined): void {
  if (value === undefined) delete process.env.ISSUES_BUSINESS_TZ;
  else process.env.ISSUES_BUSINESS_TZ = value;
}

describe('lib/date/business-today.ts: invalid ISSUES_BUSINESS_TZ degrades instead of bricking the module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    setTz(ORIGINAL_TZ);
    vi.resetModules();
  });

  it('REGRESSION: a typo\'d IANA timezone does not throw at import time — it falls back to the documented default', async () => {
    setTz('America/Chicagoo'); // exact typo from the finding's repro

    // Before the fix this import itself threw a RangeError, so merely
    // reaching a resolved module (rather than a rejected promise) is
    // the regression this test guards.
    const mod = await import('../lib/date/business-today.ts');
    expect(mod.BUSINESS_TZ).toBe('America/Chicago');
    expect(mod.BUSINESS_TZ_FALLBACK_REASON).not.toBeNull();
    expect(mod.BUSINESS_TZ_FALLBACK_REASON).toMatch(/America\/Chicagoo/);
  });

  it('the fallback module still computes a correct business-local calendar day using the default zone', async () => {
    setTz('America/Chicagoo');
    const mod = await import('../lib/date/business-today.ts');
    // 2026-08-05T02:00:00Z is 2026-08-04 21:00 in America/Chicago.
    expect(mod.businessTodayIso(new Date('2026-08-05T02:00:00.000Z'))).toBe('2026-08-04');
  });

  it('a valid, non-default IANA timezone is honored with no fallback', async () => {
    setTz('America/New_York');
    const mod = await import('../lib/date/business-today.ts');
    expect(mod.BUSINESS_TZ).toBe('America/New_York');
    expect(mod.BUSINESS_TZ_FALLBACK_REASON).toBeNull();
  });

  it('an unset ISSUES_BUSINESS_TZ uses the default with no fallback flagged (fallback is only for an INVALID explicit value)', async () => {
    setTz(undefined);
    const mod = await import('../lib/date/business-today.ts');
    expect(mod.BUSINESS_TZ).toBe('America/Chicago');
    expect(mod.BUSINESS_TZ_FALLBACK_REASON).toBeNull();
  });
});
