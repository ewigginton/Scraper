'use strict';

// Feature A: the midday (12:30 PM) second run — scrape+intake only, no email
// when nothing noteworthy happened. index.js and scripts/run-scraper.sh are
// thin, untested-elsewhere glue (see index.js's total absence from any other
// test file), so their SCRAPER_MIDDAY wiring is verified by reading the
// source, the same technique test/notify.test.js already uses for notify.js.
// The actual decision logic (isMiddayRunNoteworthy, the subject marker, and
// the send-or-skip gate) lives in lib/notify.js and is exercised directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isMiddayRunNoteworthy,
  buildScraperSubject,
  sendScraperEmail,
} = require('../lib/notify');

function baseReport(overrides = {}) {
  return {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 4, rejected: 2, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [],
    elapsedMinutes: 3,
    ...overrides,
  };
}

// --- isMiddayRunNoteworthy: both directions ---------------------------------

test('isMiddayRunNoteworthy: routine dupes/rejects with nothing else is NOT noteworthy', () => {
  assert.equal(isMiddayRunNoteworthy(baseReport()), false);
});

test('isMiddayRunNoteworthy: new leads written IS noteworthy', () => {
  assert.equal(isMiddayRunNoteworthy(baseReport({ totals: { written: 1, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 } })), true);
});

test('isMiddayRunNoteworthy: a write error IS noteworthy', () => {
  assert.equal(isMiddayRunNoteworthy(baseReport({ writeErrors: [{ site: 'LandWatch', error: 'HTTP 422' }] })), true);
});

test('isMiddayRunNoteworthy: a site_abandoned source issue IS noteworthy', () => {
  assert.equal(isMiddayRunNoteworthy(baseReport({
    sourceIssues: [{ source: 'MossyOakProperties', type: 'site_abandoned', error: 'Aborted after 10 error pages' }],
  })), true);
});

test('isMiddayRunNoteworthy: a "blocked" (non-abandoned) source issue alone is NOT noteworthy', () => {
  assert.equal(isMiddayRunNoteworthy(baseReport({
    sourceIssues: [{ source: 'LandWatch', type: 'blocked', error: 'Bot-block/challenge page' }],
  })), false);
});

test('isMiddayRunNoteworthy: a crashed site (status "error") IS noteworthy', () => {
  assert.equal(isMiddayRunNoteworthy(baseReport({
    sites: { LandWatch: { status: 'error', error: 'boom' } },
  })), true);
});

// --- Subject marker ----------------------------------------------------------

test('buildScraperSubject marks a midday run with a [Midday] prefix', () => {
  const withMidday = buildScraperSubject(baseReport(), null, null, { midday: true });
  const withoutMidday = buildScraperSubject(baseReport(), null, null, {});
  assert.match(withMidday, /^\[Midday\] /);
  assert.ok(!withoutMidday.startsWith('[Midday]'));
  // Same underlying subject text, just prefixed.
  assert.equal(withMidday, `[Midday] ${withoutMidday}`);
});

test('nightly subject (no options) is unaffected by the midday feature', () => {
  const report = baseReport({ totals: { written: 3, wouldWrite: 0, duplicates: 1, rejected: 0, errors: 0 } });
  assert.equal(buildScraperSubject(report, null, null), 'CCL Scraper — 3 new leads found');
});

// --- sendScraperEmail quiet-if-empty gate: both directions ------------------

test('midday + not noteworthy: no email is sent, quiet flag is set', async (t) => {
  const original = process.env.EMAIL_TO;
  process.env.EMAIL_TO = 'emma@classiccountryland.com';
  t.after(() => {
    if (original === undefined) delete process.env.EMAIL_TO;
    else process.env.EMAIL_TO = original;
  });

  const result = await sendScraperEmail(baseReport(), null, null, null, { midday: true });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.equal(result.quiet, true);
});

test('midday + noteworthy: the quiet gate does NOT apply (falls through to normal send path)', async (t) => {
  const original = process.env.EMAIL_TO;
  delete process.env.EMAIL_TO; // Force the "no EMAIL_TO" skip path instead of a real send.
  t.after(() => {
    if (original !== undefined) process.env.EMAIL_TO = original;
  });

  const noteworthy = baseReport({ totals: { written: 2, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 } });
  const result = await sendScraperEmail(noteworthy, null, null, null, { midday: true });
  assert.equal(result.skipped, true);
  assert.notEqual(result.quiet, true, 'a noteworthy midday run must not be gated by the quiet-if-empty check');
});

test('nightly run (no midday option) always proceeds regardless of noteworthiness', async (t) => {
  const original = process.env.EMAIL_TO;
  delete process.env.EMAIL_TO;
  t.after(() => {
    if (original !== undefined) process.env.EMAIL_TO = original;
  });

  const result = await sendScraperEmail(baseReport(), null, null, null, {});
  assert.equal(result.skipped, true);
  assert.notEqual(result.quiet, true);
});

// --- index.js / scripts/run-scraper.sh wiring (source-level checks) --------

test('index.js forces skip-price-check and skip-review in midday mode', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /SCRAPER_MIDDAY/);
  assert.match(src, /skipPriceCheck\s*=.*\|\|\s*midday/);
  assert.match(src, /skipReview\s*=.*\|\|\s*midday/);
  assert.match(src, /\{\s*midday\s*\}/, 'sendScraperEmail must be called with the midday flag');
});

test('scripts/run-scraper.sh skips evidence capture in midday mode', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-scraper.sh'), 'utf8');
  assert.match(src, /SCRAPER_MIDDAY/);
  // The evidence-capture invocation itself must be gated behind a
  // SCRAPER_MIDDAY check, not run unconditionally.
  const evidenceIdx = src.indexOf('process-evidence-requests.js');
  assert.ok(evidenceIdx > -1, 'evidence capture step must still exist for nightly runs');
  const guardIdx = src.lastIndexOf('SCRAPER_MIDDAY', evidenceIdx);
  assert.ok(guardIdx > -1 && guardIdx < evidenceIdx, 'a SCRAPER_MIDDAY guard must precede the evidence-capture call');
});

test('services/com.ccl.land-scraper.midday.plist sets SCRAPER_MIDDAY=1 at 12:30 PM', () => {
  const plist = fs.readFileSync(path.join(__dirname, '..', 'services', 'com.ccl.land-scraper.midday.plist'), 'utf8');
  assert.match(plist, /<key>SCRAPER_MIDDAY<\/key>\s*<string>1<\/string>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>12<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.match(plist, /run-scraper\.sh/);
});
