/**
 * activity-view.test.ts — coverage for app/_lib/activity-view.ts, the pure
 * URL <-> query-object plumbing and aggregation helpers behind /activity and
 * /admin/activity (Wave 2b). Previously untested despite containing real
 * (non-trivial) logic: mergeActorCounts sums across multiple result sets
 * (a subtle "duplicate actor across categories" bug is easy to introduce),
 * and resolveAdminActivityRange does date-window math that directly drives
 * what the admin metrics dashboard reports as "this period".
 */
import { describe, expect, it } from 'vitest';
import {
  buildActivityHref,
  buildAdminActivityHref,
  categoryLabel,
  isActivityCategory,
  mergeActorCounts,
  parseActivityFeedParams,
  parseAdminActivityParams,
  resolveAdminActivityRange,
  sanitizeQueryString,
  type AdminActivityView,
} from '../app/_lib/activity-view.ts';

describe('activity-view', () => {
  describe('isActivityCategory / categoryLabel', () => {
    it('accepts every documented category and rejects garbage', () => {
      for (const c of ['workflow', 'holds', 'tasks', 'payments', 'config', 'other']) {
        expect(isActivityCategory(c)).toBe(true);
      }
      expect(isActivityCategory('bogus')).toBe(false);
      expect(isActivityCategory(42)).toBe(false);
      expect(isActivityCategory(undefined)).toBe(false);
    });

    it('every category has a non-empty human label', () => {
      for (const c of ['workflow', 'holds', 'tasks', 'payments', 'config', 'other'] as const) {
        expect(categoryLabel(c).length).toBeGreaterThan(0);
      }
    });
  });

  describe('sanitizeQueryString', () => {
    it('trims and length-caps, returns null for empty/whitespace-only input', () => {
      expect(sanitizeQueryString('  alice  ')).toBe('alice');
      expect(sanitizeQueryString('   ')).toBeNull();
      expect(sanitizeQueryString(undefined)).toBeNull();
      expect(sanitizeQueryString('x'.repeat(500))?.length).toBe(200);
    });
  });

  describe('parseActivityFeedParams', () => {
    it('defaults every field when no params given', () => {
      expect(parseActivityFeedParams({})).toEqual({ category: null, actor: null, from: null, to: null, cursor: null });
    });

    it('an invalid category falls back to null rather than passing through', () => {
      expect(parseActivityFeedParams({ category: 'not-real' }).category).toBeNull();
    });

    it('a valid category, actor, from/to, and after (cursor) all parse through', () => {
      const view = parseActivityFeedParams({ category: 'holds', actor: 'alice', from: '2026-01-01', to: '2026-02-01', after: 'cur1' });
      expect(view).toEqual({ category: 'holds', actor: 'alice', from: '2026-01-01', to: '2026-02-01', cursor: 'cur1' });
    });
  });

  describe('parseAdminActivityParams', () => {
    it('defaults to the 30-day preset with no category', () => {
      expect(parseAdminActivityParams({})).toEqual({ preset: '30', category: null, from: null, to: null });
    });

    it('accepts every documented preset', () => {
      for (const p of ['7', '30', '90', 'custom']) {
        expect(parseAdminActivityParams({ range: p }).preset).toBe(p);
      }
    });

    it('an invalid range value falls back to the 30-day default', () => {
      expect(parseAdminActivityParams({ range: '365' }).preset).toBe('30');
      expect(parseAdminActivityParams({ range: 'bogus' }).preset).toBe('30');
    });

    it('from/to are only honored under the custom preset — a non-custom preset ignores them', () => {
      const nonCustom = parseAdminActivityParams({ range: '7', from: '2026-01-01', to: '2026-01-08' });
      expect(nonCustom.from).toBeNull();
      expect(nonCustom.to).toBeNull();

      const custom = parseAdminActivityParams({ range: 'custom', from: '2026-01-01', to: '2026-01-08' });
      expect(custom.from).toBe('2026-01-01');
      expect(custom.to).toBe('2026-01-08');
    });
  });

  describe('resolveAdminActivityRange', () => {
    const now = new Date('2026-08-04T12:00:00.000Z');

    it('custom preset returns the view\'s own from/to verbatim, even if null', () => {
      const view: AdminActivityView = { preset: 'custom', category: null, from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
      expect(resolveAdminActivityRange(view, now)).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    });

    it('custom preset with no from/to set returns nulls (not "now")', () => {
      const view: AdminActivityView = { preset: 'custom', category: null, from: null, to: null };
      expect(resolveAdminActivityRange(view, now)).toEqual({ from: null, to: null });
    });

    it('7/30/90 presets resolve to [now - N days, now]', () => {
      for (const preset of ['7', '30', '90'] as const) {
        const view: AdminActivityView = { preset, category: null, from: null, to: null };
        const { from, to } = resolveAdminActivityRange(view, now);
        expect(to).toBe(now.toISOString());
        const expectedFrom = new Date(now);
        expectedFrom.setUTCDate(expectedFrom.getUTCDate() - Number(preset));
        expect(from).toBe(expectedFrom.toISOString());
      }
    });

    it('the 90-day window correctly crosses a month/year boundary', () => {
      const yearStart = new Date('2026-01-15T00:00:00.000Z');
      const view: AdminActivityView = { preset: '90', category: null, from: null, to: null };
      const { from } = resolveAdminActivityRange(view, yearStart);
      expect(from).toBe('2025-10-17T00:00:00.000Z');
    });
  });

  describe('mergeActorCounts', () => {
    it('a single input set is returned re-sorted busiest-first', () => {
      const merged = mergeActorCounts([[{ actor: 'bob', count: 2 }, { actor: 'alice', count: 5 }]]);
      expect(merged).toEqual([{ actor: 'alice', count: 5 }, { actor: 'bob', count: 2 }]);
    });

    it('sums counts for the SAME actor appearing across multiple sets (e.g. two object_tables in one category)', () => {
      const merged = mergeActorCounts([
        [{ actor: 'alice', count: 3 }],
        [{ actor: 'alice', count: 4 }, { actor: 'bob', count: 1 }],
      ]);
      const byActor = Object.fromEntries(merged.map((r) => [r.actor, r.count]));
      expect(byActor.alice).toBe(7);
      expect(byActor.bob).toBe(1);
    });

    it('ties in count break alphabetically by actor', () => {
      const merged = mergeActorCounts([[{ actor: 'zoe', count: 3 }, { actor: 'amy', count: 3 }]]);
      expect(merged.map((r) => r.actor)).toEqual(['amy', 'zoe']);
    });

    it('an empty list of sets, or sets containing empty arrays, produce an empty result rather than throwing', () => {
      expect(mergeActorCounts([])).toEqual([]);
      expect(mergeActorCounts([[], []])).toEqual([]);
    });
  });

  describe('buildActivityHref / buildAdminActivityHref', () => {
    it('produces a bare path with no params', () => {
      expect(buildActivityHref({})).toBe('/activity');
      expect(buildAdminActivityHref({})).toBe('/admin/activity');
    });

    it('round-trips params and applies overrides, dropping null-overridden keys', () => {
      const href = buildActivityHref({ category: 'holds', actor: 'alice' }, { actor: null, after: 'cur1' });
      const usp = new URLSearchParams(href.split('?')[1]);
      expect(usp.get('category')).toBe('holds');
      expect(usp.has('actor')).toBe(false);
      expect(usp.get('after')).toBe('cur1');
    });

    it('admin href round-trips the range preset', () => {
      const href = buildAdminActivityHref({}, { range: '90' });
      expect(href).toBe('/admin/activity?range=90');
    });
  });
});
