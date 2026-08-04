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
