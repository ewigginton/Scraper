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

// GUARD 1c/GUARD 2 — IMPLAUSIBLE and COUNTY NOT RESOLVABLE sections
// (lib/scraper.js recordRefusedWrites feeding report.filterRejects /
// report.countyUnresolved). Same rendering pattern as the SKIPPED section
// above: per-site sub-line count, TOTALS line count, itemized section
// sorted biggest-tract-first.
test('IMPLAUSIBLE and COUNTY NOT RESOLVABLE sections render counts and itemized entries, biggest tract first', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {
      LandWatch: {
        status: 'ok', parsed: 10, passed: 1, written: 1, duplicates: 0, checked: 10,
        implausible: 2, countyNotResolvable: 1,
      },
    },
    totals: {
      checked: 10, parsed: 10, passed: 1, duplicates: 0, rejected: 2, written: 1, wouldWrite: 0, errors: 0,
      implausible: 2, countyNotResolvable: 1,
    },
    duplicateDetails: [],
    filterRejects: [
      { source: 'LandWatch', name: 'Small Glued Tract', url: 'https://lw/small-glued', reason: 'Implausible data: Price and acres are identical (5000)', acres: 20 },
      { source: 'LandWatch', name: 'Big Glued Tract', url: 'https://lw/big-glued', reason: 'Implausible data: $150,000/acre is outside the plausible range', acres: 400 },
    ],
    countyUnresolved: [
      { source: 'LandWatch', name: 'Unlinked Tract', url: 'https://lw/unlinked', county: 'Ghost', state: 'ZZ', acres: 150 },
    ],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 4,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');

  // Per-site sub-lines
  assert.match(body, /\(2 rejected: implausible price\/acreage — see IMPLAUSIBLE section below\)/);
  assert.match(body, /\(1 refused: county not resolvable — see COUNTY NOT RESOLVABLE section below\)/);

  // TOTALS line
  assert.match(body, /2 of the rejected had implausible price\/acreage/);
  assert.match(body, /1 plausible listing\(s\) refused — county not resolvable/);

  // Itemized sections
  assert.match(body, /IMPLAUSIBLE — PRICE OR ACREAGE REJECTED \(FILTER AND\/OR WRITE TIME\)/);
  assert.match(body, /LandWatch: Big Glued Tract — Implausible data:/);
  assert.match(body, /https:\/\/lw\/big-glued/);
  assert.match(body, /LandWatch: Small Glued Tract — Implausible data:/);
  assert.ok(
    body.indexOf('Big Glued Tract') < body.indexOf('Small Glued Tract'),
    'the 400ac implausible listing must render before the 20ac one'
  );

  assert.match(body, /COUNTY NOT RESOLVABLE — REFUSED AT WRITE TIME/);
  assert.match(body, /LandWatch: Unlinked Tract — Ghost, ZZ/);
  assert.match(body, /https:\/\/lw\/unlinked/);

  assert.ok(!body.includes('undefined'));
  assert.ok(!body.includes('NaN'));
});

test('no implausible / county-unresolvable listings renders neither section, no undefined/NaN', () => {
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
  assert.ok(!/IMPLAUSIBLE — PRICE OR ACREAGE/.test(body));
  assert.ok(!/COUNTY NOT RESOLVABLE/.test(body));
  assert.ok(!body.includes('undefined'));
  assert.ok(!body.includes('NaN'));
});

test('PRICE DROP CHECK section renders the implausible-skipped count when present', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 1,
  };
  const priceCheckReport = {
    checked: 3, priceDrops: 0, promoted: 0, expired: 0, removed: 0, errors: 1,
    implausibleSkipped: 1, elapsedMinutes: 0.5, details: [],
  };
  const body = buildScraperBody(scraperReport, priceCheckReport, 'Monday');
  assert.match(body, /Implausible new price skipped \(not written\): 1/);
});

// B3(a): a live run aborted at the county-targets/dedup-index load step
// (index.js's outer catch, tagged via err.scraperAbort — see
// lib/scraper.js runScraper) must say plainly at the top of the email that
// the scrape never ran, and name the later steps skipped as a result —
// never render as a generic "0 written" / WRITE ERRORS failure, which looks
// like a completed run that simply failed to write.
test('scraperAborted report renders a plain top-of-email banner naming the abort reason and skipped steps', () => {
  const { buildScraperBody, buildScraperSubject } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    scraperAborted: true,
    abortStage: 'county_targets',
    abortReason: 'County targets could not be loaded from Airtable after 3 attempts — scrape aborted (live runs never fall back to local config): simulated outage',
    stepsSkipped: ['price check', 'listing intake', 'lead review', 'lead recheck'],
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 1 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 0.1,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');
  assert.match(body, /SCRAPE DID NOT RUN/);
  assert.match(body, /County targets could not be loaded from Airtable/);
  assert.match(body, /price check, listing intake, lead review, lead recheck/);
  // Must NOT read like a normal completed run with nothing to report
  assert.ok(!/NEW LISTING SCAN/.test(body));
  assert.ok(!/TOTALS: 0 written/.test(body));
  assert.ok(!/WRITE ERRORS/.test(body));

  const subject = buildScraperSubject(scraperReport, null, null);
  assert.match(subject, /SCRAPE DID NOT RUN/);
  assert.match(subject, /county targets unavailable/);
});

test('scraperAborted (dedup_index stage) names the dedup index in the subject', () => {
  const { buildScraperSubject } = require('../lib/notify');
  const scraperReport = {
    scraperAborted: true,
    abortStage: 'dedup_index',
    abortReason: 'Dedup index load failed — scrape aborted to avoid duplicate writes: simulated outage',
    stepsSkipped: ['price check', 'listing intake', 'lead review', 'lead recheck'],
    totals: { errors: 1 },
  };
  const subject = buildScraperSubject(scraperReport, null, null);
  assert.match(subject, /dedup index unavailable/);
});

// B3(b): a write-time implausible refusal (a listing that PASSED the
// filter, then was refused by lib/airtable.js's checkWriteGuard) must be
// counted and rendered separately from the filter-time implausible total —
// it was never part of totals.rejected, so folding it into the same count
// let "(N of the rejected had implausible price/acreage)" exceed the
// rejected count itself.
test('write-time implausible refusals render as their own line, separate from the filter-time implausible/rejected count', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {
      LandWatch: {
        status: 'ok', parsed: 5, passed: 2, written: 1, duplicates: 0, checked: 5,
        implausible: 1, implausibleWriteRefused: 1,
      },
    },
    totals: {
      checked: 5, parsed: 5, passed: 2, duplicates: 0, rejected: 1, written: 1, wouldWrite: 0, errors: 0,
      // 1 filter-time implausible (folded into rejected: 1) + 1 write-time
      // implausible refusal (a listing that passed filtering, so NOT part
      // of rejected): the old single `implausible` counter would have read
      // 2 here — more than the 1 rejected — which is exactly the bug.
      implausible: 1,
      implausibleWriteRefused: 1,
    },
    duplicateDetails: [],
    filterRejects: [
      { source: 'LandWatch', name: 'Filter-Time Reject', url: 'https://lw/a', reason: 'Implausible data: bad', acres: 50 },
      { source: 'LandWatch', name: 'Write-Time Refusal', url: 'https://lw/b', reason: 'Implausible data: bad', acres: 60 },
    ],
    countyUnresolved: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 1,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');
  assert.match(body, /\(1 of the rejected had implausible price\/acreage\)/);
  assert.match(body, /\(1 additional plausible-looking listing\(s\) were refused at write time for implausible price\/acreage\)/);
  // The totals line's rejected count (1) must not be contradicted by a
  // combined implausible count of 2
  assert.match(body, /1 rejected/);
});

test('isMiddayRunNoteworthy is true when the run aborted (even with no writeErrors)', () => {
  const { isMiddayRunNoteworthy } = require('../lib/notify');
  // Regression: the abort path sets scraperAborted:true and writeErrors:[]
  // (no exception reaches the writeErrors path), which used to make a
  // midday run look "quiet" and suppress the email entirely.
  const report = {
    scraperAborted: true,
    totals: {},
    writeErrors: [],
    sourceIssues: [],
    sites: {},
  };
  assert.equal(isMiddayRunNoteworthy(report), true);
});

test('isMiddayRunNoteworthy is still false for a quiet, non-aborted midday run', () => {
  const { isMiddayRunNoteworthy } = require('../lib/notify');
  const report = {
    scraperAborted: false,
    totals: { written: 0 },
    writeErrors: [],
    sourceIssues: [],
    sites: {},
  };
  assert.equal(isMiddayRunNoteworthy(report), false);
});

// DEFECT 4 regression: an abort with NO steps actually skipped (every later
// step was already off for this run's own flags) must not claim steps were
// skipped "because the scrape never completed" when none were.
test('scraperAborted banner: when stepsSkipped is empty, the body says nothing was skipped as a result rather than listing nothing', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: true,
    scraperAborted: true,
    abortStage: 'county_targets',
    abortReason: 'County targets could not be loaded from Airtable — scrape aborted: simulated outage',
    stepsSkipped: [],
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 1 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 0.2,
  };
  const body = buildScraperBody(scraperReport, null, 'Monday');
  assert.match(body, /SCRAPE DID NOT RUN/);
  assert.ok(!/Also skipped this run/.test(body));
  assert.match(body, /No other steps were skipped/);
});

// DEFECT 2: buildLeadRecheckSection must separate "page loaded but status
// not shown" and "page could not be read at all" from genuine fetch
// failures, and render removed listings under their own heading, plus any
// site-change warning.
test('buildLeadRecheckSection: distinguishes statusUnknown, unreadable, and genuine fetch failures', () => {
  const { buildLeadRecheckSection } = require('../lib/notify');
  const report = {
    totalCandidates: 10,
    checked: 6,
    // 2 genuine fetch failures + 1 statusUnknown + 1 unreadable, all rolled
    // into fetchFailed today by lib/lead-recheck.js
    fetchFailed: 4,
    skippedNoUrl: 0,
    droppedByCap: 0,
    droppedNames: [],
    underContract: [],
    acreageMismatches: [],
    statusUnknown: [{ name: 'Landflip Tract', url: 'https://landflip.example/1', note: 'no availability shown' }],
    unreadable: [{ name: 'Broken Page', url: 'https://broken.example/2', note: 'listing block not found' }],
  };
  const lines = buildLeadRecheckSection(report).join('\n');
  assert.match(lines, /⚠️ Fetch failures: 2 \(not counted as findings/);
  assert.match(lines, /Could not verify status \(page loaded, status not shown\): 1/);
  assert.match(lines, /Landflip Tract/);
  assert.match(lines, /https:\/\/landflip\.example\/1/);
  assert.match(lines, /Could not read the page: 1/);
  assert.match(lines, /Broken Page/);
  assert.match(lines, /https:\/\/broken\.example\/2/);
});

test('buildLeadRecheckSection: renders report.removed under its own heading, separate from under-contract/sold/off-market', () => {
  const { buildLeadRecheckSection } = require('../lib/notify');
  const report = {
    totalCandidates: 4,
    checked: 4,
    fetchFailed: 0,
    skippedNoUrl: 0,
    droppedByCap: 0,
    droppedNames: [],
    underContract: [
      { name: 'Still Under Contract Tract', stage: 'New Lead', url: 'https://x.example/under', phrase: 'under contract', statusKind: 'under_contract' },
    ],
    removed: [
      { name: 'Gone Tract', stage: 'New Lead', url: 'https://x.example/gone', phrase: 'listing removed (HTTP 404)', statusKind: 'removed' },
    ],
    acreageMismatches: [],
    statusUnknown: [],
    unreadable: [],
  };
  const lines = buildLeadRecheckSection(report).join('\n');
  assert.match(lines, /🗑️ LISTING REMOVED FROM SITE/);
  assert.match(lines, /Gone Tract/);
  assert.match(lines, /🚫 NOW UNDER CONTRACT \/ SOLD \/ OFF MARKET/);
  assert.match(lines, /Still Under Contract Tract/);
  // The removed tract must not also appear under the under-contract heading
  const underContractSectionEnd = lines.indexOf('🗑️');
  const underContractSection = lines.slice(0, underContractSectionEnd);
  assert.ok(!underContractSection.includes('Gone Tract'));
});

test('buildLeadRecheckSection: falls back to filtering statusKind "removed" out of underContract when report.removed is absent (older report shape)', () => {
  const { buildLeadRecheckSection } = require('../lib/notify');
  const report = {
    totalCandidates: 2,
    checked: 2,
    fetchFailed: 0,
    skippedNoUrl: 0,
    droppedByCap: 0,
    droppedNames: [],
    underContract: [
      { name: 'Gone Tract', stage: 'New Lead', url: 'https://x.example/gone', phrase: 'listing removed (HTTP 404)', statusKind: 'removed' },
    ],
    acreageMismatches: [],
    statusUnknown: [],
    unreadable: [],
  };
  const lines = buildLeadRecheckSection(report).join('\n');
  assert.match(lines, /🗑️ LISTING REMOVED FROM SITE/);
  assert.match(lines, /Gone Tract/);
  assert.ok(!/🚫 NOW UNDER CONTRACT/.test(lines));
});

test('buildLeadRecheckSection: renders a site-change warning when the recheck reports one', () => {
  const { buildLeadRecheckSection } = require('../lib/notify');
  const report = {
    totalCandidates: 1,
    checked: 1,
    fetchFailed: 0,
    skippedNoUrl: 0,
    droppedByCap: 0,
    droppedNames: [],
    underContract: [],
    acreageMismatches: [],
    statusUnknown: [],
    unreadable: [],
    siteChangeWarning: 'LandWatch markup looks changed — 0 of 40 pages recognized a listing block',
  };
  const lines = buildLeadRecheckSection(report).join('\n');
  assert.match(lines, /LandWatch markup looks changed/);
});
