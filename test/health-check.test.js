'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifySite, analyzeLatestRun, trailingStats, CATEGORIES, needsAttention } = require('../lib/health-check');

// Build a per-site run summary in lib/run-history's shape. `issues` is a list
// of {type, error}; issueCounts/issueTotal are derived so tests read cleanly.
function site(overrides = {}) {
  const issues = overrides.issues || [];
  const counts = { not_found: 0, bot_wall: 0, drift: 0, server_error: 0, other_error: 0 };
  for (const issue of issues) {
    if (issue.type === 'blocked') counts.bot_wall++;
    else if (issue.type === 'markup_drift') counts.drift++;
    else {
      const status = /HTTP (\d{3})/.exec(issue.error || '');
      if (status && status[1] === '404') counts.not_found++;
      else if (status && ['400', '403', '429', '503'].includes(status[1])) counts.bot_wall++;
      else if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(issue.error || '')) counts.server_error++;
      else counts.other_error++;
    }
  }
  return {
    status: 'ok', checked: 20, parsed: 8, passed: 2, duplicates: 0, rejected: 0, errors: 0,
    searchUrlsPlanned: 6, issueCounts: counts, issueTotal: issues.length, issues,
    ...overrides,
  };
}

function priorRuns(parsedValues) {
  return parsedValues.map(parsed => site({ parsed, passed: Math.min(parsed, 2) }));
}

test('trailingStats computes median/max/min and handles empty input', () => {
  assert.deepEqual(trailingStats([]), { n: 0, median: 0, max: 0, min: 0 });
  assert.deepEqual(trailingStats([5, 6, 7]), { n: 3, median: 6, max: 7, min: 5 });
  assert.equal(trailingStats([9, 10, 11, 12]).median, 11);
});

test('a crashed site is Failed', () => {
  const result = classifySite('landflip', site({ status: 'error', error: 'boom', parsed: 0 }), []);
  assert.equal(result.category, CATEGORIES.FAILED);
  assert.equal(result.transient, false);
});

test('a dominant bot wall is Access restricted and flagged transient', () => {
  const blocked = site({ parsed: 0, issues: Array.from({ length: 5 }, () => ({ type: 'blocked', error: 'HTTP 403' })) });
  const result = classifySite('mossyoak', blocked, priorRuns([6, 7, 8]));
  assert.equal(result.category, CATEGORIES.ACCESS);
  assert.equal(result.transient, true);
  assert.match(result.recommendedAction, /STOP/);
});

test('a bot wall that the retry got through is only anomalous', () => {
  const retried = site({
    parsed: 5, retried: true, blockedAgain: false,
    issues: Array.from({ length: 4 }, () => ({ type: 'blocked', error: 'HTTP 429' })),
  });
  const result = classifySite('mossyoak', retried, priorRuns([6, 7]));
  assert.equal(result.category, CATEGORIES.ANOMALOUS);
  assert.equal(result.transient, true);
});

test('a 404 storm is Failed (parser needs updating)', () => {
  const notFound = site({ parsed: 0, issues: Array.from({ length: 5 }, () => ({ type: 'fetch_or_parse_error', error: 'HTTP 404' })) });
  const result = classifySite('landflip', notFound, priorRuns([9, 10]));
  assert.equal(result.category, CATEGORIES.FAILED);
  assert.equal(result.transient, false);
  assert.match(result.cause, /404|URL/i);
});

test('markup drift is Failed', () => {
  const drift = site({ parsed: 0, issues: [{ type: 'markup_drift', error: 'no listings recognized' }] });
  const result = classifySite('whitetail', drift, priorRuns([4, 5]));
  assert.equal(result.category, CATEGORIES.FAILED);
});

test('a site that is down (server errors, zero results) is Failed but transient', () => {
  const down = site({ parsed: 0, issues: Array.from({ length: 4 }, () => ({ type: 'fetch_or_parse_error', error: 'network timeout' })) });
  const result = classifySite('nationalland', down, priorRuns([5, 6]));
  assert.equal(result.category, CATEGORIES.FAILED);
  assert.equal(result.transient, true);
  assert.match(result.recommendedAction, /do not change code/i);
});

test('zero results with no baseline is Successful, not broken', () => {
  const result = classifySite('tuttland', site({ parsed: 0 }), []);
  assert.equal(result.category, CATEGORIES.SUCCESS);
  assert.match(result.cause, /no baseline/i);
});

test('zero results when recent runs were also zero is Successful (legitimately quiet)', () => {
  const result = classifySite('tuttland', site({ parsed: 0 }), priorRuns([0, 0, 0]));
  assert.equal(result.category, CATEGORIES.SUCCESS);
  assert.match(result.cause, /consistent/i);
});

test('zero results against a reliably-nonzero baseline Needs human review', () => {
  const result = classifySite('landflip', site({ parsed: 0 }), priorRuns([5, 6, 7, 6, 5]));
  assert.equal(result.category, CATEGORIES.REVIEW);
  assert.match(result.cause, /median/);
});

test('an unusually low but nonzero result is anomalous', () => {
  const result = classifySite('landflip', site({ parsed: 1 }), priorRuns([10, 12, 11, 9]));
  assert.equal(result.category, CATEGORIES.ANOMALOUS);
});

test('a normal result within range is Successful', () => {
  const result = classifySite('landflip', site({ parsed: 8, passed: 3 }), priorRuns([7, 8, 9]));
  assert.equal(result.category, CATEGORIES.SUCCESS);
});

test('a run with no target counties in coverage is a no-op Success', () => {
  const result = classifySite('livingthedream', site({ parsed: 0, searchUrlsPlanned: 0, issueTotal: 0, issues: [] }), []);
  assert.equal(result.category, CATEGORIES.SUCCESS);
  assert.match(result.cause, /coverage/i);
});

test('needsAttention is true only for actionable categories', () => {
  assert.equal(needsAttention(CATEGORIES.FAILED), true);
  assert.equal(needsAttention(CATEGORIES.ACCESS), true);
  assert.equal(needsAttention(CATEGORIES.REVIEW), true);
  assert.equal(needsAttention(CATEGORIES.ANOMALOUS), false);
  assert.equal(needsAttention(CATEGORIES.SUCCESS), false);
});

test('analyzeLatestRun compares the newest run against prior comparable runs', () => {
  const history = [
    { date: '2026-07-24', dryRun: true, midday: false, totals: { wouldWrite: 3 },
      sites: { landflip: site({ parsed: 9 }), tuttland: site({ parsed: 4 }) } },
    { date: '2026-07-25', dryRun: true, midday: false, totals: { wouldWrite: 4 },
      sites: { landflip: site({ parsed: 8 }), tuttland: site({ parsed: 5 }) } },
    { date: '2026-07-26', dryRun: true, midday: false, totals: { wouldWrite: 0 },
      sites: {
        landflip: site({ parsed: 0, issues: Array.from({ length: 5 }, () => ({ type: 'fetch_or_parse_error', error: 'HTTP 404' })) }),
        tuttland: site({ parsed: 5 }),
      } },
  ];

  const analysis = analyzeLatestRun(history, { sites: ['landflip', 'tuttland', 'whitetail'] });
  assert.equal(analysis.runDate, '2026-07-26');
  assert.equal(analysis.hasBaseline, true);

  const byName = Object.fromEntries(analysis.sites.map(s => [s.name, s]));
  assert.equal(byName.landflip.category, CATEGORIES.FAILED);
  assert.equal(byName.tuttland.category, CATEGORIES.SUCCESS);
  // An enabled site that produced no entry this run must surface, not vanish.
  assert.equal(byName.whitetail.category, CATEGORIES.REVIEW);
  assert.match(analysis.overall, /Action needed/);
});

test('analyzeLatestRun reports cleanly when there is no history', () => {
  const analysis = analyzeLatestRun([], { sites: ['landflip'] });
  assert.equal(analysis.runDate, null);
  assert.equal(analysis.hasBaseline, false);
  assert.deepEqual(analysis.missing, ['landflip']);
});

test('live and midday runs are not compared against dry-run baselines', () => {
  const history = [
    { date: '2026-07-24', dryRun: false, midday: false, totals: {}, sites: { landflip: site({ parsed: 9 }) } },
    { date: '2026-07-25', dryRun: true, midday: false, totals: {}, sites: { landflip: site({ parsed: 0 }) } },
  ];
  // Latest is a dry run with no comparable prior dry run → no baseline, so a
  // zero result is Successful (not broken), not judged against the live run.
  const analysis = analyzeLatestRun(history, { sites: ['landflip'] });
  assert.equal(analysis.hasBaseline, false);
  assert.equal(analysis.sites[0].category, CATEGORIES.SUCCESS);
});
