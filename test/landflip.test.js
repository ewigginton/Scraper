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
const detailHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'landflip-detail-420517.html'),
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

// ---------- parseDetailPage (real captured /land/420517 detail page) ----------

test('parseDetailPage extracts price/acres/county/state from the real detail fixture', () => {
  const parser = new LandflipParser();
  const out = parser.parseDetailPage(detailHtml);

  // Golden values from the captured page:
  //   price  — schema.org Product JSON-LD offers.price ("489900")
  //   acres  — "... with 11 acres ..." in the meta/og description
  //   county — "... in Taylor County, ..." in the description
  //   state  — "... Taylor County, Kentucky 42718 ..." → KY (validated)
  assert.equal(out.price, 489900);
  assert.equal(out.acres, 11);
  assert.equal(out.county, 'Taylor');
  assert.equal(out.state, 'KY'); // stored as the two-letter abbreviation
  assert.ok(out.description && out.description.length > 10);
  assert.match(out.description, /Campbellsville KY Barndominium/);
});

test('parseDetailPage reads price from structured data only, not the price-filter dropdown', () => {
  const parser = new LandflipParser();
  // The fixture's visible "$N" options (10k/500k/9M) belong to a filter
  // dropdown; only the JSON-LD offer price (489900) is this listing's price.
  const out = parser.parseDetailPage(detailHtml);
  assert.equal(out.price, 489900);
});

test('parseDetailPage validates the state token — a bogus state drops county+state', () => {
  const parser = new LandflipParser();
  // A two-word state name in the description resolves...
  const nm = parser.parseDetailPage(
    '<html><head><meta name="description" content="Nice tract with 40 acres in Sandoval County, New Mexico 87001."></head><body></body></html>',
  );
  assert.equal(nm.county, 'Sandoval');
  assert.equal(nm.state, 'NM');
  // ...but an unrecognized state token is rejected, and the county drops with it
  // (never invented from stray prose).
  const bogus = parser.parseDetailPage(
    '<html><head><meta name="description" content="Nice tract with 40 acres in Fake County, Zzzland 00000."></head><body></body></html>',
  );
  assert.equal(bogus.county, undefined);
  assert.equal(bogus.state, undefined);
  // Acreage still parses independently of the location validation.
  assert.equal(bogus.acres, 40);
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

// ---------- pagination series key: a blocked page 1 short-circuits the state ----------

test('a blocked LANDFLIP page 1 prevents the page-2 fetch (page 1 and 2 share one series key)', async () => {
  // Page 1 (/land-for-sale/kentucky) and page 2 (/land-for-sale/kentucky/2-p)
  // must collapse to one pagination series key so that once page 1 is blocked,
  // exhaustedSeries skips page 2 — no point re-hitting a state that just refused
  // us. Drive the REAL scrapeAll with a fetch stubbed to throw a bot-wall error.
  const parser = new LandflipParser();
  parser.sleep = () => Promise.resolve();
  const fetched = [];
  parser.fetchPageSmart = async (url) => {
    fetched.push(url);
    const err = new Error(`HTTP 403 for ${url}`);
    err.status = 403;
    throw err;
  };

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY', maxCPA: 3000 }]);

  assert.deepEqual(
    fetched,
    ['https://www.landflip.com/land-for-sale/kentucky'],
    'only page 1 is fetched; blocking it exhausts the shared series so page 2 is skipped',
  );
  assert.equal(listings.length, 0);
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
// Build a detail page in the REAL LANDFLIP shape parseDetailPage reads: acreage
// + county/state in the meta description, total price in a Product JSON-LD offer
// (the visible dollar figures on a real page are a filter dropdown, not price).
function detailPage({ price, acres, county, stateName }) {
  return '<html><head>'
    + `<meta name="description" content="A tract with ${acres} acres by Town in ${county} County, ${stateName} 40000.">`
    + '<script type="application/ld+json">'
    + `{"@type":"Product","offers":{"@type":"Offer","priceCurrency":"USD","price":"${price}"}}`
    + '</script></head><body><div>Rolling pasture and timber.</div></body></html>';
}

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
    [sparseUrl]: detailPage({ price: 400000, acres: 160, county: 'Wayne', stateName: 'Kentucky' }),
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
    [url]: detailPage({ price: 999999, acres: 160, county: 'Wayne', stateName: 'Kentucky' }),
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
