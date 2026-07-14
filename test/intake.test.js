'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Deterministic even when run outside npm test: intake failures here must
// come from the plain fetch, not a real browser launch
process.env.SCRAPER_BROWSER_FALLBACK = 'false';

const airtable = require('../lib/airtable');
const { processIntakeQueue, extractListingDetails, extractAcres, cleanTitle } = require('../lib/intake');

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
