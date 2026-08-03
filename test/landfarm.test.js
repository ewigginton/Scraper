'use strict';

// LandAndFarm parser, rebuilt against a REAL captured county search page.
// Everything here runs offline against test/fixtures/landfarm-wayne-county-search.html
// (Wayne County KY, 25 placards) — no land-listing domain is ever contacted.
//
// Ground truth recounted from the fixture:
//   25 `id="placard-container"` cards, 25 unique /property/ hrefs,
//   25 JSON-LD ItemList entries, 7 of them badged "Pending" -> 18 emitted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LandAndFarmParser = require('../lib/parsers/landfarm');

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'landfarm-wayne-county-search.html'),
  'utf8',
);

// The 7 cards the capture badges "Pending" — never buyable leads.
const PENDING_SLUGS = [
  'lost-hollow-lodge-38314740',
  '278-acres-parmleysville-rd-monticello-ky-40472727',
  '1-89-acres-in-wayne-county-ky-41019936',
  '5-99-acres-in-wayne-county-ky-41019940',
  '0-51-acres-in-wayne-county-ky-41019935',
  'manufactured-monticello-ky-42237834',
  'farms-monticello-ky-41976167',
];

function parseFixture() {
  const parser = new LandAndFarmParser();
  const listings = parser.parseSearchPage(FIXTURE, 'Wayne', 'KY');
  return { parser, listings };
}

// A genuinely empty results page — served for the acreage-band URLs so each
// scrapeOnePage run exercises exactly ONE copy of the page under test.
const EMPTY_RESULTS_HTML = '<html><body><p>No results found for your search.</p></body></html>';

/**
 * Run scrapeAll offline with evidence in a temp dir: `html` is served for page
 * 1 of the county series, an empty-results page for the five acreage bands.
 */
async function scrapeOnePage(html) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-landfarm-'));
  const saved = {
    SCRAPER_DATA_DIR: process.env.SCRAPER_DATA_DIR,
    SCRAPER_REQUEST_DELAY_MS: process.env.SCRAPER_REQUEST_DELAY_MS,
    SCRAPER_MAX_PAGE: process.env.SCRAPER_MAX_PAGE,
  };
  process.env.SCRAPER_DATA_DIR = tmpDir;
  process.env.SCRAPER_REQUEST_DELAY_MS = '1';
  process.env.SCRAPER_MAX_PAGE = '1';

  const parser = new LandAndFarmParser();
  const fetched = [];
  parser.fetchPage = async (url) => {
    fetched.push(url);
    // Page 1 is the bare canonical county URL (no /page-N segment at all).
    return url.endsWith('-county-land-for-sale/') ? html : EMPTY_RESULTS_HTML;
  };

  try {
    const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY', maxCPA: 3000 }]);
    return { parser, listings, fetched };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- 1. Search URLs ------------------------------------------------------

test('buildSearchUrls uses the real path shape, three county pages plus five acreage bands', () => {
  const urls = new LandAndFarmParser().buildSearchUrls([{ county: 'Wayne', state: 'KY' }]);

  assert.deepEqual(urls.map(u => u.url), [
    // Path shape verified from the capture's own rel=canonical / rel=next:
    // page 1 is the bare canonical URL, pages 2-3 carry /page-N/ WITH a
    // trailing slash — the capture never links a slashless /page-N anywhere.
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/page-2/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/page-3/',
    // The five extras: the site's own acreage-facet links, all wholly above the
    // 40-acre floor, so large tracts past page 3 of a 151-listing county are
    // still reachable.
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-51-100/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-101-200/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-201-500/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-501-1000/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-over-1000/',
  ]);
  // The invented query string the old parser used appears nowhere in real markup.
  assert.ok(!urls.some(u => /minAcres|sort=newest|[?&]page=/.test(u.url)),
    'no invented query parameters');
  for (const entry of urls) {
    assert.equal(entry.county, 'Wayne');
    assert.equal(entry.state, 'KY');
    assert.ok(entry.page >= 1, 'every URL carries a page number so SCRAPER_MAX_PAGE can cap the sweep');
  }
});

test('every generated county series URL is one the capture itself links to', () => {
  // Pinned to the EXACT 8 URLs generated for Wayne County, so this cannot pass
  // vacuously (a startsWith check would still pass a wrong page-1 shape). The
  // capture's own rel=canonical (page 1, bare, trailing slash), rel=next
  // (page 2, /page-2/) and in-page pagination (page 3, /page-3/) prove the
  // series shape; the acreage-band hrefs prove the other five.
  const urls = new LandAndFarmParser()
    .buildSearchUrls([{ county: 'Wayne', state: 'KY' }])
    .map(u => u.url);

  assert.deepEqual(urls, [
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/page-2/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/page-3/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-51-100/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-101-200/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-201-500/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-501-1000/',
    'https://www.landandfarm.com/search/kentucky/wayne-county-land-for-sale/acres-over-1000/',
  ]);

  assert.match(FIXTURE, /rel="canonical" href="https:\/\/www\.landandfarm\.com\/search\/kentucky\/wayne-county-land-for-sale\/"/,
    'page 1 must be the capture\'s own canonical URL');
  assert.match(FIXTURE, /rel="next" href="https:\/\/www\.landandfarm\.com\/search\/kentucky\/wayne-county-land-for-sale\/page-2\/"/,
    'page 2 must be the capture\'s own rel=next URL');
  assert.ok(FIXTURE.includes('/search/kentucky/wayne-county-land-for-sale/page-3/'),
    'page 3 must be a URL the capture itself links (in-page pagination)');
  for (const segment of ['acres-51-100', 'acres-101-200', 'acres-201-500', 'acres-501-1000', 'acres-over-1000']) {
    assert.ok(FIXTURE.includes(`/search/kentucky/wayne-county-land-for-sale/${segment}/`),
      `the capture must link the ${segment} facet`);
  }

  // Sibling counties confirm the same shape applies generically, not just to
  // the one county under test.
  const siblingUrls = new LandAndFarmParser()
    .buildSearchUrls([{ county: 'Clinton', state: 'KY' }, { county: 'Pulaski', state: 'KY' }])
    .map(u => u.url);
  for (const county of ['clinton', 'pulaski']) {
    assert.ok(FIXTURE.includes(`/search/kentucky/${county}-county-land-for-sale/`),
      `the capture must link the ${county} county series`);
    assert.ok(siblingUrls.includes(`https://www.landandfarm.com/search/kentucky/${county}-county-land-for-sale/`),
      `page 1 for ${county} must be the exact bare canonical shape`);
  }
});

test('county and state slugs match the site (Le Flore, DeKalb, St. Clair)', () => {
  const urls = new LandAndFarmParser().buildSearchUrls([
    { county: 'Le Flore', state: 'OK' },
    { county: 'DeKalb', state: 'AL' },
    { county: 'St. Clair', state: 'MO' },
  ]);
  const first = county => urls.find(u => u.county === county).url;

  assert.equal(first('Le Flore'), 'https://www.landandfarm.com/search/oklahoma/le-flore-county-land-for-sale/');
  assert.equal(first('DeKalb'), 'https://www.landandfarm.com/search/alabama/dekalb-county-land-for-sale/');
  assert.equal(first('St. Clair'), 'https://www.landandfarm.com/search/missouri/st-clair-county-land-for-sale/');
  for (const entry of urls) {
    assert.ok(!new URL(entry.url).pathname.includes('.'), `slug still carries a dot: ${entry.url}`);
  }
});

test('results are NOT newest-first, so incremental early-stop stays off', () => {
  // Cards render in paid-placement order (diamond, signature, standard, free)
  // and there is no crawlable sort parameter — a truncated series would hide
  // new listings sitting on page 2.
  assert.equal(new LandAndFarmParser().resultsSortedNewestFirst, false);
  const tiers = [...FIXTURE.matchAll(/data-qa-placard-type="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(tiers.slice(0, 2), ['diamond', 'signature'],
    'paid tiers lead the page — evidence the order is placement, not recency');
});

// --- 2. Extraction against the real capture -------------------------------

test('the capture yields 25 counted cards and 18 emitted listings', () => {
  const { parser, listings } = parseFixture();
  assert.equal(parser._lastCardCount, 25, 'all 25 JSON-LD listings count as cards');
  assert.equal(listings.length, 18, '25 cards minus the 7 Pending badges');
});

test('the 7 Pending cards are counted but never emitted', () => {
  const { listings } = parseFixture();
  for (const slug of PENDING_SLUGS) {
    assert.ok(FIXTURE.includes(`/property/${slug}/`), `${slug} must be present in the capture`);
    assert.ok(!listings.some(l => l.url.includes(slug)), `${slug} is Pending and must not be emitted`);
  }
  assert.equal(PENDING_SLUGS.length, 7);
});

test('a Pending badge merged with the VIDEO/MAP media chips (sibling-concat hazard) is still excluded', () => {
  // Regression for the sibling-concat leak: cheerio .text() on
  // id="placard-image" concatenates sibling elements with no separator, so a
  // Pending badge next to the VIDEO/MAP media chips used to read as
  // "PendingVIDEOMAP" — a letter-to-letter junction UNAVAILABLE_STATUS_RE's \b
  // boundaries cannot match — which let a Pending listing through as a
  // buyable New Lead. Real markup graft, not invented: the diamond card's own
  // media-chip container, copied verbatim out of the fixture.
  const mediaChipsMatch = /<div class="sOqLAV0aC s1RQDFRGp">.*?<\/div><\/div>/.exec(FIXTURE);
  assert.ok(mediaChipsMatch, 'the fixture must contain a VIDEO/MAP media-chip container to copy');
  const mediaChips = mediaChipsMatch[0];
  assert.match(mediaChips, /aria-label="VIDEO"/);
  assert.match(mediaChips, /aria-label="MAP"/);

  const pendingBadgeMatch = /<div class="sOqLAV0aC sq9tgB8Yz">.*?Pending<\/span><\/div>/.exec(FIXTURE);
  assert.ok(pendingBadgeMatch, 'the fixture must contain a Pending badge to graft against');
  const pendingBadge = pendingBadgeMatch[0];

  const { listings: pristine } = parseFixture();

  // Append order: "...Pending</div>" + chips -> old .text() read
  // "PendingVIDEOMAP" (no boundary between "Pending" and "VIDEO").
  const appended = FIXTURE.replace(pendingBadge, pendingBadge + mediaChips);
  assert.notEqual(appended, FIXTURE, 'the graft must actually modify the fixture');
  const appendedListings = new LandAndFarmParser().parseSearchPage(appended, 'Wayne', 'KY');
  assert.equal(appendedListings.length, 18, 'append-order graft must not change the emitted count');
  assert.deepEqual(appendedListings, pristine, 'append-order graft must not change any emitted row');

  // Prepend order: chips + "...Pending</div>" -> "VIDEOMAPPending" is a
  // different junction, same hazard class.
  const prepended = FIXTURE.replace(pendingBadge, mediaChips + pendingBadge);
  assert.notEqual(prepended, FIXTURE, 'the graft must actually modify the fixture');
  const prependedListings = new LandAndFarmParser().parseSearchPage(prepended, 'Wayne', 'KY');
  assert.equal(prependedListings.length, 18, 'prepend-order graft must not change the emitted count');
  assert.deepEqual(prependedListings, pristine, 'prepend-order graft must not change any emitted row');

  for (const slug of PENDING_SLUGS) {
    assert.ok(!appendedListings.some(l => l.url.includes(slug)), `${slug} must stay excluded (append order)`);
    assert.ok(!prependedListings.some(l => l.url.includes(slug)), `${slug} must stay excluded (prepend order)`);
  }
});

test('verified sample listings come out field-for-field correct', () => {
  const { listings } = parseFixture();
  const bySlug = slug => listings.find(l => l.url.includes(slug));

  const buckRun = bySlug('8-11-acres-in-wayne-county-ky-41274425');
  assert.equal(buckRun.price, 32000);
  assert.equal(buckRun.acres, 8.11);
  assert.equal(buckRun.county, 'Wayne');
  assert.equal(buckRun.state, 'KY');
  assert.equal(buckRun.name, '8.11 acres, 22 Buck Run Ridge Road, Monticello, KY 42633');
  assert.equal(buckRun.url, 'https://www.landandfarm.com/property/8-11-acres-in-wayne-county-ky-41274425/');

  // The blurb says "201.15+/- acre"; the LISTING value is 201 and that is what
  // the anchored name prefix gives us.
  const timber = bySlug('201-acre-timber-tract-in-wayne-county-39872178');
  assert.equal(timber.price, 311550);
  assert.equal(timber.acres, 201);
  assert.equal(timber.name, '201 acres, Parmleysville Road, Lot#WP001, Monticello, KY 42633');

  // Diamond tier — a paid placement is still a real listing and is emitted.
  const diamond = bySlug('olde-tennessee-trail-140-41217070');
  assert.equal(diamond.price, 3870000, 'comma-free JSON price, not a text scrape');
  assert.equal(diamond.acres, 342);
  assert.equal(diamond.name, '342 acres, 21 Clubhouse Drive, Monticello, KY 42633');

  const singleFamily = bySlug('single-family-monticello-ky-40705556');
  assert.equal(singleFamily.price, 130000);
  assert.equal(singleFamily.acres, 1.1);
});

test('acreage comes from the anchored name prefix, so street numbers cannot win', () => {
  const { listings } = parseFixture();

  // Address is literally "5 acres Bridleway Road" — an unanchored regex could
  // read the street text, and a card-text scrape read the description prose.
  const bridleway = listings.find(l => l.url.includes('5-acres-in-wayne-county-ky-40090701'));
  assert.equal(bridleway.acres, 5);
  assert.equal(bridleway.price, 50000);

  // Sub-acre decimal and the singular "1 acre" spelling.
  assert.equal(listings.find(l => l.url.includes('0-29-acres')).acres, 0.29);
  assert.equal(listings.find(l => l.url.includes('0-29-acres')).price, 79900);
  const oneAcre = listings.find(l => l.url.includes('1-acre-in-wayne-county-ky-41019939'));
  assert.equal(oneAcre.acres, 1);
  assert.equal(oneAcre.name, '1 acre, 39 Shepperd Road, Nancy, KY 42544');

  for (const listing of listings) {
    assert.ok(listing.acres > 0 && Number.isFinite(listing.acres), `bad acreage on ${listing.url}`);
    assert.ok(listing.price > 0 && Number.isFinite(listing.price), `bad price on ${listing.url}`);
  }
});

test('county comes from the placard address line, state from the JSON-LD region', () => {
  const { listings } = parseFixture();
  // The JSON-LD has no county at all (street/locality/region/postal only), so
  // every county here was read off a placard.
  for (const listing of listings) {
    assert.equal(listing.county, 'Wayne');
    assert.equal(listing.state, 'KY');
  }
  // Proven independent of the searched county: a different search county does
  // not overwrite what the placards say.
  const parser = new LandAndFarmParser();
  const listed = parser.parseSearchPage(FIXTURE, 'Pulaski', 'KY');
  assert.ok(listed.every(l => l.county === 'Wayne'), 'placard county wins over the searched county');
});

test('urls are absolute, unique, query-free /property/ links', () => {
  const { listings } = parseFixture();
  const seen = new Set();
  for (const listing of listings) {
    assert.match(listing.url, /^https:\/\/www\.landandfarm\.com\/property\/[^?#]+$/);
    assert.ok(!seen.has(listing.url), `duplicate url ${listing.url}`);
    seen.add(listing.url);
  }
  assert.equal(seen.size, 18);
});

// --- 3. Drift: both structural layers must fail LOUD -----------------------

test('losing the JSON-LD ItemList reports markup drift, not an empty county', async () => {
  const withoutItemList = FIXTURE.replace(/"@type":"CollectionPage"/, '"@type":"WebPage"');
  assert.notEqual(withoutItemList, FIXTURE, 'the fixture must actually be modified');

  const direct = new LandAndFarmParser();
  assert.deepEqual(direct.parseSearchPage(withoutItemList, 'Wayne', 'KY'), []);
  assert.equal(direct._lastCardCount, 0, 'zero cards is the signal base-parser watches');

  const { parser, listings } = await scrapeOnePage(withoutItemList);
  assert.equal(listings.length, 0);
  assert.ok(parser.sourceIssues.some(i => i.type === 'markup_drift'),
    'a page that fetched fine but lost its ItemList must raise markup_drift');
});

test('renaming the placard ids raises drift and leaks NO Pending listings', async () => {
  // The failure this guards against: with the placard layer gone, county and
  // sale status are unknowable. Emitting the JSON-LD anyway would push all 25
  // rows through — including the 7 Pending ones — as buyable New Leads, while
  // _lastCardCount stayed 25 so base-parser's drift branch never fired.
  const renamed = FIXTURE
    .replace(/id="placard-container"/g, 'id="listing-container"')
    .replace(/id="placard-image"/g, 'id="listing-image"');
  assert.ok(!renamed.includes('id="placard-container"'), 'both ids must actually be renamed');

  const direct = new LandAndFarmParser();
  assert.deepEqual(direct.parseSearchPage(renamed, 'Wayne', 'KY'), [], 'no unvetted rows are emitted');
  assert.equal(direct._lastCardCount, 0, 'the count drops to 0, which is what base-parser watches');

  const { parser, listings } = await scrapeOnePage(renamed);

  assert.equal(listings.length, 0, 'no unvetted rows reach the pipeline');
  assert.ok(parser.sourceIssues.some(i => i.type === 'markup_drift'),
    'placard-anchor loss must surface through the real drift mechanism');
  for (const slug of PENDING_SLUGS) {
    assert.ok(!listings.some(l => l.url.includes(slug)), `${slug} must not leak in`);
  }
});

test('one missing placard does not nuke a healthy page', async () => {
  // Partial loss is normal (a lazily rendered tile, one malformed card) and
  // must NOT be escalated to drift: the threshold tolerates up to 20% loss.
  const first = FIXTURE.indexOf('id="placard-container"');
  const oneRenamed = `${FIXTURE.slice(0, first)}id="listing-container"${FIXTURE.slice(first + 'id="placard-container"'.length)}`;

  const direct = new LandAndFarmParser();
  const parsed = direct.parseSearchPage(oneRenamed, 'Wayne', 'KY');
  assert.equal(direct._lastCardCount, 25, 'all JSON-LD listings still count as cards');
  assert.equal(parsed.length, 17, 'the placard-less card is skipped, the other 17 are emitted');

  const { parser, listings } = await scrapeOnePage(oneRenamed);

  assert.equal(listings.length, 17);
  assert.ok(!parser.sourceIssues.some(i => i.type === 'markup_drift'),
    'a single missing placard is not markup drift');
  assert.ok(!listings.some(l => l.url.includes('olde-tennessee-trail-140-41217070')),
    'a card with no placard has unknown status, so it is skipped rather than guessed');
});

test('a healthy page raises no source issues and is fetched once per URL', async () => {
  const { parser, listings, fetched } = await scrapeOnePage(FIXTURE);
  assert.equal(listings.length, 18);
  assert.deepEqual(parser.sourceIssues, [], 'a good page must produce no warnings');
  // SCRAPER_MAX_PAGE=1 keeps page 1 of the county series plus the five bands
  // (which serve an empty-results page here — a real empty band is not drift).
  assert.equal(fetched.length, 6);
  assert.ok(listings.every(l => l.source === 'LandAndFarm'));
});

test('garbage HTML yields no listings and never throws', () => {
  const parser = new LandAndFarmParser();
  for (const html of [
    '',
    '<html><body><div class="totally-new-card-class">stuff</div></body></html>',
    '<html><script type="application/ld+json">{not json</script></html>',
    '<html><script type="application/ld+json">{"@type":"CollectionPage","mainEntity":{"itemListElement":"nope"}}</script></html>',
  ]) {
    assert.deepEqual(parser.parseSearchPage(html, 'Wayne', 'KY'), []);
    assert.equal(parser._lastCardCount, 0, 'zero cards is what raises drift upstream');
  }
});
