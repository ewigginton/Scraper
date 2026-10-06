'use strict';

// Deterministic even when run outside npm test: recheck failures here must
// come from the plain fetch, not a real browser launch.
process.env.SCRAPER_BROWSER_FALLBACK = 'false';
// Integration tests below serve fixtures from 127.0.0.1; allow the SSRF
// guard to fetch loopback for those.
process.env.SCRAPER_ALLOW_LOOPBACK_FETCH = 'true';
// No politeness delay in tests — the cap test alone would otherwise run
// MAX_RECHECKS_PER_NIGHT+ fetches at ~1.5-2.7s each.
process.env.SCRAPER_LEAD_RECHECK_DELAY_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const airtable = require('../lib/airtable');
const {
  runLeadRecheck,
  RECHECK_STAGES,
  MAX_RECHECKS_PER_NIGHT,
  isAcreageMismatch,
  isLikelySiteChange,
  orderByOldestUnchecked,
} = require('../lib/lead-recheck');
const { buildScraperBody } = require('../lib/notify');

function withScratchDataDir(t) {
  const original = process.env.SCRAPER_DATA_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-lead-recheck-'));
  process.env.SCRAPER_DATA_DIR = tempDir;
  t.after(() => {
    if (original === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

/**
 * Stubs airtable.getRecordsByStage to serve `recordsByStage[stage]` and
 * spies on airtable.updateRecord (throws if called at all — the stage-policy
 * test relies on this) plus every other Airtable write surface, so a bug
 * that tried to write anything would fail loudly instead of silently
 * succeeding against a stub.
 */
function stubAirtable(t, { recordsByStage }) {
  const original = {
    getRecordsByStage: airtable.getRecordsByStage,
    updateRecord: airtable.updateRecord,
    createLeadRecord: airtable.createLeadRecord,
  };
  const updateCalls = [];
  airtable.getRecordsByStage = async stage => recordsByStage[stage] || [];
  airtable.updateRecord = async (...args) => {
    updateCalls.push(args);
    throw new Error('lead-recheck must never call airtable.updateRecord');
  };
  airtable.createLeadRecord = async () => {
    throw new Error('lead-recheck must never call airtable.createLeadRecord');
  };
  t.after(() => Object.assign(airtable, original));
  return { updateCalls };
}

function makeRecord(id, fields) {
  const { FIELDS, STAGES } = airtable;
  return {
    id,
    fields: {
      Name: fields.name,
      [FIELDS.stage]: fields.stage || STAGES.newLead,
      [FIELDS.url]: fields.url,
      [FIELDS.acres]: fields.acres,
      ...fields.extra,
    },
  };
}

async function serve(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('RECHECK_STAGES covers exactly New Lead and Emma Review', () => {
  assert.deepEqual(RECHECK_STAGES, [airtable.STAGES.newLead, airtable.STAGES.emmaReview]);
});

test('isAcreageMismatch: relative-difference threshold', () => {
  assert.equal(isAcreageMismatch(100, 100, 40), false, 'identical acreage');
  assert.equal(isAcreageMismatch(100, 91, 40), false, '9% swing is under threshold');
  assert.equal(isAcreageMismatch(100, 89, 40), true, '11% swing is over threshold');
  assert.equal(isAcreageMismatch(null, 100, 40), false, 'missing recorded acreage never a mismatch');
  assert.equal(isAcreageMismatch(100, null, 40), false, 'missing live acreage (fetch/parse miss) never a mismatch');
});

test('isAcreageMismatch: crossing the acreage floor counts even under the relative threshold', () => {
  // 42 -> 38 is a ~9.5% swing (under the 10% threshold) but crosses the 40ac floor
  assert.equal(isAcreageMismatch(42, 38, 40), true);
  // Both sides stay above the floor -> no floor-crossing signal, and the
  // relative swing (5%) is under threshold too
  assert.equal(isAcreageMismatch(42, 40, 40), false);
});

test('orderByOldestUnchecked: never-checked records sort before checked ones, then oldest-first', () => {
  const a = { id: 'recA' };
  const b = { id: 'recB' };
  const c = { id: 'recC' };
  const state = {
    recB: new Date('2026-08-01T00:00:00Z').toISOString(),
    recC: new Date('2026-07-01T00:00:00Z').toISOString(),
  };
  const ordered = orderByOldestUnchecked([a, b, c], state);
  assert.deepEqual(ordered.map(r => r.id), ['recA', 'recC', 'recB']);
});

test('runLeadRecheck: a fetched page saying "under contract" is reported, not written or staged', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const server = await serve('<html><body><h1>Ridge Tract</h1><p>160 acres. This property is under contract.</p></body></html>');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/ridge-tract`;

  const record = makeRecord('recNewLead001X', { name: 'Ridge Tract', url, acres: 160 });
  const { updateCalls } = stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 1);
  assert.equal(report.underContract.length, 1);
  assert.equal(report.underContract[0].name, 'Ridge Tract');
  assert.equal(report.underContract[0].url, url);
  assert.equal(report.underContract[0].phrase, 'under contract');
  assert.equal(report.acreageMismatches.length, 0, 'live 160ac matches recorded 160ac');
  assert.equal(updateCalls.length, 0, 'must never write to Airtable');
});

test('runLeadRecheck: acreage mismatch is detected and reported', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  // Live page says 60 acres; the record says 100 -> 40% swing.
  const server = await serve('<html><body><h1>Open Tract</h1><p>60 acres of open pasture, no restrictions.</p></body></html>');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/open-tract`;

  const record = makeRecord('recNewLead002X', { name: 'Open Tract', url, acres: 100 });
  const { updateCalls } = stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 1);
  assert.equal(report.underContract.length, 0);
  assert.equal(report.acreageMismatches.length, 1);
  assert.equal(report.acreageMismatches[0].recordedAcres, 100);
  assert.equal(report.acreageMismatches[0].liveAcres, 60);
  assert.equal(updateCalls.length, 0);
});

test('runLeadRecheck: a fetch failure is counted, not fatal, and the rest of the batch still runs', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const badServer = http.createServer((req, res) => { res.writeHead(403); res.end('Forbidden'); });
  await new Promise(resolve => badServer.listen(0, '127.0.0.1', resolve));
  t.after(() => badServer.close());
  const goodServer = await serve('<html><body><h1>Fine Tract</h1><p>40 acres, all clear.</p></body></html>');
  t.after(() => goodServer.close());

  const badUrl = `http://127.0.0.1:${badServer.address().port}/blocked`;
  const goodUrl = `http://127.0.0.1:${goodServer.address().port}/fine-tract`;

  const badRecord = makeRecord('recNewLead003X', { name: 'Blocked Tract', url: badUrl, acres: 40 });
  const goodRecord = makeRecord('recNewLead004X', { name: 'Fine Tract', url: goodUrl, acres: 40 });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [badRecord, goodRecord] } });

  const report = await runLeadRecheck();

  assert.equal(report.fetchFailed, 1);
  assert.equal(report.errors, 1);
  assert.equal(report.checked, 1, 'the other lead in the batch is still checked');
  assert.equal(report.totalCandidates, 2);
});

test('runLeadRecheck: a clean fetch with matching acreage and no availability phrase reports nothing', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const server = await serve('<html><body><h1>Quiet Tract</h1><p>80 acres, paved road frontage, no restrictions.</p></body></html>');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/quiet-tract`;

  const record = makeRecord('recNewLead005X', { name: 'Quiet Tract', url, acres: 80 });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 1);
  assert.equal(report.underContract.length, 0);
  assert.equal(report.acreageMismatches.length, 0);
});

test('runLeadRecheck: a CoStar error-shell page (HTTP 200, no listing content) counts as a fetch failure, never "all clear"', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  // The exact CoStar error-shell signature (see lib/block-markers.js,
  // ERROR_SHELL_TITLE_RE): a fully-rendered page with nav/footer but no
  // property content, titled "<SiteName> / <4xx/5xx>". Bot walls answer this
  // for HTTP 200 too, so status alone can't be trusted.
  const shellHtml = '<html><head><title>LandWatch / 404</title></head><body><nav>LandWatch</nav><footer>copyright</footer></body></html>';
  const server = await serve(shellHtml);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/vanished-tract`;

  const record = makeRecord('recNewLead008X', { name: 'Vanished Tract', url, acres: 80 });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 0, 'an error-shell page must never be treated as a successfully checked page');
  assert.equal(report.fetchFailed, 1, 'an error-shell page counts as a fetch failure');
  assert.equal(report.underContract.length, 0);
  assert.equal(report.acreageMismatches.length, 0);
});

test('runLeadRecheck: an ordinary-title empty app shell (HTTP 200, empty root div) counts as a fetch failure', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  // Unlike the CoStar "/ 4xx" shell above, this one has a normal title and no
  // challenge markers — only an unrendered client-side app. "No availability
  // flags found" on a page with no content is not "the listing looks live".
  const shellHtml = '<html><head><title>LandWatch</title></head><body><div id="root"></div><script src="/static/js/main.js"></script></body></html>';
  const server = await serve(shellHtml);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/unrendered-tract`;

  const record = makeRecord('recNewLead009X', { name: 'Unrendered Tract', url, acres: 80 });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 0, 'an empty app shell must never count as a successfully checked page');
  assert.equal(report.fetchFailed, 1);
  assert.equal(report.underContract.length, 0);
});

test('runLeadRecheck: a sparse-but-informative page is NOT mistaken for an empty shell', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  // Total visible text is well under the shell threshold, but it plainly
  // carries the signal Emma needs — short pages with extractable content are
  // informative, not shells (the guard only distrusts the NEGATIVE inference).
  const server = await serve('<html><body><p>160 acres. This property is under contract.</p></body></html>');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/sparse-tract`;

  const record = makeRecord('recNewLead010X', { name: 'Sparse Tract', url, acres: 160 });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 1);
  assert.equal(report.fetchFailed, 0);
  assert.equal(report.underContract.length, 1, 'the under-contract phrase on the sparse page is detected');
});

test('runLeadRecheck: records with no URL are counted separately and never fetched', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const record = makeRecord('recNewLead006X', { name: 'No URL Tract', url: undefined, acres: 80 });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.skippedNoUrl, 1);
  assert.equal(report.checked, 0);
});

test('runLeadRecheck: merges New Lead and Emma Review candidates and reads Emma Review\'s stage into findings', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const server = await serve('<html><body><h1>Flagged Tract</h1><p>100 acres. This listing is sale pending.</p></body></html>');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/flagged-tract`;

  const record = makeRecord('recEmmaReview001X', {
    name: 'Flagged Tract', url, acres: 100, stage: airtable.STAGES.emmaReview,
  });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.emmaReview]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.totalCandidates, 1);
  assert.equal(report.underContract.length, 1);
  assert.equal(report.underContract[0].stage, airtable.STAGES.emmaReview);
});

test('runLeadRecheck: caps at MAX_RECHECKS_PER_NIGHT and reports what was dropped', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const server = await serve('<html><body><h1>Bulk Tract</h1><p>50 acres, fine as-is.</p></body></html>');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/bulk-tract`;

  const total = MAX_RECHECKS_PER_NIGHT + 5;
  const records = [];
  for (let i = 0; i < total; i++) {
    records.push(makeRecord(`recBulk${String(i).padStart(4, '0')}X`, { name: `Tract ${i}`, url, acres: 50 }));
  }
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: records } });

  const report = await runLeadRecheck();

  assert.equal(report.totalCandidates, total);
  assert.equal(report.checked, MAX_RECHECKS_PER_NIGHT);
  assert.equal(report.droppedByCap, 5);
  assert.equal(report.droppedNames.length, 5);
});

test('runLeadRecheck: a loadCandidates failure is reported, not thrown', async (t) => {
  const original = airtable.getRecordsByStage;
  airtable.getRecordsByStage = async () => { throw new Error('Airtable is down'); };
  t.after(() => { airtable.getRecordsByStage = original; });

  const report = await runLeadRecheck();
  assert.match(report.loadError, /Airtable is down/);
  assert.equal(report.checked, 0);
});

test('notify: LEAD RECHECK section renders under-contract and acreage-mismatch findings', () => {
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 1,
  };
  const leadRecheckReport = {
    totalCandidates: 3, checked: 3, fetchFailed: 0, skippedNoUrl: 0, droppedByCap: 0, droppedNames: [],
    underContract: [{ name: 'Ridge Tract', stage: 'New Lead', url: 'https://example.com/ridge', phrase: 'under contract' }],
    acreageMismatches: [{ name: 'Open Tract', recordedAcres: 100, liveAcres: 60, url: 'https://example.com/open' }],
  };
  const body = buildScraperBody(scraperReport, null, 'Monday', null, null, { leadRecheckReport });
  assert.match(body, /LEAD RECHECK/);
  assert.match(body, /Rechecked: 3 of 3/);
  assert.match(body, /NOW UNDER CONTRACT/);
  assert.match(body, /Ridge Tract \(New Lead\) — matched "under contract"/);
  assert.match(body, /ACREAGE MISMATCHES/);
  assert.match(body, /Open Tract: recorded 100ac vs live 60ac/);
});

test('notify: LEAD RECHECK section collapses to a single "all clear" line when nothing was found', () => {
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 1,
  };
  const leadRecheckReport = {
    totalCandidates: 12, checked: 12, fetchFailed: 0, skippedNoUrl: 0, droppedByCap: 0, droppedNames: [],
    underContract: [], acreageMismatches: [],
  };
  const body = buildScraperBody(scraperReport, null, 'Monday', null, null, { leadRecheckReport });
  assert.match(body, /All 12 rechecked leads look live\./);
  assert.doesNotMatch(body, /NOW UNDER CONTRACT/);
  assert.doesNotMatch(body, /ACREAGE MISMATCHES/);
});

test('notify: a failed lead-recheck step renders a FAILED banner instead of silently omitting the section', () => {
  const scraperReport = {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 1 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 1,
    leadRecheckError: 'Airtable is down',
  };
  const body = buildScraperBody(scraperReport, null, 'Monday', null, null, {});
  assert.match(body, /LEAD RECHECK: FAILED/);
  assert.match(body, /Airtable is down/);
});

test('stage policy: runLeadRecheck never calls airtable.updateRecord even when it finds under-contract/mismatch leads', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const server = await serve('<html><body><h1>Mixed Tract</h1><p>60 acres. This property is under contract.</p></body></html>');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mixed-tract`;

  const record = makeRecord('recNewLead007X', { name: 'Mixed Tract', url, acres: 100 });
  const { updateCalls } = stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [record] } });

  const report = await runLeadRecheck();

  assert.equal(report.underContract.length, 1);
  assert.equal(report.acreageMismatches.length, 1);
  assert.equal(updateCalls.length, 0, 'both an under-contract AND acreage-mismatch finding must still never touch Airtable');
});

// ---------------------------------------------------------------------------
// Subject-listing reader (lib/listing-subject.js) on real saved pages. The
// fetch is stubbed so the record's real listing URL (which picks the per-site
// reader) can be used without any network request.
// ---------------------------------------------------------------------------

const BaseParser = require('../lib/parsers/base-parser');

function subjectFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', `subject-${name}.html`), 'utf8');
}

function stubFetchByUrl(t, pagesByUrl) {
  t.mock.method(BaseParser.prototype, 'fetchPageSmart', async function (url) {
    const page = pagesByUrl[url];
    if (page instanceof Error) throw page;
    if (page === undefined) throw new Error(`unexpected fetch ${url}`);
    return page;
  });
}

test('runLeadRecheck: LandWatch Under Contract / Off Market pages are reported from the listing\'s own status', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const ucUrl = 'https://www.landwatch.com/henry-county-tennessee-farms-and-ranches-for-sale/pid/426783020';
  const omUrl = 'https://www.landwatch.com/knott-county-kentucky-recreational-property-for-sale/pid/425510193';
  const okUrl = 'https://www.landwatch.com/darlington-county-south-carolina-undeveloped-land-for-sale/pid/425066098';
  stubFetchByUrl(t, {
    [ucUrl]: subjectFixture('landwatch-under-contract'),
    [omUrl]: subjectFixture('landwatch-off-market'),
    [okUrl]: subjectFixture('landwatch-available-darlington'),
  });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [
    makeRecord('recLwUc0000001X', { name: 'Henry 331', url: ucUrl, acres: 331 }),
    makeRecord('recLwOm0000001X', { name: 'Knott 125', url: omUrl, acres: 125 }),
    makeRecord('recLwOk0000001X', { name: 'Darlington 531', url: okUrl, acres: 531.91 }),
  ] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 3);
  assert.deepEqual(report.underContract.map(u => [u.name, u.phrase, u.statusKind]), [
    ['Henry 331', 'Under Contract', 'pending'],
    ['Knott 125', 'Off Market', 'sold'],
  ]);
  assert.equal(report.acreageMismatches.length, 0);
});

test('runLeadRecheck: a Mossy Oak nearby-widget "Under Contract" badge is not reported, and acreage is the subject\'s', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const url = 'https://www.mossyoakproperties.com/property/oakridge-road-5-bowie-texas/96718/';
  stubFetchByUrl(t, { [url]: subjectFixture('mossyoak-nearby-under-contract') });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [
    makeRecord('recMoNear00001X', { name: 'Oakridge Road #5', url, acres: 75 }),
  ] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 1);
  assert.equal(report.underContract.length, 0);
  assert.equal(report.acreageMismatches.length, 0);
});

test('runLeadRecheck: a LandWatch error shell is "could not verify", never all clear', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const url = 'https://www.landwatch.com/carroll-county-tennessee-undeveloped-land-for-sale/pid/424902515';
  stubFetchByUrl(t, { [url]: subjectFixture('landwatch-error-shell') });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [
    makeRecord('recLwShell0001X', { name: 'Carroll tract', url, acres: 60 }),
  ] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 0);
  assert.equal(report.fetchFailed, 1);
  assert.equal(report.unreadable.length, 1);
  assert.match(report.unreadable[0].note, /error shell/);
  assert.equal(report.underContract.length, 0);
});

test('runLeadRecheck: a known-site page that does not show its status is "could not verify", never "looks live"', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const url = 'https://www.landflip.com/land/420517';
  stubFetchByUrl(t, { [url]: fs.readFileSync(path.join(__dirname, 'fixtures', 'landflip-detail-420517.html'), 'utf8') });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [
    makeRecord('recLfUnknown01X', { name: 'Taylor 11', url, acres: 20 }),
  ] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 0, 'status unknown is not a successful check');
  assert.equal(report.fetchFailed, 1, 'counted with the "could not verify" pages');
  assert.equal(report.statusUnknown.length, 1);
  assert.match(report.statusUnknown[0].note, /status not shown/);
  assert.equal(report.underContract.length, 0);
  // Acreage is still read from the listing itself and compared.
  assert.equal(report.acreageMismatches.length, 1);
  assert.equal(report.acreageMismatches[0].liveAcres, 11);
});

test('runLeadRecheck: a TuttLand panel badge "Under Contract" is reported', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const url = 'https://www.tuttland.com/land-sale/alabama/bibb-county/730-ac-bibb-county-al-sportmans-paradisetimber-investment';
  stubFetchByUrl(t, { [url]: subjectFixture('tuttland-active').replace('<strong>Active</strong>', '<strong>Under Contract</strong>') });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [
    makeRecord('recTuttUc0001X', { name: 'Bibb 730', url, acres: 730 }),
  ] } });

  const report = await runLeadRecheck();

  assert.equal(report.checked, 1);
  assert.deepEqual(report.underContract.map(u => [u.name, u.phrase, u.statusKind]), [['Bibb 730', 'Under Contract', 'pending']]);
});

test('runLeadRecheck: HTTP 404/410 is reported as a removed listing without any extra request', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const url = 'https://www.whitetailproperties.com/hunting-land/kentucky/graves/gone-listing';
  const gone = new Error(`HTTP 404 for ${url}`);
  gone.status = 404;
  stubFetchByUrl(t, { [url]: gone });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [
    makeRecord('recWtGone0001X', { name: 'Gone tract', url, acres: 60 }),
  ] } });

  const report = await runLeadRecheck();

  assert.equal(BaseParser.prototype.fetchPageSmart.mock.callCount(), 1);
  assert.equal(report.checked, 1);
  assert.equal(report.fetchFailed, 0);
  // Removals are their own list, not mixed into NOW UNDER CONTRACT / SOLD.
  assert.equal(report.underContract.length, 0);
  assert.equal(report.removed.length, 1);
  assert.equal(report.removed[0].name, 'Gone tract');
  assert.equal(report.removed[0].httpStatus, 404);
  assert.equal(report.removed[0].phrase, 'listing removed (HTTP 404)');
  assert.deepEqual(report.siteChangeWarnings, []);
});

function httpGone(url, status = 404) {
  const err = new Error(`HTTP ${status} for ${url}`);
  err.status = status;
  return err;
}

test('runLeadRecheck: most of one host\'s rechecks 404/410 -> "site may have changed its URLs", not removals', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const lw = n => `https://www.landwatch.com/henry-county-tennessee-land-for-sale/pid/${n}`;
  const lwLive = 'https://www.landwatch.com/darlington-county-south-carolina-undeveloped-land-for-sale/pid/425066098';
  const wtGone = 'https://www.whitetailproperties.com/hunting-land/kentucky/graves/gone-listing';
  stubFetchByUrl(t, {
    [lw(1)]: httpGone(lw(1)),
    [lw(2)]: httpGone(lw(2), 410),
    [lw(3)]: httpGone(lw(3)),
    [lw(4)]: httpGone(lw(4)),
    [lwLive]: subjectFixture('landwatch-available-darlington'),
    [wtGone]: httpGone(wtGone),
  });
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: [
    makeRecord('recLwGone0001X', { name: 'LW 1', url: lw(1), acres: 60 }),
    makeRecord('recLwGone0002X', { name: 'LW 2', url: lw(2), acres: 60 }),
    makeRecord('recLwGone0003X', { name: 'LW 3', url: lw(3), acres: 60 }),
    makeRecord('recLwGone0004X', { name: 'LW 4', url: lw(4), acres: 60 }),
    makeRecord('recLwLive0001X', { name: 'Darlington', url: lwLive, acres: 531.91 }),
    makeRecord('recWtGone0002X', { name: 'Whitetail gone', url: wtGone, acres: 60 }),
  ] } });

  const report = await runLeadRecheck();

  assert.equal(BaseParser.prototype.fetchPageSmart.mock.callCount(), 6, 'one fetch per lead, no extra requests');
  // 4 of 5 landwatch.com rechecks were 404/410: a URL change, not 4 removals.
  assert.equal(report.siteChangeWarnings.length, 1);
  const w = report.siteChangeWarnings[0];
  assert.equal(w.host, 'landwatch.com');
  assert.equal(w.gone, 4);
  assert.equal(w.rechecked, 5);
  assert.match(w.message, /site may have changed its URLs/);
  assert.equal(report.siteChangeWarning, w.message, 'one-line form the email renders');
  const scraperReport = {
    dryRun: false, sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 1,
  };
  const body = buildScraperBody(scraperReport, null, 'Monday', null, null, { leadRecheckReport: report });
  assert.match(body, /site may have changed its URLs/, 'the email shows the warning');
  assert.doesNotMatch(body, /LW 1/, 'the suspected URL-change 404s are not listed as removals');
  assert.match(body, /Whitetail gone/);
  assert.equal(report.fetchFailed, 4, 'counted as could-not-verify');
  // Whitetail's single 404 is unaffected: still a removal.
  assert.deepEqual(report.removed.map(r => r.name), ['Whitetail gone']);
  assert.equal(report.underContract.length, 0);
  assert.equal(report.checked, 2, 'the live LandWatch page and the Whitetail removal');
});

test('runLeadRecheck: site-change guard needs more than half AND at least 3 of a host\'s rechecks', { timeout: 60000 }, async (t) => {
  withScratchDataDir(t);
  const lw = n => `https://www.landwatch.com/henry-county-tennessee-land-for-sale/pid/${n}`;
  const darlington = subjectFixture('landwatch-available-darlington');
  // 3 of 6 gone (exactly half, not more) plus 2 of 2 on another host (below the minimum of 3).
  const wt = n => `https://www.whitetailproperties.com/hunting-land/kentucky/graves/gone-${n}`;
  const pages = {};
  const records = [];
  for (let i = 1; i <= 6; i++) {
    pages[lw(i)] = i <= 3 ? httpGone(lw(i)) : darlington;
    records.push(makeRecord(`recLwMix000${i}X`, { name: `LW ${i}`, url: lw(i), acres: 531.91 }));
  }
  for (let i = 1; i <= 2; i++) {
    pages[wt(i)] = httpGone(wt(i), 410);
    records.push(makeRecord(`recWtMix000${i}X`, { name: `WT ${i}`, url: wt(i), acres: 60 }));
  }
  stubFetchByUrl(t, pages);
  stubAirtable(t, { recordsByStage: { [airtable.STAGES.newLead]: records } });

  const report = await runLeadRecheck();

  assert.deepEqual(report.siteChangeWarnings, []);
  assert.deepEqual(report.removed.map(r => r.name).sort(), ['LW 1', 'LW 2', 'LW 3', 'WT 1', 'WT 2']);
  assert.equal(report.fetchFailed, 0);
});

test('isLikelySiteChange: more than half and at least 3', () => {
  assert.equal(isLikelySiteChange(3, 5), true);
  assert.equal(isLikelySiteChange(3, 6), false, 'exactly half is not more than half');
  assert.equal(isLikelySiteChange(2, 2), false, 'fewer than 3');
  assert.equal(isLikelySiteChange(10, 10), true);
});
