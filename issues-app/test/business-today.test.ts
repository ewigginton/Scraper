/**
 * business-today.test.ts — regression coverage for lib/date/business-today.ts.
 *
 * Before the fix, "today" for every due-date/overdue/aging calculation was
 * `new Date().toISOString().slice(0, 10)` — always the UTC calendar day.
 * For several hours every evening in US timezones, that is a DIFFERENT day
 * than the business's actual local calendar day. This test pins a UTC
 * instant that has already rolled to a new UTC date while it is still the
 * previous calendar day in America/Chicago (the default business timezone),
 * and asserts businessTodayIso resolves the LOCAL day, not the UTC day.
 *
 * FAILS before the fix (todayIso()/dashboard-repo/exceptions-repo/etc. used
 * the raw UTC-slice pattern, which has no way to resolve a local day at
 * all — there was no timezone-aware helper to call). PASSES after: this
 * file exercises the new lib/date/business-today.ts chokepoint directly.
 */
import { describe, expect, it } from 'vitest';
import { businessTodayIso, BUSINESS_TZ } from '../lib/date/business-today.ts';
import { classifyDueDate } from '../app/_lib/dates.ts';

describe('businessTodayIso', () => {
  it('resolves the business-local calendar day, not the UTC calendar day, near the UTC midnight rollover', () => {
    // 2026-08-05T02:00:00Z is 2026-08-04 21:00 in America/Chicago (UTC-5,
    // daylight time in August) — local calendar day is still Aug 4th even
    // though the UTC calendar day has already rolled to Aug 5th.
    const nearMidnightUtc = new Date('2026-08-05T02:00:00.000Z');

    // Sanity check: prove this instant really does straddle the UTC boundary,
    // i.e. the old buggy pattern would have returned the WRONG day.
    expect(nearMidnightUtc.toISOString().slice(0, 10)).toBe('2026-08-05');

    if (BUSINESS_TZ === 'America/Chicago') {
      expect(businessTodayIso(nearMidnightUtc)).toBe('2026-08-04');
    }
  });

  it('agrees with the UTC day well away from any rollover boundary', () => {
    const midday = new Date('2026-08-04T18:00:00.000Z'); // 13:00 America/Chicago
    expect(businessTodayIso(midday)).toBe('2026-08-04');
  });
});

describe('classifyDueDate uses business-local "today"', () => {
  it('does not classify a task due "today" (business-local) as overdue, even after the UTC date has rolled over', () => {
    if (BUSINESS_TZ !== 'America/Chicago') return;
    // At this UTC instant the UTC day is already 2026-08-05, but the
    // business's local calendar day is still 2026-08-04.
    const nearMidnightUtc = new Date('2026-08-05T02:00:00.000Z');
    const businessToday = businessTodayIso(nearMidnightUtc);
    expect(businessToday).toBe('2026-08-04');

    // A task due "today" in the business's local calendar day must never
    // classify as overdue.
    expect(classifyDueDate('2026-08-04', businessToday)).not.toBe('overdue');
    expect(classifyDueDate('2026-08-04', businessToday)).toBe('due-soon');
  });
});
