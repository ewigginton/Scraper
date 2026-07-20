'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { diagnoseSite } = require('../lib/source-diagnosis');
const { buildScraperBody } = require('../lib/notify');

function make404Issue(county) {
  return { source: 'TestSite', type: 'fetch_or_parse_error', county, state: 'OK', page: 1, error: `HTTP 404 for https://example.com/${county}` };
}

function makeBlockedIssue(county) {
  return { source: 'TestSite', type: 'blocked', county, state: 'OK', page: 1, error: 'Bot-block/challenge page served with HTTP 200' };
}

function makeAbandonedIssue(n, dominantLabel) {
  return { source: 'TestSite', type: 'site_abandoned', url: null, county: null, state: null, page: null, error: `Aborted after ${n} error pages (mostly ${dominantLabel}) — remaining counties skipped this run` };
}

test('404 storm is diagnosed as action_needed with URL-structure language and stop count', () => {
  const issues = [];
  for (let i = 0; i < 10; i++) issues.push(make404Issue(`County${i}`));
  issues.push(makeAbandonedIssue(10, 'HTTP 404'));

  const siteReport = { status: 'ok', checked: 0, parsed: 0, errors: 10 };
  const diagnosis = diagnoseSite('TestSite', siteReport, issues);

  assert.ok(diagnosis, 'a 404 storm must produce a diagnosis');
  assert.equal(diagnosis.severity, 'action_needed');
  assert.match(diagnosis.headline, /returned HTTP 404/);
  assert.match(diagnosis.headline, /url structure/i);
  assert.match(diagnosis.headline, /parser needs updating/);
  assert.match(diagnosis.headline, /stopped after 10 requests/);
});

test('bot wall with a failed post-cooldown retry is diagnosed as transient mentioning the failed retry', () => {
  const issues = [];
  for (let i = 0; i < 8; i++) issues.push(makeBlockedIssue(`County${i}`));
  // The retry pass records its own (fresh) blocked issues too.
  for (let i = 0; i < 3; i++) issues.push(makeBlockedIssue(`RetryCounty${i}`));

  const siteReport = {
    status: 'retried_after_cooldown',
    checked: 0,
    parsed: 0,
    cooldownMinutes: 62,
    retryPass: { parsed: 0, passed: 0, blockedAgain: true },
  };
  const diagnosis = diagnoseSite('TestSite', siteReport, issues);

  assert.ok(diagnosis);
  assert.equal(diagnosis.severity, 'transient');
  assert.match(diagnosis.headline, /bot defense is blocking the scraper/);
  assert.match(diagnosis.headline, /blocked again/);
  assert.match(diagnosis.headline, /62-minute cooldown/);
});

test('a successful post-cooldown retry is mentioned as having gotten through', () => {
  const issues = [makeBlockedIssue('A'), makeBlockedIssue('B'), makeBlockedIssue('C')];
  const siteReport = {
    status: 'retried_after_cooldown',
    checked: 0,
    parsed: 0,
    cooldownMinutes: 61,
    retryPass: { parsed: 12, passed: 5, blockedAgain: false },
  };
  const diagnosis = diagnoseSite('TestSite', siteReport, issues);

  assert.ok(diagnosis);
  assert.equal(diagnosis.severity, 'transient');
  assert.match(diagnosis.headline, /got through \(12 found\)/);
});

test('markup drift is diagnosed as action_needed', () => {
  const issues = [
    { source: 'TestSite', type: 'markup_drift', county: 'Wayne', state: 'KY', page: 1, error: 'Page fetched OK but zero listing cards matched and no "no results" marker found — selectors may be stale' },
  ];
  const siteReport = { status: 'ok', checked: 1, parsed: 0, errors: 0 };
  const diagnosis = diagnoseSite('TestSite', siteReport, issues);

  assert.ok(diagnosis);
  assert.equal(diagnosis.severity, 'action_needed');
  assert.match(diagnosis.headline, /no listings were recognized/);
  assert.match(diagnosis.headline, /redesigned its markup/);
  assert.match(diagnosis.headline, /selectors need updating/);
});

test('timeouts/5xx dominate → diagnosed as the site being down or unstable', () => {
  const issues = [];
  for (let i = 0; i < 6; i++) {
    issues.push({ source: 'TestSite', type: 'fetch_or_parse_error', county: `C${i}`, state: 'OK', page: 1, error: 'HTTP 500 for https://example.com' });
  }
  issues.push({ source: 'TestSite', type: 'fetch_or_parse_error', county: 'C6', state: 'OK', page: 1, error: 'network timeout of 15000ms exceeded' });
  const siteReport = { status: 'ok', checked: 0, parsed: 0, errors: 7 };
  const diagnosis = diagnoseSite('TestSite', siteReport, issues);

  assert.ok(diagnosis);
  assert.equal(diagnosis.severity, 'transient');
  assert.match(diagnosis.headline, /appears to be down or unstable/);
  assert.match(diagnosis.headline, /timed out or errored/);
});

test('zero results with no dominant issue type keeps the generic "may be blocked or down" flavor', () => {
  const siteReport = { status: 'ok', checked: 3, parsed: 0, errors: 0 };
  const diagnosis = diagnoseSite('TestSite', siteReport, []);

  assert.ok(diagnosis);
  assert.equal(diagnosis.severity, 'transient');
  assert.match(diagnosis.headline, /may be blocked or down/);
});

test('mixed, non-dominant issues on an otherwise-working site produce no diagnosis', () => {
  // A handful of scattered issue types, none reaching the dominance
  // threshold, and the site still produced listings this run — not
  // noteworthy enough to call out.
  const issues = [
    make404Issue('A'),
    makeBlockedIssue('B'),
    { source: 'TestSite', type: 'fetch_or_parse_error', county: 'C', state: 'OK', page: 1, error: 'HTTP 500 for https://example.com' },
  ];
  const siteReport = { status: 'ok', checked: 40, parsed: 25, errors: 3 };
  assert.equal(diagnoseSite('TestSite', siteReport, issues), null);
});

test('a healthy site with no recorded issues produces no diagnosis', () => {
  const siteReport = { status: 'ok', checked: 20, parsed: 15, errors: 0 };
  assert.equal(diagnoseSite('TestSite', siteReport, []), null);
});

test('a crashed site (status error) is not double-diagnosed here', () => {
  const siteReport = { status: 'error', error: 'boom' };
  assert.equal(diagnoseSite('TestSite', siteReport, []), null);
});

test('SITE DIAGNOSIS renders above SOURCE HEALTH ISSUES in the consolidated email', () => {
  const issues = [];
  for (let i = 0; i < 10; i++) issues.push(make404Issue(`County${i}`));
  issues.push(makeAbandonedIssue(10, 'HTTP 404'));

  const scraperReport = {
    dryRun: false,
    sites: {
      TestSite: { status: 'ok', checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, errors: 10 },
    },
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 10 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: issues,
    warnings: [],
    elapsedMinutes: 1,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');
  assert.match(body, /SITE DIAGNOSIS/);
  assert.match(body, /SOURCE HEALTH ISSUES/);
  assert.match(body, /🔧 TestSite:/);

  const diagnosisIndex = body.indexOf('SITE DIAGNOSIS');
  const sourceHealthIndex = body.indexOf('SOURCE HEALTH ISSUES');
  assert.ok(diagnosisIndex >= 0 && sourceHealthIndex >= 0);
  assert.ok(diagnosisIndex < sourceHealthIndex, 'SITE DIAGNOSIS must render above SOURCE HEALTH ISSUES');
});

test('SITE DIAGNOSIS section is absent when no site has a diagnosis', () => {
  const scraperReport = {
    dryRun: false,
    sites: {
      TestSite: { status: 'ok', checked: 20, parsed: 15, passed: 10, duplicates: 0, rejected: 0, errors: 0 },
    },
    totals: { written: 10, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    elapsedMinutes: 1,
  };

  const body = buildScraperBody(scraperReport, null, 'Monday');
  assert.ok(!body.includes('SITE DIAGNOSIS'), 'no diagnoses means no section');
});
