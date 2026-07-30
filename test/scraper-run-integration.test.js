'use strict';

// End-to-end runScraper() integration — drives the REAL orchestrator once over
// three fake parsers exercising the three hardest paths in one composed report:
//   (a) a countyRotation parser  → rotation metadata reaches the site report
//   (b) a parser that trips the 5-blocked-page breaker on pass 1 and succeeds on
//       the post-cooldown retry → status 'retried_after_cooldown', listings
//       written, AND the retry site report's `checked` reflects ONLY the retry
//       pass (locks in prepareForRetry resetting stats.checked/parsed)
//   (c) a card-sparse listing (missing county) completed from its detail page
//       BEFORE the filter would have rejected it → enriched + written
//
// The airtable module boundary is stubbed (object methods are late-bound, so a
// plain assignment works). getEnabledParsers is destructured at scraper.js load,
// so it must be patched BEFORE requiring lib/scraper — done here at file top.
// node --test isolates each test file in its own process, so neither mutation
// leaks to other files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parsersModule = require('../lib/parsers');
let FAKE_PARSERS = [];
parsersModule.getEnabledParsers = () => FAKE_PARSERS;

const airtable = require('../lib/airtable');
const BaseParser = require('../lib/parsers/base-parser');
const { runScraper } = require('../lib/scraper');

// --- Fake parsers -----------------------------------------------------------

// (a) Healthy site carrying a countyRotation factor. buildSearchUrls ignores the
// (rotated) county subset and returns one page; the listing passes the filter.
class RotatingParser extends BaseParser {
  constructor() {
    super('RotatingSite');
    this.countyRotation = 2;
  }
  sleep() { return Promise.resolve(); }
  buildSearchUrls() {
    return [{ url: 'https://rot.example/search', county: 'Wayne', state: 'KY', page: 1 }];
  }
  async fetchPageSmart() { return '<html><body>search</body></html>'; }
  parseSearchPage() {
    this._lastCardCount = 1;
    return [{ name: 'Rotating Lead', price: 300000, acres: 120, county: 'Wayne', state: 'KY', url: 'https://rot.example/l/1' }];
  }
}

// (b) Pass 1 serves six distinct county series that all bot-block (5 blocks trip
// the breaker on the sixth iteration); the post-cooldown retry serves real
// listings. `pass` gates fetch behavior; sleep() is a no-op so the cooldown
// never actually blocks.
class BlockThenSucceedParser extends BaseParser {
  constructor() {
    super('BlockThenSucceed');
    this.pass = 0;
  }
  sleep() { return Promise.resolve(); }
  buildSearchUrls() {
    return Array.from({ length: 6 }, (_, i) => ({
      url: `https://blk.example/c${i}`, county: `C${i}`, state: 'MO', page: 1,
    }));
  }
  async scrapeAll(counties) {
    this.pass++;
    return super.scrapeAll(counties);
  }
  async fetchPageSmart(url) {
    const search = url.match(/\/c(\d+)$/);
    if (search) {
      return this.pass === 1 ? '<html><body>Access Denied</body></html>' : `LISTING:${search[1]}`;
    }
    return '<html><body>detail page</body></html>';
  }
  parseSearchPage(html) {
    if (!/^LISTING:/.test(html)) { this._lastCardCount = 0; return []; }
    const n = Number(html.split(':')[1]);
    const acres = 100 + n * 5; // distinct acres → distinct fingerprints (all 6 written)
    this._lastCardCount = 1;
    return [{ name: `Retry Win ${n}`, price: Math.round(acres * 2400), acres, county: 'Shannon', state: 'MO', url: `https://blk.example/win/${n}` }];
  }
}

// (c) Emits one URL-only card missing its county; the detail page supplies it
// (via parseDetailPage) in the pre-filter enrichment pass, rescuing it before
// the data-validation gate would reject it.
class SparseParser extends BaseParser {
  constructor() { super('SparseSite'); }
  sleep() { return Promise.resolve(); }
  buildSearchUrls() {
    return [{ url: 'https://sparse.example/search', county: null, state: null, page: 1 }];
  }
  async fetchPageSmart() { return '<html><body>Taney County detail</body></html>'; }
  parseSearchPage() {
    this._lastCardCount = 1;
    return [{ name: 'Sparse Card', price: 500000, acres: 200, county: null, state: 'MO', url: 'https://sparse.example/l/1', description: 'card blurb' }];
  }
  parseDetailPage() { return { county: 'Taney' }; }
}

// --- Airtable stubs ---------------------------------------------------------

function stubAirtable(captured) {
  const original = {
    loadCountyTargets: airtable.loadCountyTargets,
    loadDedupIndex: airtable.loadDedupIndex,
    writeListings: airtable.writeListings,
  };
  airtable.loadCountyTargets = async () => ({
    counties: [
      { county: 'Taney', state: 'MO', maxCPA: 4000 },
      { county: 'Wayne', state: 'KY', maxCPA: 3000 },
      { county: 'Shannon', state: 'MO', maxCPA: 2500 },
      { county: 'Pittsburg', state: 'OK', maxCPA: 2500 },
    ],
    countyMap: new Map([
      ['taney|MO', 4000], ['wayne|KY', 3000], ['shannon|MO', 2500], ['pittsburg|OK', 2500],
    ]),
    source: 'test',
  });
  airtable.loadDedupIndex = async () => ({
    urlSet: new Set(), fingerprintSet: new Set(), locationMap: new Map(), records: [],
  });
  airtable.writeListings = async (listings) => {
    captured.push(...listings);
    return {
      created: listings.length,
      errors: [],
      records: listings.map((l, i) => ({ id: `rec${captured.length}_${i}`, url: l.url })),
    };
  };
  return () => Object.assign(airtable, original);
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

// (d) Two sites listing the SAME property tonight. The second one's source+link
// must land on the record the first one created instead of being discarded.
class CrossSiteParser extends BaseParser {
  constructor(name, url) {
    super(name);
    this._url = url;
  }
  sleep() { return Promise.resolve(); }
  buildSearchUrls() {
    return [{ url: `https://${this.name}.example/search`, county: 'Taney', state: 'MO', page: 1 }];
  }
  async fetchPageSmart() { return '<html><body>search</body></html>'; }
  parseSearchPage() {
    this._lastCardCount = 1;
    // Prices/acres within fingerprint tolerance of each other → same property.
    return [{ name: `Shared Tract (${this.name})`, price: 301000, acres: 151, county: 'Taney', state: 'MO', url: this._url }];
  }
}

test('runScraper: the same property on two sites becomes ONE record carrying both sources', async () => {
  const first = new CrossSiteParser('SiteOne', 'https://one.example/l/1');
  const second = new CrossSiteParser('SiteTwo', 'https://two.example/l/1');
  FAKE_PARSERS = [first, second];

  const captured = [];
  const restoreAirtable = stubAirtable(captured);
  const originalMerge = airtable.mergeSourceIntoRecord;
  const merges = [];
  airtable.mergeSourceIntoRecord = async (record, listing) => {
    merges.push({ record, listing });
    return { merged: true };
  };

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-run-merge-'));

  let report;
  try {
    await withEnv({
      GITHUB_ACTIONS: undefined,
      SCRAPER_BROWSER_FALLBACK: 'false',
      SCRAPER_DETAIL_ENRICHMENT: 'false',
      SCRAPER_BOTWALL_COOLDOWN_MINUTES: '0',
      SCRAPER_DATA_DIR: dataDir, // hermetic: no repo data/ reads or writes
    }, async () => {
      report = await runScraper({ dryRun: false });
    });
  } finally {
    airtable.mergeSourceIntoRecord = originalMerge;
    restoreAirtable();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  assert.equal(captured.length, 1, 'only the first site created a record');
  assert.equal(captured[0].url, 'https://one.example/l/1');
  assert.equal(merges.length, 1, "the second site's source was merged into that record");
  assert.equal(merges[0].listing.url, 'https://two.example/l/1');

  assert.equal(report.totals.written, 1);
  assert.equal(report.totals.duplicates, 1, 'a merged dup is still a caught dup');
  assert.equal(report.totals.sourceMerges, 1);
  assert.equal(report.sites.SiteTwo.sourceMerges, 1);
  assert.equal(report.mergeDetails.length, 1);
  assert.equal(report.mergeDetails[0].source, 'SiteTwo');
  assert.equal(report.mergeDetails[0].matchType, 'session-fingerprint');
  assert.equal(report.mergeDetails[0].dryRun, false);
});

test('runScraper: one real run composes rotation + bot-wall retry + sparse-enrichment into a consistent report', async () => {
  const rotating = new RotatingParser();
  const blocked = new BlockThenSucceedParser();
  const sparse = new SparseParser();
  FAKE_PARSERS = [rotating, blocked, sparse];

  const captured = [];
  const restoreAirtable = stubAirtable(captured);

  let report;
  try {
    await withEnv({
      GITHUB_ACTIONS: undefined,
      DRY_RUN: undefined,
      SCRAPER_DETAIL_ENRICHMENT: undefined,
      SCRAPER_BROWSER_FALLBACK: 'false', // no real browser in this env
      SCRAPER_BOTWALL_COOLDOWN_MINUTES: '60', // retry enabled; sleep() is stubbed no-op
      SCRAPER_MAX_PAGE: undefined,
      SCRAPER_INCREMENTAL: undefined,
    }, async () => {
      report = await runScraper({ dryRun: false });
    });
  } finally {
    restoreAirtable();
  }

  // (a) rotation metadata reached the site report.
  const rotSite = report.sites.RotatingSite;
  assert.ok(rotSite.rotation, 'rotating site carries rotation metadata');
  assert.equal(rotSite.rotation.groupsTotal, 2);
  assert.equal(rotSite.written, 1, 'rotating site wrote its one lead');

  // (b) bot-wall breaker on pass 1, success on the post-cooldown retry.
  const blkSite = report.sites.BlockThenSucceed;
  assert.equal(blkSite.status, 'retried_after_cooldown');
  assert.equal(blkSite.retryPass.blockedAgain, false);
  assert.equal(blkSite.written, 6, 'the retry pass wrote all six listings');
  // Locks in prepareForRetry resetting stats.checked: the retry site report must
  // count ONLY the six retry fetches, not the first pass's five blocked ones.
  assert.equal(blkSite.checked, 6, 'retry report checked reflects only the retry pass (stats.checked was reset)');

  // (c) the sparse listing was completed from its detail page and written.
  const sparseSite = report.sites.SparseSite;
  assert.equal(sparseSite.written, 1, 'sparse site wrote its one enriched lead');
  const writtenSparse = captured.find(l => l.url === 'https://sparse.example/l/1');
  assert.ok(writtenSparse, 'sparse lead was written');
  assert.equal(writtenSparse.county, 'Taney', 'county filled from the detail page before filtering');

  // Totals reconcile with the per-site sums (final site reports).
  const siteWritten = Object.values(report.sites).reduce((s, x) => s + (x.written || 0), 0);
  const siteParsed = Object.values(report.sites).reduce((s, x) => s + (x.parsed || 0), 0);
  assert.equal(report.totals.written, 8, 'eight leads written across the three sites');
  assert.equal(report.totals.written, siteWritten, 'totals.written equals the sum of per-site writes');
  assert.equal(report.totals.parsed, siteParsed, 'totals.parsed equals the sum of per-site parses');
});
