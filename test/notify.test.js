'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

test('notify.js uses spawnSync not execSync for email', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../lib/notify'), 'utf8');
  assert.ok(!src.includes('execSync('), 'notify.js should not use execSync with shell string');
  assert.ok(src.includes('spawnSync(') || src.includes('execFileSync('),
    'notify.js should use spawnSync or execFileSync');
});

test('notify.js does not interpolate variables into shell strings', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../lib/notify'), 'utf8');
  // The old vulnerable pattern was: execSync(`echo '${...}' | mail -s '${...}' '${...}'`)
  assert.ok(!src.includes('| mail'), 'should not pipe through shell to mail');
});

test('sendMail does not crash when mail binary is missing', async () => {
  // sendMail is not exported, but we can test the module loads and
  // sendScraperEmail/sendReviewEmail handle missing EMAIL_TO gracefully
  const { sendScraperEmail } = require('../lib/notify');
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, errors: 0 },
    duplicateDetails: [],
    writeErrors: [],
    elapsedMinutes: 0,
  };
  // With no EMAIL_TO set, it should return without error and report the skip
  const original = process.env.EMAIL_TO;
  delete process.env.EMAIL_TO;
  try {
    const result = await sendScraperEmail(report, null);
    assert.equal(result.skipped, true);
  } finally {
    if (original) process.env.EMAIL_TO = original;
  }
});

test('scraper subject flags errors even when some leads were written', () => {
  const { buildScraperSubject } = require('../lib/notify');
  const report = {
    dryRun: false,
    writeErrors: [{ site: 'LandWatch', error: 'boom' }],
    totals: { written: 5, duplicates: 0, rejected: 0, errors: 2 },
  };
  const subject = buildScraperSubject(report);
  assert.match(subject, /⚠️/);
  assert.match(subject, /errors/i);
});

test('dry-run subject reports would-write count instead of "No new leads"', () => {
  const { buildScraperSubject } = require('../lib/notify');
  const report = {
    dryRun: true,
    writeErrors: [],
    totals: { written: 0, wouldWrite: 12, duplicates: 3, rejected: 0, errors: 0 },
  };
  const subject = buildScraperSubject(report);
  assert.match(subject, /dry run/i);
  assert.match(subject, /12 would write/);
});

test('price-check crash is surfaced in the scraper body', () => {
  const { buildScraperBody } = require('../lib/notify');
  const report = {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 1 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 1,
    priceCheckError: 'Airtable exploded',
  };
  const body = buildScraperBody(report, null, 'Monday');
  assert.match(body, /PRICE DROP CHECK: FAILED/);
  assert.match(body, /Airtable exploded/);
});

test('review subject and body surface errors', () => {
  const { buildReviewSubject, buildReviewBody } = require('../lib/notify');
  const report = { reviewed: 3, errors: 2, standouts: [], flagged: [], autoRejected: [] };
  assert.match(buildReviewSubject(report), /2 errors/);
  assert.match(buildReviewBody(report, 'Monday'), /Errors: 2/);
});

test('consolidated body includes the lead review section', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { written: 1, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 1,
  };
  const reviewReport = {
    reviewed: 5,
    errors: 0,
    standouts: [{ name: 'Big Tract', county: 'Wayne', state: 'KY', acres: 200, price: 400000, cpa: 2000, positives: ['creek'] }],
    flagged: [{ name: 'Sketchy Tract', flags: ['hoa'] }],
    autoRejected: [],
  };
  const body = buildScraperBody(scraperReport, null, 'Monday', reviewReport);
  assert.match(body, /LEAD REVIEW/);
  assert.match(body, /Reviewed: 5 leads/);
  assert.match(body, /STANDOUT PROPERTIES/);
  assert.match(body, /Big Tract/);
  assert.match(body, /Sketchy Tract/);
});

test('LARGE TRACTS section renders every large tract regardless of score, in addition to standouts', () => {
  const { buildReviewBody } = require('../lib/notify');
  const report = {
    reviewed: 2,
    errors: 0,
    standouts: [{ name: 'Sweet Spot Tract', county: 'Wayne', state: 'KY', acres: 200, price: 400000, cpa: 2000, positives: [] }],
    flagged: [],
    autoRejected: [],
    largeTracts: [{ name: 'Huge Ranch', county: 'Wayne', state: 'KY', acres: 600, price: 1200000, cpa: 2000 }],
    largeTractHighlightMin: 500,
  };
  const body = buildReviewBody(report, 'Monday');
  assert.match(body, /LARGE TRACTS \(500ac\+\)/);
  assert.match(body, /Huge Ranch/);
  assert.match(body, /600ac/);
  // Additive, not a replacement — the standout list still renders too
  assert.match(body, /STANDOUT PROPERTIES/);
  assert.match(body, /Sweet Spot Tract/);
});

test('LARGE TRACTS section is omitted entirely when there are no large tracts', () => {
  const { buildReviewBody } = require('../lib/notify');
  const report = {
    reviewed: 1,
    errors: 0,
    standouts: [],
    flagged: [],
    autoRejected: [],
    largeTracts: [],
    largeTractHighlightMin: 500,
  };
  const body = buildReviewBody(report, 'Monday');
  assert.doesNotMatch(body, /LARGE TRACTS/);
});

test('LARGE TRACTS header reflects a custom largeTractHighlightMin setting', () => {
  const { buildReviewBody } = require('../lib/notify');
  const report = {
    reviewed: 1,
    errors: 0,
    standouts: [],
    flagged: [],
    autoRejected: [],
    largeTracts: [{ name: 'Mid Tract', county: 'Wayne', state: 'KY', acres: 300, price: 600000, cpa: 2000 }],
    largeTractHighlightMin: 250,
  };
  const body = buildReviewBody(report, 'Monday');
  assert.match(body, /LARGE TRACTS \(250ac\+\)/);
  assert.match(body, /Mid Tract/);
});

test('review crash is surfaced in the consolidated body and subject', () => {
  const { buildScraperBody, buildScraperSubject } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 1 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 1,
    reviewError: 'Airtable exploded during review',
  };
  const body = buildScraperBody(scraperReport, null, 'Monday', null);
  assert.match(body, /LEAD REVIEW: FAILED/);
  assert.match(body, /Airtable exploded during review/);
  assert.match(buildScraperSubject(scraperReport, null), /⚠️/);
});

test('awaiting-decision leads appear with their age', () => {
  const { buildReviewBody } = require('../lib/notify');
  const report = {
    reviewed: 1,
    errors: 0,
    standouts: [],
    flagged: [],
    autoRejected: [],
    awaiting: [
      { name: 'Perry Tract', county: 'Perry', state: 'TN', acres: 969, price: 975000, stage: 'New Lead', ageDays: 7 },
    ],
  };
  const body = buildReviewBody(report, 'Monday');
  assert.match(body, /WAITING ON YOU IN AIRTABLE \(1\)/);
  assert.match(body, /Perry Tract/);
  assert.match(body, /waiting 7 days/);
  assert.match(body, /\(New Lead\)/);
});

test('kitchen sink: every section renders its key line, in order, with no undefined/NaN', () => {
  const { buildScraperBody } = require('../lib/notify');

  const scraperReport = {
    dryRun: false,
    sites: {
      MossyOakProperties: {
        status: 'retried_after_cooldown',
        parsed: 24, passed: 6, written: 6, duplicates: 3, checked: 24,
        earlyStoppedSeries: 2, enrichmentFetched: 6, enrichmentFailed: 1,
        rotation: { groupsTotal: 3, groupIndex: 1, sweptCount: 63, totalCount: 189 },
        cooldownMinutes: 58,
        firstPass: { parsed: 0, passed: 0 },
        retryPass: { parsed: 24, passed: 6, blockedAgain: false },
      },
      Whitetail: {
        status: 'ok', parsed: 0, passed: 0, written: 0, duplicates: 0, checked: 3,
      },
    },
    totals: { checked: 27, parsed: 24, passed: 6, duplicates: 3, rejected: 5, written: 6, wouldWrite: 0, errors: 2 },
    duplicateDetails: [
      { source: 'MossyOakProperties', name: 'Twin Creek Tract', url: 'https://x/1', reason: 'same fingerprint as LandWatch: Twin Creek', matchType: 'fingerprint' },
    ],
    writeErrors: [
      { site: 'MossyOakProperties', error: 'HTTP 422 field mismatch', savedTo: 'data/failed-writes/x.jsonl' },
    ],
    sourceIssues: [
      { source: 'MossyOakProperties', type: 'blocked', error: 'Bot-block/challenge page served with HTTP 200', county: 'Wayne', state: 'KY', url: 'https://mossy/wayne', savedTo: 'data/source-health/a.jsonl' },
      { source: 'Whitetail', type: 'markup_drift', error: 'Page fetched OK but zero listing cards matched', county: 'Butler', state: 'KY', url: 'https://whitetail/butler', savedTo: 'data/source-health/b.jsonl' },
    ],
    warnings: ['MossyOakProperties: county rotation 3 — swept 63 of 189 counties (group 2 of 3)'],
    elapsedMinutes: 96,
  };

  const priceCheckReport = {
    checked: 40, priceDrops: 3, promoted: 2, expired: 1, removed: 1, errors: 1, elapsedMinutes: 12,
    details: [
      { action: 'promoted', name: 'Cedar Ridge', oldPrice: 500000, newPrice: 450000, newCPA: 2250, target: 2500 },
    ],
  };

  const intakeReport = {
    processed: 4, created: 2, duplicates: 1, reclaimed: 1, loadError: null,
    added: [{ url: 'https://intake/1', submitter: 'Nora', summary: '160ac in Wayne, KY' }],
    failures: [
      { url: 'https://intake/2', submitter: 'Jo', error: 'timeout', final: false },
      { url: 'https://intake/3', submitter: 'Sam', error: 'bot wall', final: true },
    ],
  };

  const reviewReport = {
    reviewed: 8, errors: 1, floodChecked: 2, floodHighRisk: 1,
    standouts: [{ name: 'Big Bend', county: 'Wayne', state: 'KY', acres: 200, price: 400000, cpa: 2000, positives: ['creek', 'paved road'] }],
    flagged: [{ name: 'Iffy Tract', flags: ['hoa', 'listed as under contract'] }],
    autoRejected: [],
    awaiting: [{ name: 'Perry Tract', county: 'Perry', state: 'TN', acres: 969, price: 975000, stage: 'New Lead', ageDays: 7 }],
  };

  const body = buildScraperBody(scraperReport, priceCheckReport, 'Monday', reviewReport, intakeReport);

  // Multi-site scan and its per-site detail lines.
  assert.match(body, /NEW LISTING SCAN/);
  assert.match(body, /county rotation: swept 63 of 189 counties \(group 2 of 3\)/);
  assert.match(body, /retried after 58 min cooldown — succeeded/);
  assert.match(body, /incremental: stopped 2 county series early/);
  assert.match(body, /detail pages fetched: 6 \(1 failed\)/);
  assert.match(body, /3 duplicates caught/);
  assert.match(body, /TOTALS: 6 written, 3 dupes, 5 rejected/);
  assert.match(body, /Runtime: 96 minutes/);

  // Warnings.
  assert.match(body, /WARNINGS/);

  // Price check + promotion.
  assert.match(body, /PRICE DROP CHECK/);
  assert.match(body, /Promoted to leads: 2/);
  assert.match(body, /PROMOTED TO LEADS/);
  assert.match(body, /Cedar Ridge/);
  assert.match(body, /450,000/);

  // Intake results (both retry and given-up buckets).
  assert.match(body, /LISTING INTAKE/);
  assert.match(body, /Processed: 4 \| Added: 2 \| Duplicates: 1/);
  assert.match(body, /WILL RETRY AUTOMATICALLY TOMORROW NIGHT/);
  assert.match(body, /FAILED ON RETRY — GIVEN UP/);

  // Review standouts / flagged / awaiting.
  assert.match(body, /LEAD REVIEW/);
  assert.match(body, /Reviewed: 8 leads/);
  assert.match(body, /STANDOUT PROPERTIES/);
  assert.match(body, /Big Bend/);
  assert.match(body, /FLAGGED/);
  assert.match(body, /Iffy Tract/);
  assert.match(body, /WAITING ON YOU IN AIRTABLE/);
  assert.match(body, /Perry Tract/);

  // Cross-site dupes + write errors.
  assert.match(body, /CROSS-SITE DUPLICATES CAUGHT/);
  assert.match(body, /Twin Creek Tract/);
  assert.match(body, /WRITE ERRORS/);
  assert.match(body, /HTTP 422 field mismatch/);

  // Diagnosis renders ABOVE the raw source-health evidence.
  assert.match(body, /SITE DIAGNOSIS/);
  assert.match(body, /SOURCE HEALTH ISSUES/);
  assert.ok(
    body.indexOf('SITE DIAGNOSIS') < body.indexOf('SOURCE HEALTH ISSUES'),
    'SITE DIAGNOSIS must appear above SOURCE HEALTH ISSUES',
  );

  // No formatting holes anywhere in the fully-populated body.
  assert.ok(!body.includes('undefined'), 'no "undefined" in the rendered body');
  assert.ok(!body.includes('NaN'), 'no "NaN" in the rendered body');
});

// Regression coverage for the "TuttLand: 0 checked -> may be blocked or down"
// false alarm: a run whose target counties fall entirely outside a source's
// coverage (searchUrlsPlanned === 0) must be reported as skipped, not as a
// site issue — while a genuinely-zero-results site (urls WERE planned and
// fetched) must keep alarming exactly as before.
test('a zero-planned site is reported as skipped, not as a site issue; a genuinely-zero-results site still alarms', () => {
  const { buildScraperBody, buildScraperSubject } = require('../lib/notify');
  const scraperReport = {
    dryRun: true,
    sites: {
      TuttLand: {
        status: 'ok', parsed: 0, passed: 0, wouldWrite: 0, duplicates: 0, checked: 0,
        searchUrlsPlanned: 0,
      },
      WhitetailProperties: {
        status: 'ok', parsed: 0, passed: 0, wouldWrite: 0, duplicates: 0, checked: 5,
        searchUrlsPlanned: 12,
      },
    },
    totals: { checked: 5, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 5,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');

  // TuttLand: skip line, not the misleading "0 checked -> 0 passed -> 0 new".
  assert.match(body, /TuttLand: no target counties in this source's coverage this run — skipped/);
  assert.ok(!/TuttLand: 0 checked/.test(body), 'zero-planned site must not render the "0 checked" scan line');

  // SITE ISSUES: only the genuinely-blocked site appears, TuttLand is excluded.
  assert.match(body, /⚠️ SITE ISSUES/);
  assert.match(body, /WhitetailProperties: Zero results — may be blocked or down/);
  assert.ok(
    !/TuttLand: Zero results — may be blocked or down/.test(body),
    'zero-planned site must not appear in SITE ISSUES'
  );

  // Subject/counts are unaffected by the zero-planned site.
  const subject = buildScraperSubject(scraperReport);
  assert.doesNotMatch(subject, /⚠️/);
});

test('standouts appear in the consolidated subject', () => {
  const { buildScraperSubject } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    writeErrors: [],
    totals: { written: 2, duplicates: 0, rejected: 0, errors: 0 },
  };
  const reviewReport = { reviewed: 3, errors: 0, standouts: [{ name: 'A' }], flagged: [], autoRejected: [] };
  const subject = buildScraperSubject(scraperReport, reviewReport);
  assert.match(subject, /2 new leads/);
  assert.match(subject, /1 standout/);
});

// ---------- skipped-unavailable / rejected-below-minimum accounting ----------

test('SKIPPED section renders name + matched phrase + URL, per-site sub-lines show counts, sorted biggest-first', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {
      LandWatch: {
        status: 'ok', parsed: 10, passed: 2, written: 1, duplicates: 0, checked: 10,
        rejectedBelowMinAcres: 1, skippedUnavailable: 2,
      },
    },
    totals: {
      checked: 10, parsed: 10, passed: 1, duplicates: 0, rejected: 1, written: 1, wouldWrite: 0, errors: 0,
      rejectedBelowMinAcres: 1, skippedUnavailable: 2,
    },
    duplicateDetails: [],
    skippedUnavailable: [
      { source: 'LandWatch', name: 'Small Pending Tract', url: 'https://lw/small', phrase: 'under contract', acres: 20 },
      { source: 'LandWatch', name: 'Big Pending Tract', url: 'https://lw/big', phrase: 'sale pending', acres: 300 },
    ],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 4,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');

  // Per-site sub-lines (count only).
  assert.match(body, /\(1 rejected: below minimum acreage\)/);
  assert.match(body, /\(2 skipped: already unavailable — see SKIPPED section below\)/);

  // TOTALS line carries both new numbers.
  assert.match(body, /2 skipped \(already unavailable\)/);
  assert.match(body, /1 of the rejected were below the minimum acreage floor/);

  // Itemized SKIPPED section: name + matched phrase + URL.
  assert.match(body, /SKIPPED — LISTING UNAVAILABLE/);
  assert.match(body, /LandWatch: Big Pending Tract — matched "sale pending"/);
  assert.match(body, /https:\/\/lw\/big/);
  assert.match(body, /LandWatch: Small Pending Tract — matched "under contract"/);
  assert.match(body, /https:\/\/lw\/small/);

  // Biggest tract first (300ac before 20ac), regardless of insertion order.
  assert.ok(
    body.indexOf('Big Pending Tract') < body.indexOf('Small Pending Tract'),
    'the 300ac listing must render before the 20ac listing'
  );
});

test('CROSS-SITE DUPLICATES CAUGHT is sorted biggest-tract-first', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 2, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [
      { source: 'LandWatch', name: 'Small Dup', url: 'https://x/1', reason: 'same fingerprint', matchType: 'fingerprint', acres: 40 },
      { source: 'LandWatch', name: 'Huge Dup', url: 'https://x/2', reason: 'same fingerprint', matchType: 'fingerprint', acres: 500 },
    ],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 4,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');
  assert.ok(
    body.indexOf('Huge Dup') < body.indexOf('Small Dup'),
    'the 500ac duplicate must render before the 40ac duplicate'
  );
});

test('no skipped-unavailable / rejected-below-min listings renders neither section, no undefined/NaN', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: { LandWatch: { status: 'ok', parsed: 5, passed: 5, written: 5, duplicates: 0, checked: 5 } },
    totals: { checked: 5, parsed: 5, passed: 5, duplicates: 0, rejected: 0, written: 5, wouldWrite: 0, errors: 0 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 2,
  };
  const body = buildScraperBody(scraperReport, null, 'Monday');
  assert.ok(!/SKIPPED — LISTING UNAVAILABLE/.test(body));
  assert.ok(!body.includes('undefined'));
  assert.ok(!body.includes('NaN'));
});
