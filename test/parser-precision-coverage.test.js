'use strict';

// Parser-side fixes from the 2026-10-05 verification round:
//   - float-noise acreage/price is rounded at the shared numeric parse
//     (NationalLandRealty data-acres "5.5600000000000005" was refused by the
//     write-time plausibility guard's decimal-places rule)
//   - LandWatch's rounded card headline acreage ("241 acres") is refined to
//     the surveyed figure the page also states ("240.65 +/- acre")
//   - Whitetail: a zero-card render is drift unless the RENDERED page says
//     the county is empty; ?page=2 (ignored by the site) is no longer fetched;
//     the county search is the site's own 40+ acre query form
//   - LandWatch: a county with results past the page cap records a coverage warning
//   - extractByDetailLinks: one listing linked by relative and absolute URLs
//     is one card, not two cards that block each other's walk-up

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { parseAcreageNumber } = require('../lib/acreage');
const BaseParser = require('../lib/parsers/base-parser');
const LandWatchParser = require('../lib/parsers/landwatch');
const WhitetailParser = require('../lib/parsers/whitetail');
const { checkListingPlausibility } = require('../lib/plausibility');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// ---------- float noise (verifier D1, parser side) ----------

test('parseAcreageNumber rounds JS float noise to thousandths', () => {
  assert.equal(parseAcreageNumber('5.5600000000000005'), 5.56);
  assert.equal(parseAcreageNumber('0.29000000000000004'), 0.29);
  assert.equal(parseAcreageNumber('45.56000000000001'), 45.56);
  // real values are untouched
  assert.equal(parseAcreageNumber('.24'), 0.24);
  assert.equal(parseAcreageNumber('1,234.5'), 1234.5);
  assert.equal(parseAcreageNumber('40.303'), 40.303);
  assert.equal(parseAcreageNumber('312'), 312);
  assert.equal(parseAcreageNumber('0'), null);
  assert.equal(parseAcreageNumber('abc'), null);
});

test('a float-noise 45.56-acre NationalLand-style value now passes the write-time plausibility guard', () => {
  const parser = new BaseParser('Test');
  const acres = parser.parseAcres('45.56000000000001');
  assert.equal(acres, 45.56);
  const verdict = checkListingPlausibility({ price: 182240, acres });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
});

test('parsePrice rounds float noise to cents', () => {
  const parser = new BaseParser('Test');
  assert.equal(parser.parsePrice('349900.00000000006'), 349900);
  assert.equal(parser.parsePrice('$1,250,000'), 1250000);
  assert.equal(parser.parsePrice('$12,500.50'), 12500.5);
});

// ---------- headline vs precise acreage (verifier D4) ----------

test('extractAcres prefers a later figure that rounds to the headline, never a different acreage', () => {
  const parser = new BaseParser('Test');
  assert.equal(parser.extractAcres('$848,291 • 241 acres ... 240.65 +/- acre tract'), 240.65);
  assert.equal(parser.extractAcres('$115,000 • 10.2 acres lot ... beautiful 10.17 acres'), 10.17);
  // at the 40-acre floor: a 39.96 tract headlined "40 acres" is 39.96
  assert.equal(parser.extractAcres('$90,000 • 40 acres ... survey shows 39.96 acres'), 39.96);
  // a different number (sub-area, nearby acreage) never replaces the headline
  assert.equal(parser.extractAcres('$1,200,000 • 492 acres ... 112 acres of pasture'), 492);
  assert.equal(parser.extractAcres('Pending $850,000 • 297 acres ... within 300 acres of countryside'), 297);
  // a less precise later figure never replaces a precise headline
  assert.equal(parser.extractAcres('$300,000 • 160.5 acres ... about 160 acres'), 160.5);
  // glued-price protection still holds
  assert.equal(parser.extractAcres('For Sale $873,600312 acres ± Dewey County'), 312);
});

test('LandWatch search pages take the surveyed acreage from JSON-LD when the card headline rounds it', () => {
  const parser = new LandWatchParser();
  const wayne = parser.parseSearchPage(fixture('landwatch-search.html'), 'Wayne', 'KY');
  const byPid = pid => wayne.find(l => l.url.includes(`/pid/${pid}`));
  assert.equal(byPid('422678311').acres, 10.17, 'card "10.2 acres", JSON-LD "10.17 acres"');
  assert.equal(byPid('425696025').acres, 16.57, 'card "16.6 acres"');
  assert.equal(byPid('425242297').acres, 201.15, 'card "201 acres"');
  assert.equal(byPid('425842846').acres, 278.19, 'card "278 acres"');
  assert.equal(byPid('423684859').acres, 297, 'card "297 acres"; the description\'s "300 acres" is a different number');

  const pittsburg = parser.parseSearchPage(fixture('landwatch-search-acres-over-150-pittsburg-page-1.html'), 'Pittsburg', 'OK');
  assert.equal(pittsburg.find(l => l.url.includes('/pid/424556445')).acres, 240.65);
  assert.equal(pittsburg.find(l => l.url.includes('/pid/424560237')).acres, 467.22);
  assert.equal(pittsburg.length, 25);
});

// ---------- Whitetail empty vs stuck render (verifier D3) ----------

test('Whitetail: a rendered empty county ("Showing 0-0 of 0 listings") is empty, not drift', () => {
  const parser = new WhitetailParser();
  const html = fixture('whitetail-search-pittsburg-empty.html');
  assert.deepEqual(parser.parseSearchPage(html, 'Pittsburg', 'OK'), []);
  assert.equal(parser._lastCardCount, 0);
  assert.equal(parser.looksLikeEmptyResults(html), true);
});

test('Whitetail: the unrendered skeleton is NOT empty even though its inline script says "No listings found"', () => {
  const parser = new WhitetailParser();
  const skeleton = fixture('whitetail-search-dewey-plain-fetch.html');
  assert.match(skeleton, /No listings found for this search/, 'the marker lives in the inline script');
  assert.equal(parser.looksLikeEmptyResults(skeleton), false);
  // the base check on raw HTML is what used to hide a stuck render
  assert.equal(BaseParser.prototype.looksLikeEmptyResults.call(parser, skeleton), true);
  // rendered pages with listings are not empty either
  assert.equal(parser.looksLikeEmptyResults(fixture('whitetail-search-dewey.html')), false);
});

function makeScrapeHarness(t, ParserClass, pages) {
  const browserFetch = require('../lib/browser-fetch');
  const originalIsEnabled = browserFetch.isEnabled;
  browserFetch.isEnabled = () => true;
  t.after(() => { browserFetch.isEnabled = originalIsEnabled; });
  const originalMaxPage = process.env.SCRAPER_MAX_PAGE;
  delete process.env.SCRAPER_MAX_PAGE;
  t.after(() => {
    if (originalMaxPage === undefined) delete process.env.SCRAPER_MAX_PAGE;
    else process.env.SCRAPER_MAX_PAGE = originalMaxPage;
  });
  const parser = new ParserClass();
  const fetched = [];
  parser.sleep = async () => {};
  parser.recordSourceIssue = (issue) => { parser.sourceIssues.push({ source: parser.name, ...issue }); return null; };
  parser.browserFetch = async (url) => {
    fetched.push(url);
    if (typeof pages === 'function') return pages(url);
    if (!(url in pages)) throw new Error(`unexpected fetch ${url}`);
    return pages[url];
  };
  return { parser, fetched };
}

test('Whitetail scrapeAll: a stuck render raises markup drift; an empty county does not; one fetch per county', async (t) => {
  const urlFor = (county) => new WhitetailParser().searchUrlFor(county, 'OK');
  const { parser, fetched } = makeScrapeHarness(t, WhitetailParser, {
    [urlFor('Dewey')]: fixture('whitetail-search-dewey-plain-fetch.html'),
    [urlFor('Pittsburg')]: fixture('whitetail-query-pittsburg-ok-40ac-empty.html'),
  });
  const listings = await parser.scrapeAll([
    { county: 'Dewey', state: 'OK', maxCPA: 2500 },
    { county: 'Pittsburg', state: 'OK', maxCPA: 2500 },
  ]);
  assert.deepEqual(fetched, [urlFor('Dewey'), urlFor('Pittsburg')], 'one render per county');
  assert.equal(listings.length, 0);
  const drift = parser.sourceIssues.filter(i => i.type === 'markup_drift');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].url, urlFor('Dewey'));
  assert.equal(parser.stats.driftPages, 1);
  assert.equal(parser.sourceIssues.length, 1, 'the empty county raises nothing');
});

test('Whitetail builds exactly one search URL per county (the site ignores &page=N)', () => {
  const parser = new WhitetailParser();
  const urls = parser.buildSearchUrls([
    { county: 'Dewey', state: 'OK' },
    { county: 'St. Francois', state: 'MO' },
  ]);
  assert.deepEqual(urls.map(u => [u.url, u.page]), [
    ['https://www.whitetailproperties.com/hunting-land?state%5B%5D=Oklahoma&county%5BOklahoma%5D%5B%5D=Dewey&acreage_min=40', 1],
    ['https://www.whitetailproperties.com/hunting-land?state%5B%5D=Missouri&county%5BMissouri%5D%5B%5D=Saint%20Francois&acreage_min=40', 1],
  ]);
});

// ---------- Whitetail query-form county search (2026-10-05 captures) ----------
// Real Chrome renders of the site's own search form URL with acreage_min=40
// (script/style bodies stripped, Mapbox token redacted).

test('Whitetail Owsley KY 40+ acres: "Showing 1-2 of 2" — the 115-acre tract, the priceless Pending card skipped', () => {
  const parser = new WhitetailParser();
  const listings = parser.parseSearchPage(fixture('whitetail-query-owsley-ky-40ac.html'), 'Owsley', 'KY');
  assert.deepEqual(listings.map(l => [l.url.replace(/^.*\/hunting-land\//, ''), l.price, l.acres]), [
    ['kentucky/owsley/private-mountain-big-buck-multi-use-hunting-property', 109000, 115],
  ]);
  assert.equal(parser._lastCardCount, 2);
  assert.equal(parser._lastTotalCount, 2);
  assert.equal(parser._lastRangeEnd, 2);
});

test('Whitetail Dewey, Le Flore and McIntosh OK 40+ acre renders parse every priced 40+ acre card', () => {
  const cases = [
    ['whitetail-query-dewey-ok-40ac.html', 'Dewey', 9, [[795600, 312], [368000, 160], [392000, 160], [376000, 160]]],
    ['whitetail-query-le-flore-ok-40ac.html', 'Leflore', 1, [[230000, 80]]],
    ['whitetail-query-mcintosh-ok-40ac.html', 'McIntosh', 5, [[949980, 355], [372000, 120], [1762405, 417.83]]],
  ];
  for (const [name, county, total, expected] of cases) {
    const parser = new WhitetailParser();
    const listings = parser.parseSearchPage(fixture(name), county, 'OK');
    assert.deepEqual(listings.map(l => [l.price, l.acres]), expected, name);
    assert.equal(parser._lastTotalCount, total, name);
    assert.ok(listings.every(l => l.acres >= 40), name);
  }
});

test('Whitetail empty county render ("Showing 0-0 of 0") is empty: no drift, no name-mismatch report', async (t) => {
  const parser0 = new WhitetailParser();
  const html = fixture('whitetail-query-pittsburg-ok-40ac-empty.html');
  assert.equal(parser0.looksLikeEmptyResults(html), true);
  const url = parser0.searchUrlFor('Pittsburg', 'OK');
  const { parser, fetched } = makeScrapeHarness(t, WhitetailParser, { [url]: html });
  const listings = await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.deepEqual(fetched, [url]);
  assert.equal(listings.length, 0);
  assert.deepEqual(parser.sourceIssues, []);
  assert.equal(parser.stats.driftPages, 0);
});

test('Whitetail reports a misspelled county filter (searched "Leflore", site lists "Le Flore") instead of a silent empty county', async (t) => {
  // Real render of county[Oklahoma][]=Leflore: "Showing 0-0 of 0", while the
  // page's own Oklahoma county checkboxes list "Le Flore". Simulate an
  // override going missing by searching the raw Airtable name.
  const html = fixture('whitetail-query-leflore-misspelled-ok-40ac.html');
  const { parser } = makeScrapeHarness(t, WhitetailParser, () => html);
  parser.countyFilterValue = county => county; // no override
  const listings = await parser.scrapeAll([{ county: 'Leflore', state: 'OK', maxCPA: 2500 }]);
  assert.equal(listings.length, 0);
  const mismatch = parser.sourceIssues.filter(i => i.type === 'county_name_mismatch');
  assert.equal(mismatch.length, 1);
  assert.match(mismatch[0].error, /Searched county "Leflore" returned 0 listings, but Whitetail lists this county as "Le Flore"/);
  assert.equal(parser.stats.driftPages, 0, 'still not markup drift');

  // With the real override in place the same empty page raises nothing
  // (an empty county the site does not list at all is simply empty).
  const second = makeScrapeHarness(t, WhitetailParser, () => fixture('whitetail-query-pittsburg-ok-40ac-empty.html'));
  await second.parser.scrapeAll([{ county: 'Leflore', state: 'OK', maxCPA: 2500 }]);
  assert.deepEqual(second.parser.sourceIssues, []);
});

test('Whitetail: more results than the rendered page ("Showing 1-50 of 96") is a coverage warning', async (t) => {
  // Real state-level render (Oklahoma, 40+ acres) standing in for a county
  // with more than one page of qualifying listings.
  const html = fixture('whitetail-query-state-oklahoma-40ac-96-results.html');
  const { parser, fetched } = makeScrapeHarness(t, WhitetailParser, () => html);
  await parser.scrapeAll([{ county: 'Pushmataha', state: 'OK', maxCPA: 2500 }]);
  assert.equal(fetched.length, 1, 'still one render: &page=2 is ignored by the site');
  const truncated = parser.sourceIssues.filter(i => i.type === 'coverage_truncated');
  assert.equal(truncated.length, 1);
  assert.match(truncated[0].error, /site reports 96 listings, so about 46 were not read/);
});

test('Whitetail: a complete county page ("Showing 1-9 of 9") is not a coverage warning', async (t) => {
  const { parser } = makeScrapeHarness(t, WhitetailParser, () => fixture('whitetail-query-dewey-ok-40ac.html'));
  const listings = await parser.scrapeAll([{ county: 'Dewey', state: 'OK', maxCPA: 2500 }]);
  assert.equal(listings.length, 4);
  assert.deepEqual(parser.sourceIssues, []);
});

// ---------- LandWatch per-county page cap (verifier D6) ----------

const LW_PITTSBURG_AO40 = 'https://www.landwatch.com/oklahoma-land-for-sale/pittsburg-county/acres-over-40';

test('LandWatch: only the last planned page of a county carries the full-page coverage check', () => {
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls([{ county: 'Pittsburg', state: 'OK' }]);
  const flagged = urls.filter(u => u.warnIfFullAtCards);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].url, `${LW_PITTSBURG_AO40}/page-${LandWatchParser.MAX_PAGES_PER_COUNTY}`);
  assert.equal(flagged[0].warnIfFullAtCards, LandWatchParser.RESULTS_PER_PAGE);
});

test('LandWatch scrapeAll records coverage_truncated when the site total runs past the 10-page cap', async (t) => {
  // Every page is a full 25-card page stating 300 results in total.
  const full = fixture('landwatch-search-acres-over-40-pittsburg-page-1.html').replace(/"totalCount":61/, '"totalCount":300').replace(/LandWatch has 61 land/g, 'LandWatch has 300 land');
  const { parser, fetched } = makeScrapeHarness(t, LandWatchParser, () => full);
  await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(fetched.length, 10, 'the cap holds: page 11 is never requested');
  const truncated = parser.sourceIssues.filter(i => i.type === 'coverage_truncated');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].url, `${LW_PITTSBURG_AO40}/page-10`);
  assert.match(truncated[0].error, /site reports 300 listings, so about 50 were not read/);
});

test('LandWatch scrapeAll records no coverage warning when the total ends exactly at the cap', async (t) => {
  const full = fixture('landwatch-search-acres-over-40-pittsburg-page-1.html').replace(/"totalCount":61/, '"totalCount":250').replace(/LandWatch has 61 land/g, 'LandWatch has 250 land');
  const { parser, fetched } = makeScrapeHarness(t, LandWatchParser, () => full);
  await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(fetched.length, 10);
  assert.equal(parser.sourceIssues.filter(i => i.type === 'coverage_truncated').length, 0);
});

test('LandWatch scrapeAll records no coverage warning when the series ends before the cap', async (t) => {
  const { parser, fetched } = makeScrapeHarness(t, LandWatchParser, url => {
    if (url === LW_PITTSBURG_AO40) return fixture('landwatch-search-acres-over-40-pittsburg-page-1.html');
    if (url === `${LW_PITTSBURG_AO40}/page-2`) return fixture('landwatch-search-acres-over-40-pittsburg-page-2.html');
    if (url === `${LW_PITTSBURG_AO40}/page-3`) return fixture('landwatch-search-acres-over-40-pittsburg-page-3.html');
    throw new Error(`unexpected fetch ${url}`);
  });
  await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(fetched.length, 3);
  assert.equal(parser.sourceIssues.filter(i => i.type === 'coverage_truncated').length, 0);
});

test('LandWatch, total unreadable: a still-full page 10 is a coverage warning', async (t) => {
  const full = fixture('landwatch-search-acres-over-40-pittsburg-page-1.html').replace(/"totalCount":61/, '"noTotal":0').replace(/LandWatch has 61 land/g, 'LandWatch has many land');
  const { parser, fetched } = makeScrapeHarness(t, LandWatchParser, () => full);
  await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(fetched.length, 10);
  const truncated = parser.sourceIssues.filter(i => i.type === 'coverage_truncated');
  assert.equal(truncated.length, 1);
  assert.match(truncated[0].error, /still full \(25 listings\)/);
});

// ---------- one listing, two href spellings (verifier D7) ----------

test('extractByDetailLinks treats relative and absolute/trailing-slash links to one listing as one card', () => {
  const parser = new WhitetailParser();
  const html = `<html><body><div class="results">
    <div class="card">
      <div><a href="https://www.whitetailproperties.com/hunting-land/oklahoma/dewey/creek-tract/"><img src="x.jpg"></a></div>
      <div><h3><a href="/hunting-land/oklahoma/dewey/creek-tract">Creek Tract</a></h3></div>
      <span>$400,000</span><span>160 acres ±</span><span>Dewey County • Taloga, OK</span>
    </div>
    <div class="card">
      <div><a href="/hunting-land/oklahoma/dewey/ridge-tract"><img src="y.jpg"></a></div>
      <div><h3><a href="/hunting-land/oklahoma/dewey/ridge-tract">Ridge Tract</a></h3></div>
      <span>$600,000</span><span>240 acres ±</span><span>Dewey County • Taloga, OK</span>
    </div>
  </div></body></html>`;
  const listings = parser.extractByDetailLinks(cheerio.load(html), {
    hrefPattern: /\/hunting-land\/[^/]+\/[^/]+\/[^/?#]+/i,
    county: 'Dewey',
    state: 'OK',
    verifyCounty: true,
  });
  assert.equal(parser._lastCardCount, 2);
  assert.deepEqual(listings.map(l => [l.name, l.price, l.acres]), [
    ['Creek Tract', 400000, 160],
    ['Ridge Tract', 600000, 240],
  ]);
  assert.equal(listings[0].url, 'https://www.whitetailproperties.com/hunting-land/oklahoma/dewey/creek-tract/');
});

test('LandWatch, total unreadable: a full page of only out-of-county "nearby" cards ends the series without a warning', async (t) => {
  // Page-1 Pittsburg cards served for a Dewey search: 25 cards, every one
  // rejected by verifyCounty — the padding LandWatch shows past the results.
  const pittsburgCards = fixture('landwatch-search-acres-over-40-pittsburg-page-1.html').replace(/"totalCount":61/, '"noTotal":0').replace(/LandWatch has 61 land/g, 'LandWatch has many land');
  const deweyCards = pittsburgCards.replace(/pittsburg/gi, 'dewey');
  const { parser, fetched } = makeScrapeHarness(t, LandWatchParser, url => (url.includes('/page-') ? pittsburgCards : deweyCards));
  const listings = await parser.scrapeAll([{ county: 'Dewey', state: 'OK', maxCPA: 2500 }]);
  assert.equal(listings.length, 25);
  assert.equal(fetched.length, 2, 'the zero-listing page 2 ends the series');
  assert.equal(parser.sourceIssues.filter(i => i.type === 'coverage_truncated').length, 0);
  assert.equal(parser.stats.driftPages, 0);
});
