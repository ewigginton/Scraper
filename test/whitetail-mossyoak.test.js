'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WhitetailParser = require('../lib/parsers/whitetail');
const MossyOakParser = require('../lib/parsers/mossyoak');

// Every Oklahoma county-navigation anchor (display name + exact slug) trimmed
// from data/evidence/www.mossyoakproperties.com-land-for-sale-oklahoma-d2ddfcda.html
// (full raw capture on the evidence-inbox branch — data/evidence is gitignored).
const okCountyLinksHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'mossyoak-oklahoma-county-links.html'),
  'utf8',
);

const counties = [
  { county: 'Wayne', state: 'KY', maxCPA: 2500 },
  { county: 'St. Francois', state: 'MO', maxCPA: 4000 },
];

// ---------- URL building ----------

test('Whitetail builds the site\'s own county search (state-keyed county filter, 40+ acres) with saint-expansion', () => {
  const parser = new WhitetailParser();
  const urls = parser.buildSearchUrls(counties);
  assert.equal(urls[0].url,
    'https://www.whitetailproperties.com/hunting-land?state%5B%5D=Kentucky&county%5BKentucky%5D%5B%5D=Wayne&acreage_min=40');
  const stFrancois = urls.find(u => u.county === 'St. Francois');
  // Whitetail's Missouri county filter spells out "Saint" ("Saint Francois",
  // live 2026-10-05); detail URLs use the matching saint-francois slug
  assert.equal(stFrancois.url,
    'https://www.whitetailproperties.com/hunting-land?state%5B%5D=Missouri&county%5BMissouri%5D%5B%5D=Saint%20Francois&acreage_min=40');
  assert.equal(parser.countySlug('St. Francois'), 'saint-francois');
});

test('MossyOak builds /land-for-sale/{state}/{county}-county/ URLs with ?pg pagination', () => {
  const parser = new MossyOakParser();
  const urls = parser.buildSearchUrls(counties);
  assert.match(urls[0].url, /mossyoakproperties\.com\/land-for-sale\/kentucky\/wayne-county\/$/);
  const page2 = urls.find(u => u.county === 'Wayne' && u.page === 2);
  assert.match(page2.url, /wayne-county\/\?pg=2$/);
});

test('MossyOak countySlug reproduces EVERY real Oklahoma county href from its display name', () => {
  const parser = new MossyOakParser();

  // Pull (slug, displayName) from every county anchor in the captured OK page.
  const re = /href="[^"]*land-for-sale\/oklahoma\/([a-z0-9-]+)-county\/"[^>]*>([^<]+)</gi;
  const pairs = [];
  let m;
  while ((m = re.exec(okCountyLinksHtml))) {
    const slug = m[1];
    // Display name is the text before " County ..." ("McClain County Oklahoma
    // Land for Sale" -> "McClain", "Le Flore County ..." -> "Le Flore").
    const countyName = m[2].replace(/\s+County\b[\s\S]*$/i, '').trim();
    pairs.push({ slug, countyName });
  }

  assert.equal(pairs.length, 77, 'all 77 OK county anchors present in the fixture');

  // The bug counties must be in the table (proves the fixture really exercises
  // the camel-case rule, not just plain names).
  const bySlug = Object.fromEntries(pairs.map(p => [p.slug, p.countyName]));
  assert.equal(bySlug['mc-clain'], 'McClain');
  assert.equal(bySlug['mc-curtain'], 'McCurtain');
  assert.equal(bySlug['mc-intosh'], 'McIntosh');
  assert.equal(bySlug['le-flore'], 'Le Flore');

  for (const { slug, countyName } of pairs) {
    assert.equal(
      parser.countySlug(countyName),
      slug,
      `countySlug(${JSON.stringify(countyName)}) should be "${slug}"`,
    );
  }
});

test('MossyOak countySlug handles the Airtable "Leflore" spelling and other Mc counties', () => {
  const parser = new MossyOakParser();
  // Airtable stores LeFlore without the internal capital, so the camel-case
  // rule can't recover the hyphen — the explicit override map does.
  assert.equal(parser.countySlug('Leflore'), 'le-flore');
  assert.equal(parser.countySlug('leflore'), 'le-flore');
  // Mc-counties outside the OK page still follow the hyphenation rule.
  assert.equal(parser.countySlug('McNairy'), 'mc-nairy');   // TN
  assert.equal(parser.countySlug('McCreary'), 'mc-creary'); // KY
  // Plain names with no internal capital are untouched.
  assert.equal(parser.countySlug('Logan'), 'logan');
  assert.equal(parser.countySlug('Roger Mills'), 'roger-mills');
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

test('the Airtable "Leflore" target matches "Le Flore County" card text (and vice versa)', () => {
  // The real OK page spells it "Le Flore County," on cards while Airtable
  // stores "Leflore" — without the space-variant matching, verifyCounty would
  // drop every Le Flore card the moment the fixed slug starts resolving.
  const parser = new MossyOakParser();
  const html = `
    <html><body>
      <div>
        <a href="/property/beech-creek-90652">Beech Creek Tract</a>
        <span>Le Flore County, OK</span> <span>120 acres</span> <span>$300,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Leflore', 'OK');
  assert.equal(listings.length, 1, 'space-less Airtable spelling must match the spaced site spelling');

  // Reverse direction: a spaced target matches space-less card text.
  const squashed = html.replace('Le Flore County', 'Leflore County');
  assert.equal(parser.parseSearchPage(squashed, 'Le Flore', 'OK').length, 1);

  // A genuinely different county still drops.
  assert.equal(parser.parseSearchPage(html, 'Latimer', 'OK').length, 0);
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

// ---------- Whitetail glued price/acreage (real rendered search pages) ----------
//
// The 2026-09-15 nightly wrote 81 Whitetail leads with impossible values:
// each card renders <span>$873,600</span><span>312 acres ±</span> with no
// whitespace between the two elements, cheerio's .text() fused them into
// "$873,600312 acres", and the parser read 873,600,312 acres. These fixtures
// are real browser renders captured 2026-10-05 (script/style bodies and SVGs
// stripped to keep them small); the pre-fix parser produced glued values on
// every priced card in all three.

// Every priced card on each fixture, in page order. Pending cards show
// acreage only (no price) and must be dropped — before the card-boundary fix
// they walked up to the results list and inherited the FIRST card's values.
const WHITETAIL_EXPECTED = {
  dewey: {
    county: 'Dewey', state: 'OK', cards: 9,
    listings: [
      { slug: 'awesome-hunting-property-within-400-yards-of-the-south-canadian-river', price: 795600, acres: 312 },
      { slug: 'secluded-deer-hunting-bordered-by-other-great-hunting-tracts', price: 368000, acres: 160 },
      { slug: 'less-than-two-miles-west-of-the-south-canadian-river', price: 392000, acres: 160 },
      { slug: 'oakwood-pasture-and-wind-energy', price: 376000, acres: 160 },
    ],
  },
  scott: {
    county: 'Scott', state: 'TN', cards: 3,
    listings: [
      { slug: 'scott-co-81269', price: 1340938, acres: 812.69 },
      { slug: 'robbins-tn', price: 940000, acres: 286 },
      { slug: 'industrial-and-recreational-potential', price: 1950000, acres: 1272 },
    ],
  },
  owsley: {
    county: 'Owsley', state: 'KY', cards: 9,
    listings: [
      { slug: 'unrestricted-hidden-ridge-retreat-with-off-grid-cabin_0001', price: 159000, acres: 19 },
      { slug: 'ultimate-basecamp-adjoining-daniel-boone-national-forest', price: 44500, acres: 6.62 },
      { slug: 'multiple-cabin-sites-on-national-forest-edge-acreage', price: 57900, acres: 10.4 },
      { slug: 'hidden-and-usable-acreage-near-daniel-boone-national-forest', price: 34900, acres: 6.22 },
      { slug: 'wilderness-basecamp-property-near-daniel-boone-national-forest', price: 21900, acres: 4.67 },
      { slug: 'restricted-acreage-with-building-locations-near-national-forest', price: 36900, acres: 8.35 },
      { slug: 'unrestricted-country-getaway', price: 39000, acres: 12.2 },
      { slug: 'private-mountain-big-buck-multi-use-hunting-property', price: 109000, acres: 115 },
    ],
  },
};

function loadWhitetailFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', `whitetail-search-${name}.html`), 'utf8');
}

for (const [name, expected] of Object.entries(WHITETAIL_EXPECTED)) {
  test(`Whitetail ${expected.county} County, ${expected.state} fixture: every priced card has its own correct price and acreage`, () => {
    const parser = new WhitetailParser();
    const listings = parser.parseSearchPage(loadWhitetailFixture(name), expected.county, expected.state);
    assert.equal(parser._lastCardCount, expected.cards, 'every detail link counts as a card for drift detection');
    assert.equal(listings.length, expected.listings.length, JSON.stringify(listings.map(l => [l.url, l.price, l.acres])));
    expected.listings.forEach((want, i) => {
      const got = listings[i];
      assert.ok(got.url.includes(want.slug), `card ${i}: ${got.url} should be ${want.slug}`);
      assert.equal(got.price, want.price, `card ${i} price (${got.url})`);
      assert.equal(got.acres, want.acres, `card ${i} acres (${got.url})`);
      // The written description must not carry the fused "$873,600312" text
      assert.doesNotMatch(got.description, /\$[\d,]+,\d{3}\d/, `card ${i} description is still glued: ${got.description}`);
    });
  });

  test(`Whitetail ${expected.county} County, ${expected.state} fixture: parsed acreage matches each card's own listing_acreage tracking attribute`, () => {
    // Independent ground truth: every card's anchor carries the site's own
    // analytics payload (data-track-data JSON with listing_acreage). The
    // parser never reads it, so it cross-checks the text extraction.
    const cheerio = require('cheerio');
    const html = loadWhitetailFixture(name);
    const $ = cheerio.load(html);
    const truthByHref = new Map();
    $('a[data-track-data]').each((_, el) => {
      const href = $(el).attr('href') || '';
      try {
        const data = JSON.parse($(el).attr('data-track-data'));
        if (data.listing_acreage != null) truthByHref.set(href, Number(data.listing_acreage));
      } catch (err) { /* not a listing anchor */ }
    });
    const listings = new WhitetailParser().parseSearchPage(html, expected.county, expected.state);
    assert.ok(listings.length > 0);
    for (const l of listings) {
      const truth = truthByHref.get(new URL(l.url).pathname);
      assert.ok(truth != null, `no tracking acreage for ${l.url}`);
      assert.equal(l.acres, truth, `${l.url}: parsed ${l.acres} ac, card says ${truth} ac`);
      assert.ok(l.price / l.acres < 100000, `${l.url}: $${l.price} for ${l.acres} ac is not a plausible land price`);
    }
  });
}

test('Whitetail: the production-report glued strings now parse to the live-verified values', () => {
  // Card texts quoted verbatim from the 2026-09-15 nightly report; the live
  // recheck proved 312 ac / $873,600, 1,272 ac / $1,950,000, 93 ac / $359,000.
  const parser = new WhitetailParser();
  const cases = [
    ['For Sale $873,600312 acres ± Dewey County • Putnam, OK 73659', 873600, 312],
    ['For Sale $1,950,0001272 acres ± Scott County • Winfield, TN 37892', 1950000, 1272],
    ['Reduced $359,00093 acres ± Hardin County • Adamsville, TN 38310', 359000, 93],
  ];
  for (const [text, price, acres] of cases) {
    assert.equal(parser.extractTotalPrice(text), price, text);
    assert.equal(parser.extractAcres(text), acres, text);
  }
});

test('Whitetail: adjacent price/acreage elements are separated when the card text is built', () => {
  // Minimal reproduction of the real card markup: no whitespace at all
  // between the price span and the acreage span.
  const parser = new WhitetailParser();
  const html = '<div class="row"><div class="card"><a href="/hunting-land/oklahoma/dewey/test-tract">'
    + '<span class="badge">Reduced</span><div class="card-header"><span>$873,600</span><span>312 acres&nbsp;±</span></div>'
    + '<div class="card-body">Dewey County • Putnam, OK 73659</div></a></div></div>';
  const listings = parser.parseSearchPage(html, 'Dewey', 'OK');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 873600);
  assert.equal(listings[0].acres, 312);
  assert.match(listings[0].description, /\$873,600 312 acres/);
});

test('Whitetail: a price-less (Pending) card never inherits a neighbouring card\'s values', () => {
  const parser = new WhitetailParser();
  const card = (slug, header) => `<div class="card"><a href="/hunting-land/oklahoma/dewey/${slug}">`
    + `<div class="card-header">${header}</div><div class="card-body">Dewey County • Putnam, OK</div></a></div>`;
  const html = `<main><div class="list">${card('priced', '<span>$500,000</span> <span>200 acres</span>')}`
    + `${card('pending', '<span>591.38 acres</span>')}</div></main>`;
  const listings = parser.parseSearchPage(html, 'Dewey', 'OK');
  assert.deepEqual(listings.map(l => [l.url.split('/').pop(), l.price, l.acres]), [['priced', 500000, 200]]);
  assert.equal(parser._lastCardCount, 2, 'the pending card still counts as a card (no false drift)');
});

test('Whitetail is browser-rendered: a plain fetch is a card-less skeleton, and it is NOT mistaken for an empty county', () => {
  // Real plain HTTP 200 fetch of the same Dewey County URL the rendered
  // fixture came from (captured 2026-10-05, unmodified): zero cards, and the
  // page's inline script carries "No listings found for this search.", which
  // the base raw-HTML empty-results check matches — a silent zero with no
  // drift alert. Whitetail's looksLikeEmptyResults judges only the rendered
  // markup (scripts stripped), so a skeleton / stuck render now reads as
  // not-empty and page 1 can raise drift. Only browser rendering yields the
  // 9 real cards.
  const parser = new WhitetailParser();
  assert.equal(parser.requiresBrowserRender, true);
  const plain = fs.readFileSync(path.join(__dirname, 'fixtures', 'whitetail-search-dewey-plain-fetch.html'), 'utf8');
  assert.deepEqual(parser.parseSearchPage(plain, 'Dewey', 'OK'), []);
  assert.equal(parser._lastCardCount, 0);
  assert.equal(parser.looksLikeEmptyResults(plain), false, 'the script-only marker no longer hides a stuck render');
  parser.parseSearchPage(loadWhitetailFixture('dewey'), 'Dewey', 'OK');
  assert.equal(parser._lastCardCount, 9, 'the rendered page has the cards');
});

test('Whitetail searches "Le Flore" for the Airtable "Leflore" county ("Leflore"/"LeFlore" return 0 live)', () => {
  const WhitetailParser = require('../lib/parsers/whitetail');
  const parser = new WhitetailParser();
  const urls = parser.buildSearchUrls([{ county: 'Leflore', state: 'OK' }]).map(u => u.url);
  assert.deepEqual(urls, [
    'https://www.whitetailproperties.com/hunting-land?state%5B%5D=Oklahoma&county%5BOklahoma%5D%5B%5D=Le%20Flore&acreage_min=40',
  ]);
  // detail URLs still use the le-flore path slug
  assert.equal(parser.countySlug('Leflore'), 'le-flore');
});

test('Whitetail county filter values for multi-word and Mc counties match the site\'s own names (live 2026-10-05)', () => {
  const parser = new WhitetailParser();
  const cases = [
    ['Roger Mills', 'OK', 'Oklahoma', 'Roger%20Mills'],
    ['McCurtain', 'OK', 'Oklahoma', 'McCurtain'],
    ['McIntosh', 'OK', 'Oklahoma', 'McIntosh'],
    ['Van Buren', 'TN', 'Tennessee', 'Van%20Buren'],
    ['San Saba', 'TX', 'Texas', 'San%20Saba'],
    ['San Augustine', 'TX', 'Texas', 'San%20Augustine'],
    ['Ste. Genevieve', 'MO', 'Missouri', 'Sainte%20Genevieve'],
    ['Cherokee', 'SC', 'South%20Carolina', 'Cherokee'],
  ];
  for (const [county, state, encodedState, encodedCounty] of cases) {
    const [{ url }] = parser.buildSearchUrls([{ county, state }]);
    assert.equal(url,
      `https://www.whitetailproperties.com/hunting-land?state%5B%5D=${encodedState}&county%5B${encodedState}%5D%5B%5D=${encodedCounty}&acreage_min=40`,
      county);
  }
});
