'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summarizeRun, recordRun, loadRunHistory, historyPath } = require('../lib/run-history');

function withTempDataDir(fn) {
  const original = process.env.SCRAPER_DATA_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-run-history-'));
  process.env.SCRAPER_DATA_DIR = tempDir;
  try {
    return fn(tempDir);
  } finally {
    if (original === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const sampleReport = {
  dryRun: true,
  elapsedMinutes: 4.2,
  totals: { checked: 30, parsed: 12, passed: 3, written: 0, wouldWrite: 3, duplicates: 5, rejected: 4, errors: 1 },
  sites: {
    landflip: {
      status: 'ok', checked: 20, parsed: 8, passed: 2, duplicates: 4, rejected: 2, errors: 0,
      searchUrlsPlanned: 6, sourceIssues: [],
    },
    tuttland: {
      status: 'ok', checked: 10, parsed: 4, passed: 1, duplicates: 1, rejected: 2, errors: 2,
      searchUrlsPlanned: 3,
      sourceIssues: [
        { type: 'fetch_or_parse_error', url: 'https://tuttland.com/search?q=secret', error: 'HTTP 404 at https://tuttland.com/x' },
        { type: 'blocked', url: 'https://tuttland.com/blocked', error: 'HTTP 403' },
        { type: 'site_abandoned', error: 'Aborted after 5 error pages' },
      ],
    },
  },
};

test('summarizeRun captures per-site stats and tallies issues by category', () => {
  const record = summarizeRun(sampleReport, { date: new Date('2026-07-20T08:00:00Z') });

  assert.equal(record.date, '2026-07-20');
  assert.equal(record.dryRun, true);
  assert.equal(record.totals.wouldWrite, 3);

  const landflip = record.sites.landflip;
  assert.equal(landflip.status, 'ok');
  assert.equal(landflip.parsed, 8);
  assert.equal(landflip.passed, 2);
  assert.equal(landflip.issueTotal, 0);

  const tutt = record.sites.tuttland;
  // site_abandoned is excluded from the tally but remembered as a flag.
  assert.equal(tutt.issueTotal, 2);
  assert.equal(tutt.issueCounts.not_found, 1);
  assert.equal(tutt.issueCounts.bot_wall, 1);
  assert.equal(tutt.abandoned, true);
  assert.equal(tutt.abandonedAfter, 5);
});

test('summarizeRun scrubs URLs out of issue messages', () => {
  const record = summarizeRun(sampleReport, { date: new Date('2026-07-20T08:00:00Z') });
  const messages = record.sites.tuttland.issues.map(i => i.error);
  for (const message of messages) {
    assert.ok(!/https?:\/\//i.test(message), `issue message should not contain a URL: ${message}`);
  }
  // No raw listing URL is stored anywhere on the summarized issue.
  assert.ok(!JSON.stringify(record).includes('q=secret'));
});

test('recordRun appends, is readable, and prunes entries older than retention', () => {
  withTempDataDir(() => {
    // An old entry that should be pruned, and a recent one that should stay.
    recordRun(sampleReport, { date: new Date('2026-01-01T08:00:00Z') });
    recordRun(sampleReport, { date: new Date('2026-07-25T08:00:00Z') });
    recordRun(sampleReport, { date: new Date('2026-07-26T08:00:00Z') });

    const history = loadRunHistory();
    const dates = history.map(h => h.date);
    assert.ok(!dates.includes('2026-01-01'), 'entry older than 60 days should be pruned');
    assert.deepEqual(dates, ['2026-07-25', '2026-07-26']);
    assert.ok(fs.existsSync(historyPath()));
  });
});

test('loadRunHistory tolerates a missing file and skips corrupt lines', () => {
  withTempDataDir((dir) => {
    assert.deepEqual(loadRunHistory(), []);

    fs.mkdirSync(path.join(dir, 'run-history'), { recursive: true });
    const good = JSON.stringify(summarizeRun(sampleReport, { date: new Date('2026-07-26T08:00:00Z') }));
    fs.writeFileSync(historyPath(), `${good}\nthis is not json\n{"partial":true}\n`, 'utf8');

    const history = loadRunHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].date, '2026-07-26');
  });
});

test('loadRunHistory { limit } keeps only the most recent N runs', () => {
  withTempDataDir(() => {
    for (const day of ['21', '22', '23', '24']) {
      recordRun(sampleReport, { date: new Date(`2026-07-${day}T08:00:00Z`) });
    }
    const recent = loadRunHistory({ limit: 2 });
    assert.deepEqual(recent.map(h => h.date), ['2026-07-23', '2026-07-24']);
  });
});
