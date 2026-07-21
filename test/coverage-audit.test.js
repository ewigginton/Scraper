'use strict';

// Weekly coverage audit: target counties where NO source showed a single
// listing for 7 days. Covers the three moving pieces:
//   (c) lib/local-store.js's appendCoverageSighting/loadCoverageLog — append,
//       30-day prune, and (via lib/scraper.js's processScrapedListings) the
//       same 'county|ST' key shape lib/filter.js's countyMap uses.
//   (d) lib/notify.js's buildCoverageAuditSection / buildScraperBody —
//       Sunday-only rendering, zero-sighting listing, and defensive handling
//       of a missing/corrupt log.
// Dates are always injected (never Date.now()), mirroring lib/county-rotation.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initFilter } = require('../lib/filter');
const { processScrapedListings } = require('../lib/scraper');
const { appendCoverageSighting, loadCoverageLog } = require('../lib/local-store');
const { buildCoverageAuditSection, buildScraperBody } = require('../lib/notify');
const BaseParser = require('../lib/parsers/base-parser');

function withDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-coverage-'));
  const original = process.env.SCRAPER_DATA_DIR;
  process.env.SCRAPER_DATA_DIR = dir;
  t.after(() => {
    if (original === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function coverageLogFile(dir) {
  return path.join(dir, 'coverage', 'coverage-log.jsonl');
}

// --- (c) append + prune + key shape -----------------------------------------

test('appendCoverageSighting writes one {date, counties} JSON line', (t) => {
  const dir = withDataDir(t);
  const filePath = appendCoverageSighting(['wayne|KY', 'taney|MO'], new Date(2026, 6, 21)); // Tue Jul 21 2026

  assert.equal(filePath, coverageLogFile(dir));
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.date, '2026-07-21');
  assert.deepEqual(entry.counties.sort(), ['taney|MO', 'wayne|KY']);
});

test('appendCoverageSighting prunes entries older than 30 days on write', (t) => {
  withDataDir(t);
  // 40 days before the reference date — must be pruned.
  appendCoverageSighting(['old|MO'], new Date(2026, 5, 11)); // Jun 11 2026
  // 10 days before the reference date — must survive.
  appendCoverageSighting(['recent|MO'], new Date(2026, 6, 11)); // Jul 11 2026
  // The reference (write) date itself.
  appendCoverageSighting(['today|MO'], new Date(2026, 6, 21)); // Jul 21 2026

  const entries = loadCoverageLog();
  const dates = entries.map(e => e.date);
  assert.ok(!dates.includes('2026-06-11'), 'entry older than 30 days must be pruned');
  assert.ok(dates.includes('2026-07-11'), 'entry within 30 days must survive');
  assert.ok(dates.includes('2026-07-21'), 'the just-written entry must be present');
});

test('loadCoverageLog tolerates a missing file (returns [])', (t) => {
  withDataDir(t);
  assert.deepEqual(loadCoverageLog(), []);
});

test('loadCoverageLog skips corrupt lines without throwing', (t) => {
  const dir = withDataDir(t);
  fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  fs.writeFileSync(
    coverageLogFile(dir),
    'not json at all\n{"date":"2026-07-11","counties":["wayne|KY"]}\n{"missing":"date field"}\n',
    'utf8',
  );
  const entries = loadCoverageLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, '2026-07-11');
});

// A minimal parser stub — dryRun:true skips detail enrichment entirely, so
// nothing beyond name/stats/sourceIssues is ever touched.
function makeCtx() {
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [], filterRejects: [], writeErrors: [], sourceIssues: [], warnings: [],
    dryRun: true,
  };
  const ctx = {
    dedupIndex: { urlSet: new Set(), fingerprintSet: new Set(), locationMap: new Map() },
    sessionFingerprints: new Map(),
    report,
    dryRun: true,
    sightedCounties: new Set(),
  };
  return { report, ctx };
}

test('processScrapedListings records sightings in the SAME key shape as filter.js\'s countyMap', async () => {
  // countyMap key is lowercase county | uppercase state (see lib/filter.js
  // initFilter/lookupCPATarget) — the listing itself carries mixed case, as
  // real scraped cards do.
  initFilter(new Map([['wayne|KY', 3000]]));
  const parser = new BaseParser('TestSite');
  const { ctx } = makeCtx();

  const listings = [
    // In the target list (mixed case) — must be sighted, over-threshold price
    // (would be REJECTED by the filter) proving sightings are pre-filter.
    { name: 'Rejected But Sighted', price: 999999, acres: 100, county: 'Wayne', state: 'ky', url: 'https://x/1' },
    // Not a target county — must not add a spurious key.
    { name: 'Not A Target', price: 100000, acres: 100, county: 'Boone', state: 'MO', url: 'https://x/2' },
  ];

  await processScrapedListings(parser, listings, ctx);

  assert.deepEqual(Array.from(ctx.sightedCounties), ['wayne|KY']);
});

// --- (d) email rendering -----------------------------------------------------

const TARGET_COUNTIES = [
  { county: 'Wayne', state: 'KY' },
  { county: 'Taney', state: 'MO' },
  { county: 'Shannon', state: 'MO' },
];

test('buildCoverageAuditSection lists target counties with zero sightings in the last 7 days', (t) => {
  withDataDir(t);
  const referenceDate = new Date(2026, 6, 26); // Sunday Jul 26 2026
  // Wayne sighted 3 days ago (inside the window); Taney sighted 10 days ago
  // (outside the window, so it still counts as silent); Shannon never sighted.
  appendCoverageSighting(['wayne|KY'], new Date(2026, 6, 23));
  appendCoverageSighting(['taney|MO'], new Date(2026, 6, 16));

  const lines = buildCoverageAuditSection(TARGET_COUNTIES, referenceDate);
  const body = lines.join('\n');

  assert.match(body, /COVERAGE AUDIT \(7 days\)/);
  assert.match(body, /2 of 3 target counties with ZERO sightings/);
  assert.match(body, /Taney, MO/);
  assert.match(body, /Shannon, MO/);
  assert.ok(!body.includes('Wayne, KY'), 'Wayne was sighted inside the window and must not be listed');
});

test('buildCoverageAuditSection reports full coverage when every county was sighted', (t) => {
  withDataDir(t);
  const referenceDate = new Date(2026, 6, 26);
  appendCoverageSighting(['wayne|KY', 'taney|MO', 'shannon|MO'], new Date(2026, 6, 25));

  const lines = buildCoverageAuditSection(TARGET_COUNTIES, referenceDate);
  const body = lines.join('\n');
  assert.match(body, /Every target county \(3\) was sighted/);
});

test('buildCoverageAuditSection truncates at 15 with "... and N more"', (t) => {
  withDataDir(t);
  const referenceDate = new Date(2026, 6, 26);
  const manyCounties = Array.from({ length: 18 }, (_, i) => ({ county: `County${i}`, state: 'KY' }));

  const lines = buildCoverageAuditSection(manyCounties, referenceDate);
  const body = lines.join('\n');
  assert.match(body, /18 of 18 target counties with ZERO sightings/);
  assert.match(body, /\.\.\. and 3 more/);
});

function baseScraperReport(targetCounties) {
  return {
    dryRun: false,
    sites: {},
    totals: { written: 0, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [],
    elapsedMinutes: 1,
    targetCounties,
  };
}

test('buildScraperBody renders the coverage section on a Sunday nightly run', (t) => {
  withDataDir(t);
  const report = baseScraperReport(TARGET_COUNTIES);
  const body = buildScraperBody(report, null, 'Sunday', null, null, { runDate: new Date(2026, 6, 26) });
  assert.match(body, /COVERAGE AUDIT \(7 days\)/);
});

test('buildScraperBody omits the coverage section on a non-Sunday nightly run', (t) => {
  withDataDir(t);
  const report = baseScraperReport(TARGET_COUNTIES);
  const body = buildScraperBody(report, null, 'Monday', null, null, { runDate: new Date(2026, 6, 20) });
  assert.ok(!body.includes('COVERAGE AUDIT'));
});

test('buildScraperBody omits the coverage section on a Sunday MIDDAY run', (t) => {
  withDataDir(t);
  const report = baseScraperReport(TARGET_COUNTIES);
  const body = buildScraperBody(report, null, 'Sunday', null, null, { runDate: new Date(2026, 6, 26), midday: true });
  assert.ok(!body.includes('COVERAGE AUDIT'));
});

test('a corrupt coverage log never crashes buildScraperBody — section is silently skipped', (t) => {
  const dir = withDataDir(t);
  fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  fs.writeFileSync(coverageLogFile(dir), 'THIS IS NOT JSON AT ALL\n{{{broken', 'utf8');

  const report = baseScraperReport(TARGET_COUNTIES);
  assert.doesNotThrow(() => {
    const body = buildScraperBody(report, null, 'Sunday', null, null, { runDate: new Date(2026, 6, 26) });
    // Corrupt log -> treated as "no sightings" -> every county is silent, but
    // the section still renders (a corrupt log is not a MISSING log; it is
    // read defensively as empty, per loadCoverageLog's own contract).
    assert.match(body, /COVERAGE AUDIT \(7 days\)/);
  });
});

test('buildCoverageAuditSection returns nothing when there is no target-county list', () => {
  assert.deepEqual(buildCoverageAuditSection(undefined, new Date(2026, 6, 26)), []);
  assert.deepEqual(buildCoverageAuditSection([], new Date(2026, 6, 26)), []);
});
