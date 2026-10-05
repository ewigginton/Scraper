'use strict';

// Parser-side fixes from the 2026-10-05 verification round:
//   - float-noise acreage/price is rounded at the shared numeric parse
//     (NationalLandRealty data-acres "5.5600000000000005" was refused by the
//     write-time plausibility guard's decimal-places rule)
//   - LandWatch's rounded card headline acreage ("241 acres") is refined to
//     the surveyed figure the page also states ("240.65 +/- acre")
//   - Whitetail: a zero-card render is drift unless the RENDERED page says
//     the county is empty; ?page=2 (ignored by the site) is no longer fetched
//   - LandWatch: a still-full last large-tract page records a coverage warning
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
  const base = 'https://www.whitetailproperties.com/hunting-land/oklahoma';
  const { parser, fetched } = makeScrapeHarness(t, WhitetailParser, {
    [`${base}/dewey`]: fixture('whitetail-search-dewey-plain-fetch.html'),
    [`${base}/pittsburg`]: fixture('whitetail-search-pittsburg-empty.html'),
  });
  const listings = await parser.scrapeAll([
    { county: 'Dewey', state: 'OK', maxCPA: 2500 },
    { county: 'Pittsburg', state: 'OK', maxCPA: 2500 },
  ]);
  assert.deepEqual(fetched, [`${base}/dewey`, `${base}/pittsburg`], 'no ?page=2 fetches');
  assert.equal(listings.length, 0);
  const drift = parser.sourceIssues.filter(i => i.type === 'markup_drift');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].url, `${base}/dewey`);
  assert.equal(parser.stats.driftPages, 1);
});

test('Whitetail builds exactly one search URL per county (the site ignores ?page=N)', () => {
  const parser = new WhitetailParser();
  const urls = parser.buildSearchUrls([
    { county: 'Dewey', state: 'OK' },
    { county: 'St. Francois', state: 'MO' },
  ]);
  assert.deepEqual(urls.map(u => [u.url, u.page]), [
    ['https://www.whitetailproperties.com/hunting-land/oklahoma/dewey', 1],
    ['https://www.whitetailproperties.com/hunting-land/missouri/saint-francois', 1],
  ]);
});

// ---------- LandWatch large-tract coverage cap (verifier D6) ----------

test('LandWatch: only the last large-tract page carries the full-page coverage check', () => {
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls([{ county: 'Pittsburg', state: 'OK' }]);
  const flagged = urls.filter(u => u.warnIfFullAtCards);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].url, new RegExp(`/acres-over-150/page-${LandWatchParser.LARGE_TRACT_MAX_PAGES}$`));
  assert.equal(flagged[0].warnIfFullAtCards, LandWatchParser.RESULTS_PER_PAGE);
});

test('LandWatch scrapeAll records coverage_truncated when the last large-tract page is still full', async (t) => {
  const full = fixture('landwatch-search-acres-over-150-pittsburg-page-1.html'); // 25 cards
  const empty = fixture('landwatch-search-acres-over-150-pittsburg-page-3.html');
  const ao150 = 'https://www.landwatch.com/oklahoma-land-for-sale/pittsburg-county/acres-over-150';
  const { parser, fetched } = makeScrapeHarness(t, LandWatchParser, url => (url.includes('acres-over-150') ? full : empty));
  await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(fetched.filter(u => u.startsWith(ao150)).length, 5);
  const truncated = parser.sourceIssues.filter(i => i.type === 'coverage_truncated');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].url, `${ao150}/page-5`);
  assert.match(truncated[0].error, /still full \(25 listings\)/);
});

test('LandWatch scrapeAll records no coverage warning when the series ends before the cap', async (t) => {
  const ao150 = 'https://www.landwatch.com/oklahoma-land-for-sale/pittsburg-county/acres-over-150';
  const empty = fixture('landwatch-search-acres-over-150-pittsburg-page-3.html');
  const { parser } = makeScrapeHarness(t, LandWatchParser, url => {
    if (url === ao150) return fixture('landwatch-search-acres-over-150-pittsburg-page-1.html');
    if (url === `${ao150}/page-2`) return fixture('landwatch-search-acres-over-150-pittsburg-page-2.html');
    return empty;
  });
  await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(parser.sourceIssues.filter(i => i.type === 'coverage_truncated').length, 0);
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

test('LandWatch: a last large-tract page of only out-of-county "nearby" cards is not a coverage warning', async (t) => {
  // Page-1 Pittsburg cards served for a Dewey search: 25 cards, every one
  // rejected by verifyCounty — the padding LandWatch shows past the results.
  const full = fixture('landwatch-search-acres-over-150-pittsburg-page-1.html');
  const { parser, fetched } = makeScrapeHarness(t, LandWatchParser, url => {
    if (url.includes('/page-5')) return full;
    if (url.includes('acres-over-150')) return fixture('landwatch-search-acres-over-150-pittsburg-page-1.html').replace(/pittsburg/gi, 'dewey');
    return fixture('landwatch-search-acres-over-150-pittsburg-page-3.html');
  });
  await parser.scrapeAll([{ county: 'Dewey', state: 'OK', maxCPA: 2500 }]);
  assert.ok(fetched.some(u => u.endsWith('/acres-over-150/page-5')), 'the series really reached page 5');
  assert.equal(parser.sourceIssues.filter(i => i.type === 'coverage_truncated').length, 0);
});
