/**
 * issue-timeline-view.test.ts — coverage for app/_lib/issue-timeline-view.ts,
 * the pure URL <-> query-object plumbing for the case Timeline view (Wave 2b,
 * spec §9.1/§29.11/§31.4). No DB, no rendering: this is the page-local param
 * parser that sits in front of lib/repositories/timeline-repo.ts's
 * TimelineFilters normalization (the real trust boundary). Added because
 * this file previously had zero direct test coverage despite doing
 * allowlist/regex validation of every querystring param the Timeline page
 * accepts (kind, person, direction, participant, from, to, after).
 */
import { describe, expect, it } from 'vitest';
import {
  buildIssueTimelineHref,
  firstString,
  hasActiveIssueTimelineFilters,
  parseIssueTimelineParams,
  toArray,
  type IssueTimelineSearchParams,
} from '../app/_lib/issue-timeline-view.ts';

describe('issue-timeline-view', () => {
  describe('firstString / toArray', () => {
    it('firstString returns the first element of an array, or the scalar itself, or undefined', () => {
      expect(firstString(['a', 'b'])).toBe('a');
      expect(firstString('a')).toBe('a');
      expect(firstString(undefined)).toBeUndefined();
    });

    it('toArray normalizes scalar/array/undefined to an array', () => {
      expect(toArray(undefined)).toEqual([]);
      expect(toArray('a')).toEqual(['a']);
      expect(toArray(['a', 'b'])).toEqual(['a', 'b']);
    });
  });

  describe('parseIssueTimelineParams', () => {
    it('defaults every field when no params are present', () => {
      const view = parseIssueTimelineParams({});
      expect(view).toEqual({
        kinds: [],
        personRefIds: [],
        direction: null,
        participantQuery: null,
        from: null,
        to: null,
        cursor: null,
      });
    });

    it('kind: valid kinds pass through, unknown kinds are dropped silently (fail closed, not open)', () => {
      const view = parseIssueTimelineParams({ kind: ['communication', 'not-a-real-kind', 'notice'] });
      expect(view.kinds).toEqual(['communication', 'notice']);
    });

    it('kind: a single scalar value is accepted the same as a one-element array', () => {
      expect(parseIssueTimelineParams({ kind: 'audit' }).kinds).toEqual(['audit']);
    });

    it('kind: every documented kind individually round-trips', () => {
      for (const k of ['communication', 'audit', 'phase_open', 'phase_close', 'notice']) {
        expect(parseIssueTimelineParams({ kind: k }).kinds).toEqual([k]);
      }
    });

    it('person: valid UUIDs pass through and are de-duplicated', () => {
      const id = '11111111-1111-1111-1111-111111111111';
      const view = parseIssueTimelineParams({ person: [id, id] });
      expect(view.personRefIds).toEqual([id]);
    });

    it('person: non-UUID values are dropped rather than passed through', () => {
      const view = parseIssueTimelineParams({ person: ['not-a-uuid', '11111111-1111-1111-1111-111111111111'] });
      expect(view.personRefIds).toEqual(['11111111-1111-1111-1111-111111111111']);
    });

    it('person: UUID match is case-insensitive', () => {
      const id = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
      expect(parseIssueTimelineParams({ person: id }).personRefIds).toEqual([id]);
    });

    it('direction: only inbound/outbound are accepted, anything else is null', () => {
      expect(parseIssueTimelineParams({ direction: 'inbound' }).direction).toBe('inbound');
      expect(parseIssueTimelineParams({ direction: 'outbound' }).direction).toBe('outbound');
      expect(parseIssueTimelineParams({ direction: 'sideways' }).direction).toBeNull();
      expect(parseIssueTimelineParams({}).direction).toBeNull();
    });

    it('participant: trims whitespace and drops to null when empty after trim', () => {
      expect(parseIssueTimelineParams({ participant: '  jane doe  ' }).participantQuery).toBe('jane doe');
      expect(parseIssueTimelineParams({ participant: '   ' }).participantQuery).toBeNull();
      expect(parseIssueTimelineParams({ participant: '' }).participantQuery).toBeNull();
    });

    it('participant: is length-capped at 200 chars rather than passed through unbounded', () => {
      const long = 'x'.repeat(500);
      const view = parseIssueTimelineParams({ participant: long });
      expect(view.participantQuery?.length).toBe(200);
    });

    it('from/to: valid YYYY-MM-DD strings pass through', () => {
      const view = parseIssueTimelineParams({ from: '2026-01-01', to: '2026-08-04' });
      expect(view.from).toBe('2026-01-01');
      expect(view.to).toBe('2026-08-04');
    });

    it('from/to: malformed dates (wrong shape, free text, ISO timestamps) are dropped to null rather than passed through', () => {
      expect(parseIssueTimelineParams({ from: '01/01/2026' }).from).toBeNull();
      expect(parseIssueTimelineParams({ from: 'not-a-date' }).from).toBeNull();
      expect(parseIssueTimelineParams({ from: '2026-01-01T00:00:00.000Z' }).from).toBeNull();
      expect(parseIssueTimelineParams({ from: '2026-1-1' }).from).toBeNull();
    });

    it('cursor: passed through verbatim (re-validated downstream by timeline-repo), but capped at 4000 chars', () => {
      expect(parseIssueTimelineParams({ after: 'abc123' }).cursor).toBe('abc123');
      const long = 'y'.repeat(5000);
      expect(parseIssueTimelineParams({ after: long }).cursor?.length).toBe(4000);
    });

    it('cursor: absent when the after param is absent', () => {
      expect(parseIssueTimelineParams({}).cursor).toBeNull();
    });
  });

  describe('buildIssueTimelineHref', () => {
    it('produces a bare path with no querystring when no params are present', () => {
      expect(buildIssueTimelineHref('issue-1', {})).toBe('/issues/issue-1/timeline');
    });

    it('round-trips existing search params into the href', () => {
      const sp: IssueTimelineSearchParams = { kind: 'communication', direction: 'inbound' };
      const href = buildIssueTimelineHref('issue-1', sp);
      expect(href).toBe('/issues/issue-1/timeline?kind=communication&direction=inbound');
    });

    it('overrides merge in and replace an existing key', () => {
      const sp: IssueTimelineSearchParams = { direction: 'inbound' };
      const href = buildIssueTimelineHref('issue-1', sp, { direction: 'outbound' });
      expect(href).toBe('/issues/issue-1/timeline?direction=outbound');
    });

    it('a null override removes the key entirely', () => {
      const sp: IssueTimelineSearchParams = { direction: 'inbound', kind: 'audit' };
      const href = buildIssueTimelineHref('issue-1', sp, { direction: null });
      expect(href).toBe('/issues/issue-1/timeline?kind=audit');
    });

    it('array overrides expand to repeated keys (Load more preserves multi-valued kind/person)', () => {
      const href = buildIssueTimelineHref('issue-1', {}, { kind: ['communication', 'audit'], after: 'cursor-xyz' });
      const usp = new URLSearchParams(href.split('?')[1]);
      expect(usp.getAll('kind')).toEqual(['communication', 'audit']);
      expect(usp.get('after')).toBe('cursor-xyz');
    });

    it('only the after key changes on a "Load more" style override, everything else survives', () => {
      const sp: IssueTimelineSearchParams = { kind: 'notice', person: '11111111-1111-1111-1111-111111111111' };
      const href = buildIssueTimelineHref('issue-1', sp, { after: 'next-page' });
      const usp = new URLSearchParams(href.split('?')[1]);
      expect(usp.get('kind')).toBe('notice');
      expect(usp.get('person')).toBe('11111111-1111-1111-1111-111111111111');
      expect(usp.get('after')).toBe('next-page');
    });
  });

  describe('hasActiveIssueTimelineFilters', () => {
    it('false when every field is empty/null', () => {
      expect(hasActiveIssueTimelineFilters(parseIssueTimelineParams({}))).toBe(false);
    });

    it('true when any single filter field is set', () => {
      expect(hasActiveIssueTimelineFilters(parseIssueTimelineParams({ kind: 'audit' }))).toBe(true);
      expect(hasActiveIssueTimelineFilters(parseIssueTimelineParams({ direction: 'inbound' }))).toBe(true);
      expect(hasActiveIssueTimelineFilters(parseIssueTimelineParams({ participant: 'jane' }))).toBe(true);
      expect(hasActiveIssueTimelineFilters(parseIssueTimelineParams({ from: '2026-01-01' }))).toBe(true);
      expect(hasActiveIssueTimelineFilters(parseIssueTimelineParams({ to: '2026-01-01' }))).toBe(true);
      expect(
        hasActiveIssueTimelineFilters(parseIssueTimelineParams({ person: '11111111-1111-1111-1111-111111111111' })),
      ).toBe(true);
    });

    it('cursor alone does NOT count as an active filter (pagination position, not a filter)', () => {
      expect(hasActiveIssueTimelineFilters(parseIssueTimelineParams({ after: 'some-cursor' }))).toBe(false);
    });
  });
});
