/**
 * issues-view.test.ts — coverage for app/_lib/issues-view.ts's saved-view
 * round-trip helpers (queryStringFromParamsObject, toPlainParamsObject,
 * parseColumns, parseGroup) and buildIssuesHref (P2 testing-gap finding:
 * this module previously had zero direct test coverage despite being the
 * page-local param plumbing behind saved views — a feature specifically
 * meant to make filter configurations trustworthy/shareable). Follows the
 * pattern established by test/issue-timeline-view.test.ts and
 * test/activity-view.test.ts for the sibling view modules.
 *
 * loadGroupedIssues (the one DB-touching export) is intentionally left to
 * integration coverage elsewhere (app/issues/page.tsx exercises it
 * end-to-end); this file is pure-function coverage only.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_COLUMNS,
  DEFAULT_COLUMNS,
  buildIssuesHref,
  parseIssuesViewParams,
  queryStringFromParamsObject,
  toPlainParamsObject,
  type ColumnKey,
  type IssuesSearchParams,
} from '../app/_lib/issues-view.ts';

describe('parseIssuesViewParams — columns (cols=)', () => {
  it('defaults to DEFAULT_COLUMNS when cols is absent', () => {
    expect(parseIssuesViewParams({}).columns).toEqual(DEFAULT_COLUMNS);
  });

  it('accepts the repeated-key form (string[]) the columns menu checkboxes submit', () => {
    const view = parseIssuesViewParams({ cols: ['type', 'stage'] });
    // 'property' is always-visible and gets added regardless.
    expect(view.columns).toEqual(['property', 'type', 'stage']);
  });

  it('accepts a single comma-joined value (a hand-built/shared URL)', () => {
    const view = parseIssuesViewParams({ cols: 'type,stage' });
    expect(view.columns).toEqual(['property', 'type', 'stage']);
  });

  it('drops unrecognized column names rather than throwing', () => {
    const view = parseIssuesViewParams({ cols: 'type,not-a-real-column,stage' });
    expect(view.columns).toEqual(['property', 'type', 'stage']);
  });

  it('falls back to DEFAULT_COLUMNS when every requested column is invalid', () => {
    const view = parseIssuesViewParams({ cols: 'bogus1,bogus2' });
    expect(view.columns).toEqual(DEFAULT_COLUMNS);
  });

  it('falls back to DEFAULT_COLUMNS for an empty cols value', () => {
    expect(parseIssuesViewParams({ cols: '' }).columns).toEqual(DEFAULT_COLUMNS);
  });

  it('always includes the always-visible "property" column even if not requested', () => {
    const view = parseIssuesViewParams({ cols: 'stage' });
    expect(view.columns).toContain('property');
  });

  it('re-orders requested columns back to ALL_COLUMNS canonical order regardless of input order', () => {
    const view = parseIssuesViewParams({ cols: 'updated,type' });
    const order = ALL_COLUMNS.map((c) => c.key);
    const indices = view.columns.map((c) => order.indexOf(c as ColumnKey));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe('parseIssuesViewParams — group (group=)', () => {
  it('defaults to null (flat mode) when group is absent', () => {
    expect(parseIssuesViewParams({}).group).toBeNull();
  });

  it('accepts lifecycle_status and issue_type', () => {
    expect(parseIssuesViewParams({ group: 'lifecycle_status' }).group).toBe('lifecycle_status');
    expect(parseIssuesViewParams({ group: 'issue_type' }).group).toBe('issue_type');
  });

  it('falls back to null for anything not on the allowlist, rather than throwing', () => {
    expect(parseIssuesViewParams({ group: 'not-a-real-group' }).group).toBeNull();
    expect(parseIssuesViewParams({ group: ["'; drop table issues; --"] }).group).toBeNull();
  });
});

describe('parseIssuesViewParams — filters', () => {
  it('parses every filter field with safe defaults when nothing is present', () => {
    const view = parseIssuesViewParams({});
    expect(view.filters).toEqual({
      issueTypes: [],
      lifecycleStatuses: [],
      states: [],
      priorities: [],
      coordinatorOrQueue: null,
      overdueOnly: false,
      searchText: null,
    });
  });

  it('splits the comma-joined `state` param unlike every other array-shaped filter', () => {
    const view = parseIssuesViewParams({ state: 'TX,OK,KY' });
    expect(view.filters.states).toEqual(['TX', 'OK', 'KY']);
  });

  it('overdue=1 is the only value that sets overdueOnly true', () => {
    expect(parseIssuesViewParams({ overdue: '1' }).filters.overdueOnly).toBe(true);
    expect(parseIssuesViewParams({ overdue: 'true' }).filters.overdueOnly).toBe(false);
    expect(parseIssuesViewParams({}).filters.overdueOnly).toBe(false);
  });

  it('trims and null-ifies empty owner/search strings', () => {
    expect(parseIssuesViewParams({ owner: '  ', q: '  ' }).filters.coordinatorOrQueue).toBeNull();
    expect(parseIssuesViewParams({ owner: '  alice  ' }).filters.coordinatorOrQueue).toBe('alice');
  });

  it('extracts sort/cursor from sort/dir/after', () => {
    const view = parseIssuesViewParams({ sort: 'priority', dir: 'asc', after: 'cursor-value' });
    expect(view.sort).toEqual({ key: 'priority', direction: 'asc' });
    expect(view.cursor).toBe('cursor-value');
  });
});

describe('buildIssuesHref', () => {
  it('returns the bare /issues path when there are no params', () => {
    expect(buildIssuesHref({})).toBe('/issues');
  });

  it('preserves existing params and serializes array values as repeated keys', () => {
    const href = buildIssuesHref({ type: ['default_recovery', 'covenant_violation'], sort: 'priority' });
    const usp = new URLSearchParams(href.split('?')[1]);
    expect(usp.getAll('type')).toEqual(['default_recovery', 'covenant_violation']);
    expect(usp.get('sort')).toBe('priority');
  });

  it('an override of null DELETES that key', () => {
    const href = buildIssuesHref({ sort: 'priority', dir: 'asc' }, { sort: null });
    const usp = new URLSearchParams(href.split('?')[1]);
    expect(usp.has('sort')).toBe(false);
    expect(usp.get('dir')).toBe('asc');
  });

  it('an override with a value REPLACES that key', () => {
    const href = buildIssuesHref({ sort: 'priority' }, { sort: 'updated_at' });
    const usp = new URLSearchParams(href.split('?')[1]);
    expect(usp.get('sort')).toBe('updated_at');
  });

  it('an omitted override key keeps whatever sp already had (undefined ≠ delete)', () => {
    const href = buildIssuesHref({ sort: 'priority', dir: 'asc' }, {});
    const usp = new URLSearchParams(href.split('?')[1]);
    expect(usp.get('sort')).toBe('priority');
    expect(usp.get('dir')).toBe('asc');
  });

  it('drops empty-string values entirely rather than emitting `key=`', () => {
    const href = buildIssuesHref({ q: '' });
    expect(href).toBe('/issues');
  });
});

describe('toPlainParamsObject / queryStringFromParamsObject round-trip', () => {
  const ROUND_TRIP_PARAM_KEYS = ['type', 'status', 'state', 'priority', 'owner', 'overdue', 'q', 'sort', 'dir', 'cols', 'group'] as const;

  it('drops `after` (pagination cursor) — a saved view is never pinned to a page', () => {
    const plain = toPlainParamsObject({ sort: 'priority', after: 'some-cursor' });
    expect(plain).not.toHaveProperty('after');
    expect(plain.sort).toBe('priority');
  });

  it('drops keys outside ROUND_TRIP_PARAM_KEYS', () => {
    const plain = toPlainParamsObject({ sort: 'priority', notARealParam: 'x' } as unknown as IssuesSearchParams);
    expect(plain).not.toHaveProperty('notARealParam');
  });

  /** Mirrors how Next.js's App Router hands back resolved searchParams: a key with one occurrence becomes a scalar, more than one becomes a string[]. */
  function searchParamsFromQueryString(qs: string): IssuesSearchParams {
    const usp = new URLSearchParams(qs);
    const out: IssuesSearchParams = {};
    for (const key of new Set(usp.keys())) {
      const values = usp.getAll(key);
      out[key] = values.length > 1 ? values : values[0];
    }
    return out;
  }

  it('REGRESSION (round-trip property): every ROUND_TRIP_PARAM_KEYS entry survives toPlainParamsObject -> queryStringFromParamsObject -> re-parse, including the comma-split `state` param', () => {
    const original: IssuesSearchParams = {
      type: ['default_recovery', 'covenant_violation'],
      status: ['active', 'waiting'],
      state: 'TX,OK,KY', // scalar comma-joined, unlike the other array-shaped params
      priority: ['high', 'urgent'],
      owner: 'alice',
      overdue: '1',
      q: 'search text',
      sort: 'priority',
      dir: 'desc',
      cols: 'type,stage',
      group: 'lifecycle_status',
      // Not in ROUND_TRIP_PARAM_KEYS — must NOT survive the round trip.
      after: 'some-cursor',
    };

    const plain = toPlainParamsObject(original);
    const queryString = queryStringFromParamsObject(plain);
    expect(queryString).not.toContain('after=');

    // Re-parse the querystring the same way loading a saved view actually
    // would (Next.js searchParams -> parseIssuesViewParams), and compare
    // against parsing the ORIGINAL params directly — the two must agree on
    // every filter/sort/columns/group the saved view is supposed to
    // reproduce (cursor is excluded on both sides: it's never saved).
    const reparsedView = parseIssuesViewParams(searchParamsFromQueryString(queryString));
    const originalView = parseIssuesViewParams(original);

    expect(reparsedView.filters).toEqual(originalView.filters);
    expect(reparsedView.sort).toEqual(originalView.sort);
    expect(reparsedView.columns).toEqual(originalView.columns);
    expect(reparsedView.group).toEqual(originalView.group);
    expect(reparsedView.filters.states).toEqual(['TX', 'OK', 'KY']);
  });

  it('queryStringFromParamsObject returns empty string for non-plain-object input (null/array/primitive)', () => {
    expect(queryStringFromParamsObject(null)).toBe('');
    expect(queryStringFromParamsObject(undefined)).toBe('');
    expect(queryStringFromParamsObject(['a', 'b'])).toBe('');
    expect(queryStringFromParamsObject('a string')).toBe('');
    expect(queryStringFromParamsObject(42)).toBe('');
  });

  it('queryStringFromParamsObject ignores non-string/non-string-array values for a recognized key', () => {
    expect(queryStringFromParamsObject({ sort: 42, dir: { nested: true } })).toBe('');
  });

  it('queryStringFromParamsObject serializes an array value as repeated keys', () => {
    const qs = queryStringFromParamsObject({ type: ['default_recovery', 'covenant_violation'] });
    expect(new URLSearchParams(qs).getAll('type')).toEqual(['default_recovery', 'covenant_violation']);
  });
});
