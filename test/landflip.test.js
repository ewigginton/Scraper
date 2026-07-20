'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LandflipParser = require('../lib/parsers/landflip');
const { initFilter } = require('../lib/filter');
const airtable = require('../lib/airtable');
const { processScrapedListings } = require('../lib/scraper');

const searchHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'landflip-kentucky-search.html'),
  'utf8',
);

// ---------- buildSearchUrls ----------

test('buildSearchUrls dedupes states (one series per state, not per county) and builds the verified URL shape', () => {
  const parser = new LandflipParser();
  // Two KY counties + one AL county must yield ONE series per unique state, not
  // one per county — the state page is statewide inventory.
  const urls = parser.buildSearchUrls([
    { county: 'Wayne', state: 'KY' },
    { county: 'Butler', state: 'KY' },
    { county: 'Choctaw', state: 'AL' },
  ]);

  const byUrl = urls.map(u => u.url);
  // Exactly two states, two pages each (STATE_SEARCH_PAGES = 2).
  assert.deepEqual(byUrl, [
    'https://www.landflip.com/land-for-sale/kentucky',
    'https://www.landflip.com/land-for-sale/kentucky/2-p',
    'https://www.landflip.com/land-for-sale/alabama',
    'https://www.landflip.com/land-for-sale/alabama/2-p',
  ]);
  // Page 1 has no "-p" suffix; deeper pages carry "/{N}-p".
  assert.equal(urls[0].page, 1);
  assert.equal(urls[1].page, 2);
  // Multi-word state slugs are lowercased and hyphenated.
  const nm = parser.buildSearchUrls([{ county: 'Rio Arriba', state: 'NM' }]);
  assert.equal(nm[0].url, 'https://www.landflip.com/land-for-sale/new-mexico');
});

test('resultsSortedNewestFirst is false — state pages render in FEATURED order, not date order', () => {
  // No crawlable newest-first URL exists (the sort dropdown is JS-driven), so
  // deeper pages are NOT guaranteed older: incremental early-stop must stay off.
  assert.equal(new LandflipParser().resultsSortedNewestFirst, false);
});

// ---------- parseSearchPage (real captured KY HTML) ----------

test('parseSearchPage extracts real listings from the KY fixture with correct price/acres/county/state', () => {
  const parser = new LandflipParser();
  const listings = parser.parseSearchPage(searchHtml, null, null);

  // The fixture holds 19 real cards.
  assert.equal(listings.length, 19);
  assert.equal(parser._lastCardCount, 19);

  // A known real listing from the file (/land/420517) is parsed exactly.
  const known = listings.find(l => l.url === 'https://www.landflip.com/land/420517');
  assert.ok(known, '/land/420517 was extracted');
  assert.equal(known.price, 489900);
  assert.equal(known.acres, 11);
  assert.equal(known.county, 'Taylor');
  assert.equal(known.state, 'KY'); // stored as the two-letter abbreviation
  assert.match(known.name, /Campbellsville KY Barndominium/);
  assert.match(known.description, /Barndominium Retreat Near Green River Lake/);

  // Every listing carries a /land/{id} detail URL and its own county.
  assert.ok(listings.every(l => /\/land\/\d+$/.test(l.url)), 'all URLs are /land/{id}');
  assert.ok(listings.every(l => l.county && l.state), 'every card carries county + state');
});

test('parseSearchPage excludes nav/filter/keyword/news links — only /land/{id} cards become listings', () => {
  const parser = new LandflipParser();
  const listings = parser.parseSearchPage(searchHtml, null, null);
  const urls = listings.map(l => l.url);

  // County/keyword/city filter pages and the news carousel must never appear.
  assert.ok(!urls.some(u => u.includes('/land-for-sale/')), 'no state/county/keyword pages');
  assert.ok(!urls.some(u => u.includes('-keyword')), 'no keyword filter links');
  assert.ok(!urls.some(u => u.includes('/news/')), 'no news-carousel links');
});

// ---------- parseDetailPage (defensive; no real detail fixture) ----------

test('parseDetailPage reads the site text signatures when present, and validates the state token', () => {
  const parser = new LandflipParser();
  // A detail page reusing the site-wide "N Acres : $X" tag and "County Co : ST"
  // location phrasing (block boundaries with no whitespace, as cheerio yields).
  const detail = '<html><body><h1>Big Farm</h1>'
    + '<span class="tag price-ac">160 Acres : $400,000</span>'
    + '<p>Monticello : Wayne Co : KY</p>'
    + '<div>Rolling pasture with mature timber and road frontage.</div>'
    + '</body></html>';
  const out = parser.parseDetailPage(detail);
  assert.equal(out.price, 400000);
  assert.equal(out.acres, 160);
  assert.equal(out.county, 'Wayne');
  assert.equal(out.state, 'KY');
  assert.ok(out.description && out.description.length > 10);

  // A two-word state name resolves; a bogus state token is rejected (county
  // dropped with it, never invented from stray prose).
  assert.deepEqual(
    { c: parser.parseDetailPage('<body><p>X : Sandoval Co : New Mexico</p></body>').county,
      s: parser.parseDetailPage('<body><p>X : Sandoval Co : New Mexico</p></body>').state },
    { c: 'Sandoval', s: 'NM' },
  );
  const bogus = parser.parseDetailPage('<body><p>X : Fake Co : ZZ</p></body>');
  assert.equal(bogus.county, undefined);
  assert.equal(bogus.state, undefined);
});

// ---------- robustness ----------

test('parseSearchPage and parseDetailPage survive garbage/empty/null HTML without throwing', () => {
  const parser = new LandflipParser();
  assert.deepEqual(parser.parseSearchPage('<html><body>nothing here</body></html>', null, null), []);
  assert.deepEqual(parser.parseSearchPage('', null, null), []);
  assert.deepEqual(parser.parseDetailPage(''), {});
  assert.deepEqual(parser.parseDetailPage(null), {});
  // A page with body prose but no signatures must not invent listing fields.
  const g = parser.parseDetailPage('<html><body>just some words about land</body></html>');
  assert.equal(g.price, undefined);
  assert.equal(g.acres, undefined);
  assert.equal(g.county, undefined);
  assert.equal(g.state, undefined);
});

// ---------- GOAL 2: enrichment-ordering (card-sparse listing rescued before filter) ----------

// Patch airtable.writeListings on the shared module object scraper.js calls
// through, so a non-dry-run pass never touches the live base; capture what was
// written so the test can inspect the enriched, persisted fields.
function withStubbedWrite(fn) {
  const original = airtable.writeListings;
  const captured = [];
  airtable.writeListings = async (listings) => {
    captured.push(...listings);
    return { created: listings.length, errors: [] };
  };
  return Promise.resolve().then(() => fn(captured)).finally(() => { airtable.writeListings = original; });
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

function makeCtx() {
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [], filterRejects: [], writeErrors: [], sourceIssues: [], warnings: [], dryRun: false,
  };
  const ctx = {
    dedupIndex: { urlSet: new Set(), fingerprintSet: new Set(), locationMap: new Map() },
    sessionFingerprints: new Map(),
    report,
    dryRun: false,
  };
  return { report, ctx };
}

// A real LandflipParser with its network + delay stubbed: fetchPageSmart returns
// scripted detail HTML per URL and records which URLs were fetched, so the test
// proves a URL-only card is enriched via the REAL parseDetailPage before filter.
function stubParser(detailHtmlByUrl) {
  const parser = new LandflipParser();
  parser.detailFetches = [];
  parser.sleep = () => Promise.resolve();
  parser.fetchPageSmart = async (url) => {
    parser.detailFetches.push(url);
    return detailHtmlByUrl[url] || '<html><body>no data</body></html>';
  };
  return parser;
}

test('GOAL 2: a card-sparse (URL-only) listing is detail-enriched BEFORE filtering, then filtered and written', async () => {
  // Target county map: Wayne, KY at $3000/acre.
  initFilter(new Map([['wayne|KY', 3000]]));

  const sparseUrl = 'https://www.landflip.com/land/999001';
  const fullUrl = 'https://www.landflip.com/land/999002';

  // Detail page carries the fields the card omitted: 160ac @ $400k in Wayne, KY.
  const detailHtmlByUrl = {
    [sparseUrl]: '<html><body><span class="tag price-ac">160 Acres : $400,000</span>'
      + '<p>Monticello : Wayne Co : KY</p><div>Rolling pasture and timber.</div></body></html>',
  };

  // The sparse listing arrived with ONLY a URL — every filter-critical field
  // null, exactly what LANDFLIP would emit for a card missing its price tag.
  const sparse = {
    name: 'Sparse Card', price: null, acres: null, county: null, state: null,
    url: sparseUrl, description: 'card blurb',
  };
  // A fully-populated card that must NOT be pre-fetched (nothing to rescue).
  const full = {
    name: 'Full Card', price: 300000, acres: 120, county: 'Wayne', state: 'KY',
    url: fullUrl, description: 'full blurb',
  };

  const parser = stubParser(detailHtmlByUrl);
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      const siteReport = await processScrapedListings(parser, [sparse, full], ctx);

      // Both leads passed the filter and were written.
      assert.equal(siteReport.passed, 2, 'both leads passed the filter');
      assert.equal(report.totals.written, 2);

      // The sparse card was rescued: its filter-critical fields came from the
      // detail page and it was written.
      const writtenSparse = captured.find(l => l.url === sparseUrl);
      assert.ok(writtenSparse, 'sparse lead was written');
      assert.equal(writtenSparse.price, 400000, 'price filled from detail');
      assert.equal(writtenSparse.acres, 160, 'acres filled from detail');
      assert.equal(writtenSparse.county, 'Wayne', 'county filled from detail');
      assert.equal(writtenSparse.state, 'KY', 'state filled from detail');

      // The full card was written unchanged and never detail-fetched (its fields
      // were complete, so the pre-filter pass skipped it and, being enriched-free
      // but complete, it only gets the normal post-filter description fetch).
      assert.ok(parser.detailFetches.includes(sparseUrl), 'sparse card was detail-fetched');
      // The sparse card must be fetched exactly once (pre-filter), not twice.
      assert.equal(
        parser.detailFetches.filter(u => u === sparseUrl).length, 1,
        'sparse card fetched exactly once — no double fetch across the two passes',
      );
    })
  );
});

test('GOAL 2: detail enrichment never overwrites a non-null field the card already carried', async () => {
  initFilter(new Map([['wayne|KY', 3000]]));

  const url = 'https://www.landflip.com/land/999003';
  // Detail page reports a DIFFERENT price than the card — the card value wins.
  const detailHtmlByUrl = {
    [url]: '<html><body><span class="tag price-ac">160 Acres : $999,999</span>'
      + '<p>Monticello : Wayne Co : KY</p></body></html>',
  };

  // Card has price + acres, but is MISSING county/state (so it is still sparse
  // and gets the pre-filter fetch that fills the county).
  const listing = {
    name: 'Half Card', price: 300000, acres: 160, county: null, state: null,
    url, description: 'blurb',
  };

  const parser = stubParser(detailHtmlByUrl);
  const { ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      await processScrapedListings(parser, [listing], ctx);
      const written = captured.find(l => l.url === url);
      assert.ok(written, 'lead written');
      assert.equal(written.price, 300000, 'card price preserved, not overwritten by detail');
      assert.equal(written.county, 'Wayne', 'missing county filled from detail');
      assert.equal(written.state, 'KY', 'missing state filled from detail');
    })
  );
});
