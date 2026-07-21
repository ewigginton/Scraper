'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const WhitetailParser = require('../lib/parsers/whitetail');
const MossyOakParser = require('../lib/parsers/mossyoak');

const counties = [
  { county: 'Wayne', state: 'KY', maxCPA: 2500 },
  { county: 'St. Francois', state: 'MO', maxCPA: 4000 },
];

// ---------- URL building ----------

test('Whitetail builds /hunting-land/{state}/{county} URLs with saint-expansion', () => {
  const parser = new WhitetailParser();
  const urls = parser.buildSearchUrls(counties);
  assert.match(urls[0].url, /whitetailproperties\.com\/hunting-land\/kentucky\/wayne$/);
  const stFrancois = urls.find(u => u.county === 'St. Francois');
  // Whitetail spells out "saint" — st-francois would 404 every night
  assert.match(stFrancois.url, /\/hunting-land\/missouri\/saint-francois/);
});

test('MossyOak builds /land-for-sale/{state}/{county}-county/ URLs with ?pg pagination', () => {
  const parser = new MossyOakParser();
  const urls = parser.buildSearchUrls(counties);
  assert.match(urls[0].url, /mossyoakproperties\.com\/land-for-sale\/kentucky\/wayne-county\/$/);
  const page2 = urls.find(u => u.county === 'Wayne' && u.page === 2);
  assert.match(page2.url, /wayne-county\/\?pg=2$/);
});

test('pagination series keys collapse page 1 (no param) and deeper ?pg=N/?page=N pages into one key', () => {
  const parser = new MossyOakParser();
  const page1 = parser.paginationSeriesKey('https://x.com/land-for-sale/kentucky/wayne-county/', 'Wayne', 'KY');
  const page2 = parser.paginationSeriesKey('https://x.com/land-for-sale/kentucky/wayne-county/?pg=2', 'Wayne', 'KY');
  const page3 = parser.paginationSeriesKey('https://x.com/land-for-sale/kentucky/wayne-county/?pg=3', 'Wayne', 'KY');
  // Page 1 carries NO ?pg param while deeper pages do — stripping the param
  // entirely makes all three share ONE key, so once page 1 404s exhaustedSeries
  // skips page 2 instead of re-hitting a county whose page 1 already failed.
  assert.equal(page1, page2);
  assert.equal(page2, page3);
  // ?page=N is stripped identically to ?pg=N.
  assert.equal(
    parser.paginationSeriesKey('https://x.com/hunting-land/kentucky/wayne', 'Wayne', 'KY'),
    parser.paginationSeriesKey('https://x.com/hunting-land/kentucky/wayne?page=4', 'Wayne', 'KY'),
  );
  // Other query params survive when the stripped param is LAST...
  assert.equal(
    parser.paginationSeriesKey('https://x.com/s?minAcres=40&sort=newest', 'W', 'KY'),
    parser.paginationSeriesKey('https://x.com/s?minAcres=40&sort=newest&page=2', 'W', 'KY'),
  );
  // ...and when it is FIRST but followed by other params (separator handling).
  assert.equal(
    parser.paginationSeriesKey('https://x.com/s?foo=bar', 'W', 'KY'),
    parser.paginationSeriesKey('https://x.com/s?pg=3&foo=bar', 'W', 'KY'),
  );
});

test('a 404 on MossyOak page 1 (no param) prevents the ?pg=2 fetch', async () => {
  // MossyOak's page 1 is /...county/ with NO param and page 2 is /...county/?pg=2.
  // Once page 1 404s, the shared series key must let exhaustedSeries skip page 2
  // — last night the differing keys let it fetch ?pg=2 of already-404'd counties.
  // Drive the REAL scrapeAll with the REAL parser and a fetch stubbed to throw.
  const parser = new MossyOakParser();
  parser.sleep = () => Promise.resolve();
  const fetched = [];
  parser.fetchPageSmart = async (url) => {
    fetched.push(url);
    const err = new Error(`HTTP 404 for ${url}`);
    err.status = 404;
    throw err;
  };

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY', maxCPA: 2500 }]);

  assert.deepEqual(
    fetched,
    ['https://www.mossyoakproperties.com/land-for-sale/kentucky/wayne-county/'],
    'only page 1 is fetched; its 404 exhausts the shared series so page 2 is skipped',
  );
  assert.equal(listings.length, 0);
});

// ---------- generic extraction engine ----------

const whitetailCard = (opts = {}) => `
  <html><body>
    <div class="whatever-classes-they-use">
      <a href="/hunting-land/kentucky/wayne/beautiful-160-acre-farm">
        Beautiful 160 Acre Farm With Creek
      </a>
      <span>${opts.location || 'Wayne County, KY'}</span>
      <span>${opts.acres || '160± Acres'}</span>
      <span>${opts.price || '$480,000'}</span>
    </div>
  </body></html>`;

test('Whitetail extracts a listing from class-agnostic markup', () => {
  const parser = new WhitetailParser();
  const listings = parser.parseSearchPage(whitetailCard(), 'Wayne', 'KY');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 480000);
  assert.equal(listings[0].acres, 160);
  assert.equal(listings[0].url, 'https://www.whitetailproperties.com/hunting-land/kentucky/wayne/beautiful-160-acre-farm');
  assert.match(listings[0].name, /Beautiful 160 Acre Farm/);
});

test('extraction takes the total price, not a per-acre figure on the same card', () => {
  const parser = new WhitetailParser();
  const html = whitetailCard({ price: '$3,000/acre — $480,000 total' });
  const listings = parser.parseSearchPage(html, 'Wayne', 'KY');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 480000);
});

test('acreage variants parse: "30+/- Acres" and "155± Acres"', () => {
  const parser = new WhitetailParser();
  assert.equal(parser.extractAcres('30+/- Acres near town'), 30);
  assert.equal(parser.extractAcres('Platte County Highly Tillable 155± Acres'), 155);
  assert.equal(parser.extractAcres('1,356 acres ranch'), 1356);
});

test('cards from a different county are dropped when the page mixes inventory', () => {
  const parser = new MossyOakParser();
  const html = `
    <html><body>
      <div>
        <a href="/property/nice-farm-123">Nice Farm</a>
        <span>Hickman County, KY</span> <span>200 acres</span> <span>$400,000</span>
      </div>
      <div>
        <a href="/property/other-farm-456">Other Farm</a>
        <span>Graves County, KY</span> <span>150 acres</span> <span>$300,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Hickman', 'KY');
  assert.equal(listings.length, 1);
  assert.match(listings[0].name, /Nice Farm/);
});

test('"St. Francois" card text matches a "Saint Francois" target (and vice versa)', () => {
  const parser = new WhitetailParser();
  const html = whitetailCard({ location: 'Saint Francois County, MO' });
  const listings = parser.parseSearchPage(html, 'St. Francois', 'MO');
  assert.equal(listings.length, 1);
});

test('MossyOak ignores county/region navigation links entirely', () => {
  const parser = new MossyOakParser();
  const html = `
    <html><body>
      <nav>
        <a href="/land-for-sale/kentucky/graves-county/">Graves County</a>
        <a href="/land-for-sale/kentucky/">Kentucky</a>
      </nav>
      <p>Browse 2,475 listings. Prices from $10,000. Acres vary.</p>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Hickman', 'KY');
  assert.deepEqual(listings, []);
  assert.equal(parser._lastCardCount, 0, 'nav links must not count as cards');
});

test('a page with cards but no parseable price/acres yields no listings but counts cards', () => {
  const parser = new WhitetailParser();
  const html = `
    <html><body>
      <div><a href="/hunting-land/kentucky/wayne/coming-soon-listing">Coming Soon</a>
      <span>Wayne County, KY — price on request</span></div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Wayne', 'KY');
  assert.deepEqual(listings, []);
  assert.equal(parser._lastCardCount, 1, 'card was seen even though it was unparseable');
});

// ---------- naming: photo-overlay anchors must not win the listing name ----------

test('a title anchor beats a photo-overlay anchor sharing the same detail href', () => {
  const parser = new MossyOakParser();
  const html = `
    <html><body>
      <div>
        <a href="/property/reynolds-farm-789"><img src="x.jpg" alt="">Click to View More Photos</a>
        <a href="/property/reynolds-farm-789">Beautiful Reynolds County Farm</a>
        <span>Reynolds County, MO</span> <span>200 acres</span> <span>$400,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Reynolds', 'MO');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].name, 'Beautiful Reynolds County Farm');
  assert.equal(parser._lastCardCount, 1, 'one detail href, not two cards');
});

test('a heading inside the card wins when every anchor for the href is junk', () => {
  const parser = new MossyOakParser();
  const html = `
    <html><body>
      <div>
        <h3>Rolling Hills Hunting Tract</h3>
        <a href="/property/rolling-hills-321">Click to View More Photos</a>
        <a href="/property/rolling-hills-321">View Details</a>
        <span>Reynolds County, MO</span> <span>150 acres</span> <span>$300,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Reynolds', 'MO');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].name, 'Rolling Hills Hunting Tract');
});

test('falls back to "${county} Land" when no anchor text or heading is usable', () => {
  const parser = new MossyOakParser();
  const html = `
    <html><body>
      <div>
        <a href="/property/no-title-654">Click to View More Photos</a>
        <a href="/property/no-title-654">More</a>
        <span>Reynolds County, MO</span> <span>80 acres</span> <span>$200,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Reynolds', 'MO');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].name, 'Reynolds Land');
});
