/**
 * audit-diff.test.ts — coverage for app/_lib/audit-diff.ts, the pure
 * field-level diff computation backing ChangeLogFeed (Wave 2b readable
 * change-log feed, spec §29.2/§31.4). No DB, no rendering — plain data in,
 * plain data out.
 */
import { describe, expect, it } from 'vitest';
import { computeFieldDiffs, formatDiffValue, humanizeFieldName } from '../app/_lib/audit-diff.ts';

describe('audit-diff', () => {
  describe('computeFieldDiffs', () => {
    it('a single changed field produces exactly one diff entry, human-labeled', () => {
      const diffs = computeFieldDiffs({ priority: 'normal' }, { priority: 'high' });
      expect(diffs).toEqual([{ field: 'priority', label: 'Priority', before: 'Normal', after: 'High' }]);
    });

    it('unchanged fields are omitted entirely', () => {
      const diffs = computeFieldDiffs({ priority: 'normal', queue: 'new_unreviewed' }, { priority: 'high', queue: 'new_unreviewed' });
      expect(diffs).toHaveLength(1);
      expect(diffs[0]?.field).toBe('priority');
    });

    it('multiple changed fields all appear, in after-object key order', () => {
      const diffs = computeFieldDiffs(
        { priority: 'normal', queue: 'new_unreviewed', summary: 'old summary' },
        { queue: 'active_review', priority: 'high', summary: 'old summary' },
      );
      expect(diffs.map((d) => d.field)).toEqual(['queue', 'priority']);
    });

    it('a field present only in after (added) counts as changed', () => {
      const diffs = computeFieldDiffs({}, { coordinatorId: 42 });
      expect(diffs).toEqual([{ field: 'coordinatorId', label: 'Coordinator Id', before: '—', after: '42' }]);
    });

    it('a field present only in before (removed) counts as changed', () => {
      const diffs = computeFieldDiffs({ coordinatorId: 42 }, {});
      expect(diffs).toEqual([{ field: 'coordinatorId', label: 'Coordinator Id', before: '42', after: '—' }]);
    });

    it('noise keys (id/createdAt/updatedAt) never appear even when they differ', () => {
      const diffs = computeFieldDiffs(
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', priority: 'normal' },
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-08-04T00:00:00.000Z', priority: 'high' },
      );
      expect(diffs.map((d) => d.field)).toEqual(['priority']);
    });

    it('before=null (creation event) yields an empty diff — the fallback-label case', () => {
      expect(computeFieldDiffs(null, { id: 'a', priority: 'normal' })).toEqual([]);
    });

    it('a non-object before/after (denial-shaped or scalar audit rows) yields an empty diff rather than throwing', () => {
      expect(computeFieldDiffs('not-an-object', { foo: 'bar' })).toEqual([]);
      expect(computeFieldDiffs(undefined, undefined)).toEqual([]);
      expect(computeFieldDiffs([1, 2, 3], { foo: 'bar' })).toEqual([]);
    });

    it('nested/object-shaped values are compared structurally, not by reference', () => {
      const diffs = computeFieldDiffs({ meta: { a: 1 } }, { meta: { a: 1 } });
      expect(diffs).toEqual([]);
      const changed = computeFieldDiffs({ meta: { a: 1 } }, { meta: { a: 2 } });
      expect(changed).toHaveLength(1);
    });
  });

  describe('formatDiffValue', () => {
    it('null/undefined render as an em dash', () => {
      expect(formatDiffValue(null)).toBe('—');
      expect(formatDiffValue(undefined)).toBe('—');
    });

    it('booleans render as Yes/No', () => {
      expect(formatDiffValue(true)).toBe('Yes');
      expect(formatDiffValue(false)).toBe('No');
    });

    it('snake_case enum-like strings are humanized', () => {
      expect(formatDiffValue('vacancy_verified')).toBe('Vacancy Verified');
      expect(formatDiffValue('high')).toBe('High');
    });

    it('free-text strings pass through unchanged', () => {
      expect(formatDiffValue('Called owner, left voicemail')).toBe('Called owner, left voicemail');
    });

    it('ISO date strings are formatted human-readable', () => {
      const formatted = formatDiffValue('2026-08-04T12:00:00.000Z');
      expect(formatted).not.toBe('2026-08-04T12:00:00.000Z');
      expect(formatted.length).toBeGreaterThan(0);
    });

    it('numbers render as plain strings', () => {
      expect(formatDiffValue(42)).toBe('42');
    });
  });

  describe('humanizeFieldName', () => {
    it('converts camelCase keys to Title Case with spaces', () => {
      expect(humanizeFieldName('lifecycleStatus')).toBe('Lifecycle Status');
      expect(humanizeFieldName('dueDate')).toBe('Due Date');
      expect(humanizeFieldName('priority')).toBe('Priority');
    });

    it('converts snake_case keys too', () => {
      expect(humanizeFieldName('due_date')).toBe('Due Date');
    });
  });
});
