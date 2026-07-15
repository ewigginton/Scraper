'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Deterministic even when run outside npm test: intake failures here must
// come from the plain fetch, not a real browser launch
process.env.SCRAPER_BROWSER_FALLBACK = 'false';
// Integration tests below serve fixtures from 127.0.0.1; allow intake's SSRF
// guard to fetch loopback for those. The dedicated SSRF test toggles this off.
process.env.SCRAPER_ALLOW_LOOPBACK_FETCH = 'true';

const airtable = require('../lib/airtable');
const { locationKey } = require('../lib/fingerprint');
const { processIntakeQueue, extractListingDetails, extractAcres, extractCountyState, cleanTitle } = require('../lib/intake');

const LISTING_HTML = `<html><head>
  <title>Headwaters Ranch - 1,118 Acres in Pittsburg County | Republic Ranches</title>
  <meta property="og:title" content="Headwaters Ranch - 1,118 Acres in Pittsburg County">
  <meta property="og:description" content="Recreational and hunting property located in northwest Pittsburg County, Oklahoma.">
  <script type="application/ld+json">{"@type":"Product","offers":{"price":"3018654"}}</script>
</head><body>
  <h1>Headwaters Ranch</h1>
  <p>1,118 acres of recreational and hunting property in Pittsburg County, Oklahoma.</p>
</body></html>`;

function stubAirtable(t, { queue, dedupIndex, counties }) {
  const original = {
    getIntakeQueue: airtable.getIntakeQueue,
    loadDedupIndex: airtable.loadDedupIndex,
    updateIntakeRecord: airtable.updateIntakeRecord,
    createLeadRecord: airtable.createLeadRecord,
    listAllCounties: airtable.listAllCounties,
  };
  const calls = { intakeUpdates: [], createdLeads: [] };
  airtable.getIntakeQueue = async () => queue;
  airtable.loadDedupIndex = async () => dedupIndex
    || { urlSet: new Set(), fingerprintSet: new Set(), locationMap: new Map(), records: [] };
  airtable.updateIntakeRecord = async (id, fields) => { calls.intakeUpdates.push({ id, fields }); };
  airtable.createLeadRecord = async listing => { calls.createdLeads.push(listing); return 'recCreatedLand01X'; };
  airtable.listAllCounties = () => counties || [{ county: 'Pittsburg', state: 'OK' }, { county: 'Wayne', state: 'KY' }];
  t.after(() => Object.assign(airtable, original));
  return calls;
}

test('extractAcres picks the property acreage out of page text', () => {
  assert.equal(extractAcres('a beautiful 1,118 acres ranch, also 1,118 acres of timber, near a 5 acre pond'), 1118);
  assert.equal(extractAcres('Lot size: 42.5 Acres'), 42.5);
  assert.equal(extractAcres('155± Acres in Wayne County'), 155);
  assert.equal(extractAcres('30 +/- acres of pasture'), 30);
  assert.equal(extractAcres('no acreage mentioned here'), null);
});

test('cleanTitle strips site suffixes', () => {
  assert.equal(cleanTitle('Headwaters Ranch - 1,118 Acres | Republic Ranches'), 'Headwaters Ranch - 1,118 Acres');
  assert.equal(cleanTitle(null), null);
});

test('extractListingDetails pulls name, price, acres, and county from a listing page', (t) => {
  stubAirtable(t, { queue: [] }); // installs listAllCounties stub
  const details = extractListingDetails(LISTING_HTML, 'https://republicranches.com/properties/oklahoma/headwaters-ranch/');
  assert.match(details.name, /Headwaters Ranch/);
  assert.equal(details.price, 3018654);
  assert.equal(details.acres, 1118);
  assert.equal(details.county, 'Pittsburg');
  assert.equal(details.state, 'OK');
});

test('extractListingDetails matches county from a URL slug', (t) => {
  stubAirtable(t, { queue: [] });
  const details = extractListingDetails('<html><body>160 acres</body></html>',
    'https://www.landwatch.com/pittsburg-county-oklahoma-farms-and-ranches-for-sale/pid/426088291');
  assert.equal(details.county, 'Pittsburg');
  assert.equal(details.state, 'OK');
});

const WAYNE_COUNTIES = [{ county: 'Wayne', state: 'KY' }, { county: 'Wayne', state: 'MO' }];

test('extractCountyState disambiguates Wayne KY vs MO by URL slug (full state name)', (t) => {
  stubAirtable(t, { queue: [], counties: WAYNE_COUNTIES });
  assert.deepEqual(
    extractCountyState('https://www.landwatch.com/wayne-county-missouri-land-for-sale/pid/123', ''),
    { county: 'Wayne', state: 'MO' });
  assert.deepEqual(
    extractCountyState('https://www.landwatch.com/wayne-county-kentucky-land-for-sale/pid/456', ''),
    { county: 'Wayne', state: 'KY' });
});

test('extractCountyState disambiguates by URL slug via a standalone state abbreviation token', (t) => {
  stubAirtable(t, { queue: [], counties: WAYNE_COUNTIES });
  assert.deepEqual(
    extractCountyState('https://example.com/listings/wayne-county-mo/pid/9', ''),
    { county: 'Wayne', state: 'MO' });
});

test('extractCountyState disambiguates Wayne KY vs MO by page text', (t) => {
  stubAirtable(t, { queue: [], counties: WAYNE_COUNTIES });
  // Comma-anchored abbreviation "Wayne County, MO"
  assert.deepEqual(
    extractCountyState('https://republicranches.com/listing/123', 'Timbered tract in Wayne County, MO near the river.'),
    { county: 'Wayne', state: 'MO' });
  // Full state name in text
  assert.deepEqual(
    extractCountyState('https://republicranches.com/listing/123', 'Wayne County property located in Kentucky.'),
    { county: 'Wayne', state: 'KY' });
});

test('extractCountyState does NOT match a bare padded 2-letter word in text', (t) => {
  stubAirtable(t, { queue: [], counties: WAYNE_COUNTIES });
  // " me " / " or " style words must not stand in for a state abbreviation.
  assert.deepEqual(
    extractCountyState('https://republicranches.com/listing/123', 'Wayne County is a place you or me would love.'),
    { county: null, state: null });
});

test('extractCountyState returns null when the county name is ambiguous with no state signal', (t) => {
  stubAirtable(t, { queue: [], counties: WAYNE_COUNTIES });
  assert.deepEqual(
    extractCountyState('https://example.com/wayne-county-land/pid/9', 'A fine Wayne County acreage listing.'),
    { county: null, state: null });
});

test('extractCountyState returns a lone match without needing a state signal', (t) => {
  stubAirtable(t, { queue: [], counties: [{ county: 'Pittsburg', state: 'OK' }, { county: 'Wayne', state: 'KY' }] });
  assert.deepEqual(
    extractCountyState('https://www.landwatch.com/pittsburg-county-farms/pid/1', ''),
    { county: 'Pittsburg', state: 'OK' });
});

test('intake: an ambiguous county still creates a lead and flags it for manual fill-in', { timeout: 60000 }, async (t) => {
  const AMBIGUOUS_HTML = `<html><head>
    <title>River Bottom Tract - 80 Acres</title>
    <meta property="og:description" content="80 acres of Wayne County hunting ground.">
    <script type="application/ld+json">{"@type":"Product","offers":{"price":"120000"}}</script>
  </head><body><h1>River Bottom Tract</h1><p>80 acres in Wayne County.</p></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(AMBIGUOUS_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/wayne-county-land`;

  const calls = stubAirtable(t, {
    queue: [{ id: 'recIntakeAmbig01X', fields: { URL: url, 'Submitted By': 'Emma' } }],
    counties: WAYNE_COUNTIES,
  });

  const report = await processIntakeQueue({ dryRun: false });
  assert.equal(report.created, 1, 'ambiguous county must not block lead creation');
  assert.equal(calls.createdLeads.length, 1);
  assert.equal(calls.createdLeads[0].county, null, 'ambiguous county stays unset');
  assert.match(calls.createdLeads[0].description, /county/, 'notes list county as a gap');
  assert.match(calls.createdLeads[0].description, /fill in manually/i);
  assert.equal(calls.intakeUpdates[0].fields.Status, 'Added');
});

test('intake: a suspected cross-site duplicate is written with Possible Dup Reason propagated', { timeout: 60000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LISTING_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/pittsburg-county-oklahoma-listing`;

  // Layer-3 near-match: same county/state/acreage, price within tolerance,
  // but NOT a URL or fingerprint duplicate — so it is written, flagged.
  const locationMap = new Map([[locationKey('Pittsburg', 'OK', 1118), [{ price: 3018654 }]]]);
  const calls = stubAirtable(t, {
    queue: [{ id: 'recIntakeCross01X', fields: { URL: url, 'Submitted By': 'Emma' } }],
    dedupIndex: { urlSet: new Set(), fingerprintSet: new Set(), locationMap, records: [] },
  });

  const report = await processIntakeQueue({ dryRun: false });
  assert.equal(report.created, 1, 'suspected cross-site dup is still created');
  assert.equal(report.duplicates, 0);
  assert.equal(calls.createdLeads.length, 1);
  assert.match(calls.createdLeads[0].possibleDuplicateReason, /Possible cross-site duplicate/);
  assert.ok(
    (calls.createdLeads[0].validationErrors || []).some(e => /cross-site duplicate/.test(e)),
    'suspected cross-site note is also added to validationErrors',
  );
  assert.equal(calls.intakeUpdates[0].fields.Status, 'Added');
});

test('intake: a URL resolving to an internal address fails the SSRF guard and retries', { timeout: 60000 }, async (t) => {
  // Turn the guard back ON for this case (the file globally bypasses it so the
  // other integration tests can use loopback fixtures).
  const priorAllow = process.env.SCRAPER_ALLOW_LOOPBACK_FETCH;
  process.env.SCRAPER_ALLOW_LOOPBACK_FETCH = 'false';
  t.after(() => { process.env.SCRAPER_ALLOW_LOOPBACK_FETCH = priorAllow; });

  // Loopback literal — assertPublicUrl rejects before any fetch is attempted.
  const url = 'http://127.0.0.1:9/internal-listing';
  const calls = stubAirtable(t, {
    queue: [{ id: 'recIntakeSsrf001X', fields: { URL: url, 'Submitted By': 'Emma' } }],
  });

  const report = await processIntakeQueue({ dryRun: false });
  assert.equal(report.created, 0);
  assert.equal(calls.createdLeads.length, 0, 'blocked URL must never be fetched or created');
  assert.equal(report.retryQueued, 1, 'first SSRF rejection follows the normal Retry flow');
  assert.equal(calls.intakeUpdates[0].fields.Status, 'Retry');
  assert.match(calls.intakeUpdates[0].fields.Result, /private\/internal/);
});

test('intake: a fetchable URL becomes a New Lead and the row is marked Added', { timeout: 60000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LISTING_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/pittsburg-county-oklahoma-listing`;

  const calls = stubAirtable(t, {
    queue: [{ id: 'recIntake0000001X', fields: { URL: url, 'Submitted By': 'Emma' } }],
  });

  const report = await processIntakeQueue({ dryRun: false });

  assert.equal(report.created, 1);
  assert.equal(report.failures.length, 0);
  assert.equal(calls.createdLeads.length, 1);
  assert.equal(calls.createdLeads[0].stage, 'New Lead', 'intake leads must arrive as New Lead');
  assert.equal(calls.createdLeads[0].price, 3018654);
  const update = calls.intakeUpdates[0];
  assert.equal(update.fields.Status, 'Added');
  assert.deepEqual(update.fields['Created Land Record'], ['recCreatedLand01X']);
});

test('intake: first failure queues a next-day retry; second failure is final', { timeout: 60000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(403);
    res.end('Forbidden');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/blocked-listing`;

  // First attempt: Status empty → failure must set Retry
  let calls = stubAirtable(t, {
    queue: [{ id: 'recIntake0000002X', fields: { URL: url, 'Submitted By': 'Lori' } }],
  });
  let report = await processIntakeQueue({ dryRun: false });
  assert.equal(report.retryQueued, 1);
  assert.equal(report.failedFinal, 0);
  assert.equal(calls.intakeUpdates[0].fields.Status, 'Retry');
  assert.match(calls.intakeUpdates[0].fields.Result, /retry.*tomorrow/i);
  assert.equal(report.failures[0].final, false);

  // Second attempt (a day later): Status Retry → failure is final
  calls = stubAirtable(t, {
    queue: [{ id: 'recIntake0000002X', fields: { URL: url, 'Submitted By': 'Lori', Status: 'Retry' } }],
  });
  report = await processIntakeQueue({ dryRun: false });
  assert.equal(report.failedFinal, 1);
  assert.equal(calls.intakeUpdates[0].fields.Status, 'Failed');
  assert.match(calls.intakeUpdates[0].fields.Result, /Set Status to 'New'/);
  assert.equal(report.failures[0].final, true);
});

test('intake: duplicate URLs are marked Duplicate, not re-created', { timeout: 60000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LISTING_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/pittsburg-listing`;

  const calls = stubAirtable(t, {
    queue: [{ id: 'recIntake0000003X', fields: { URL: url, 'Submitted By': 'Emma' } }],
    dedupIndex: { urlSet: new Set([url]), fingerprintSet: new Set(), locationMap: new Map(), records: [] },
  });

  const report = await processIntakeQueue({ dryRun: false });
  assert.equal(report.duplicates, 1);
  assert.equal(calls.createdLeads.length, 0);
  assert.equal(calls.intakeUpdates[0].fields.Status, 'Duplicate');
});

test('intake: rows failed by the legacy poller are reclaimed and retried', { timeout: 60000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LISTING_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/pittsburg-county-oklahoma-listing`;

  // The legacy poller's signature: Status 'Needs Review', Result 'HTTP 403 fetching ...'
  const calls = stubAirtable(t, {
    queue: [{
      id: 'recIntake0000004X',
      fields: { URL: url, 'Submitted By': 'Isaac M', Status: 'Needs Review', Result: `HTTP 403 fetching ${url}` },
    }],
  });

  const report = await processIntakeQueue({ dryRun: false });
  assert.equal(report.reclaimed, 1, 'legacy failure must be counted as reclaimed');
  assert.equal(report.created, 1, 'reclaimed row must be processed like any queued row');
  assert.equal(calls.intakeUpdates[0].fields.Status, 'Added');
});

test('intake failures render in the consolidated email', () => {
  const { buildScraperBody } = require('../lib/notify');
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 1,
  };
  const intakeReport = {
    processed: 3, created: 1, duplicates: 0, retryQueued: 1, failedFinal: 1,
    added: [{ url: 'https://ok.example.com/1', submitter: 'Emma', summary: 'Created New Lead from submitted URL: $100,000, 50 acres.' }],
    failures: [
      { url: 'https://blocked.example.com/2', submitter: 'Lori', error: 'HTTP 403', final: false },
      { url: 'https://gone.example.com/3', submitter: 'Isaac M', error: 'HTTP 403', final: true },
    ],
  };
  const body = buildScraperBody(scraperReport, null, 'Monday', null, intakeReport);
  assert.match(body, /LISTING INTAKE/);
  assert.match(body, /WILL RETRY AUTOMATICALLY TOMORROW NIGHT \(1\)/);
  assert.match(body, /blocked\.example\.com/);
  assert.match(body, /GIVEN UP \(1\)/);
  assert.match(body, /Set the record's Status back to 'New'/);
});
