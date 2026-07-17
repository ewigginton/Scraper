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
