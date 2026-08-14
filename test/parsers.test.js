'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cheerio = require('cheerio');
const BaseParser = require('../lib/parsers/base-parser');
const LandWatchParser = require('../lib/parsers/landwatch');
const LandComParser = require('../lib/parsers/landcom');
const LandAndFarmParser = require('../lib/parsers/landfarm');
const LandsOfAmericaParser = require('../lib/parsers/landsofamerica');
const LivingTheDreamParser = require('../lib/parsers/livingthedream');

const testCounties = [
  { county: 'San Augustine', state: 'TX', maxCPA: 2000 },
  { county: 'Taney', state: 'MO', maxCPA: 4000 },
];

test('LandWatch builds current /{state}-land-for-sale/{county}-county URLs', () => {
  // The pre-2026 /{state}/{county}-county/land-for-sale?minAcreage=&sort=
  // query form is 400-rejected by the site — the 2026-08-04 nightly burned
  // 244 pages on it. Page 1 is the bare county URL; deeper pages are /page-N;
  // the large-tract pass is an /acres-over-N path segment.
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls(testCounties);
  assert.equal(urls[0].url, 'https://www.landwatch.com/texas-land-for-sale/san-augustine-county');
  const page2 = urls.find(u => u.county === 'San Augustine' && u.page === 2);
  assert.equal(page2.url, 'https://www.landwatch.com/texas-land-for-sale/san-augustine-county/page-2');
  const largeTract = urls.find(u => u.county === 'San Augustine' && u.url.includes('acres-over'));
  assert.match(largeTract.url, /\/texas-land-for-sale\/san-augustine-county\/acres-over-\d+$/);
  // The dead query-param form must never come back
  assert.ok(urls.every(u => !u.url.includes('?')), 'no query params in the current scheme');
});

test('LandWatch page 1 and /page-N share one pagination series key; acres-over is its own', () => {
  const parser = new LandWatchParser();
  const base = 'https://www.landwatch.com/kentucky-land-for-sale/wayne-county';
  const k1 = parser.paginationSeriesKey(base, 'Wayne', 'KY');
  const k2 = parser.paginationSeriesKey(`${base}/page-2`, 'Wayne', 'KY');
  const k3 = parser.paginationSeriesKey(`${base}/page-3`, 'Wayne', 'KY');
  // Bare page 1 and /page-N collapse to ONE key so a failed page 1 skips the
  // deeper pages (the MossyOak ?pg= bug, path-segment edition).
  assert.equal(k1, k2);
  assert.equal(k2, k3);
  // The large-tract pass is a separate series — its failure must not be
  // conflated with the main pass.
  const kAcres = parser.paginationSeriesKey(`${base}/acres-over-150`, 'Wayne', 'KY');
  assert.notEqual(k1, kAcres);
});

test('LandWatch paginates the large-tract pass over 3 pages in the /page-N scheme', () => {
  // Page-1-only meant a county with more than one page of ≥150ac inventory
  // silently lost the rest — the pass exists precisely to catch big tracts
  // pushed off the main pages.
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls([{ county: 'Wayne', state: 'KY', maxCPA: 3000 }]);
  const largeTract = urls.filter(u => u.url.includes('acres-over-150'));
  assert.deepEqual(largeTract.map(u => u.url), [
    'https://www.landwatch.com/kentucky-land-for-sale/wayne-county/acres-over-150',
    'https://www.landwatch.com/kentucky-land-for-sale/wayne-county/acres-over-150/page-2',
    'https://www.landwatch.com/kentucky-land-for-sale/wayne-county/acres-over-150/page-3',
  ]);
  assert.deepEqual(largeTract.map(u => u.page), [1, 2, 3],
    'page numbers must be set so SCRAPER_MAX_PAGE can trim the pass');
});

test('LandWatch large-tract pages collapse to ONE pagination series', () => {
  // The composed /acres-over-N/page-M shape is not yet confirmed against real
  // HTML. Collapsing the three pages into one series is what keeps that cheap:
  // a rejected or empty page 1 (or page 2) exhausts the series and the tail is
  // never requested.
  const parser = new LandWatchParser();
  const base = 'https://www.landwatch.com/kentucky-land-for-sale/wayne-county/acres-over-150';
  const k1 = parser.paginationSeriesKey(base, 'Wayne', 'KY');
  const k2 = parser.paginationSeriesKey(`${base}/page-2`, 'Wayne', 'KY');
  const k3 = parser.paginationSeriesKey(`${base}/page-3`, 'Wayne', 'KY');
  assert.equal(k1, k2);
  assert.equal(k2, k3);
  const kCounty = parser.paginationSeriesKey('https://www.landwatch.com/kentucky-land-for-sale/wayne-county/page-2', 'Wayne', 'KY');
  assert.notEqual(k1, kCounty, 'the large-tract series stays separate from the main pass');
});

test('Land.com generates title-case state slugs', () => {
  const parser = new LandComParser();
  const urls = parser.buildSearchUrls(testCounties);
  const first = urls[0].url;
  assert.match(first, /land\.com\/Texas\/san-augustine-county/);
});

test('LandAndFarm generates lowercase state slugs', () => {
  const parser = new LandAndFarmParser();
  const urls = parser.buildSearchUrls(testCounties);
  const first = urls[0].url;
  assert.match(first, /landandfarm\.com\/search\/texas\/san-augustine-county/);
});

test('LandsOfAmerica generates lowercase state slugs', () => {
  const parser = new LandsOfAmericaParser();
  const urls = parser.buildSearchUrls(testCounties);
  const first = urls[0].url;
  assert.match(first, /landsofamerica\.com\/property\/texas\/san-augustine-county/);
});

test('LivingTheDream builds per-state /land-for-sale/{state}/ URLs, only for covered states', () => {
  const parser = new LivingTheDreamParser();
  // testCounties = San Augustine/TX + Taney/MO. TX is NOT one of the site's
  // covered states (only MO and KY are navigable), so only the MO state page is built.
  const urls = parser.buildSearchUrls(testCounties);
  assert.ok(!urls.some(u => u.state === 'TX'), 'non-covered TX produces no URL');
  const mo = urls.find(u => u.state === 'MO');
  assert.ok(mo, 'covered MO produces a state page');
  assert.equal(mo.url, 'https://www.livingthedreamland.com/land-for-sale/missouri/');
});

test('all parsers generate both pass-1 and pass-2 (large tract) URLs', () => {
  const singleCounty = [{ county: 'Taney', state: 'MO', maxCPA: 4000 }];

  // LandWatch's current scheme has no 40ac filter segment (pass 1 is the bare
  // county page; sub-40ac listings drop downstream in lib/filter.js), so its
  // pass-1 check is bare-county-URL presence rather than a "40" marker.
  for (const Parser of [LandComParser, LandAndFarmParser, LandsOfAmericaParser]) {
    const parser = new Parser();
    const urls = parser.buildSearchUrls(singleCounty);
    const hasSmall = urls.some(u => u.url.includes('40'));
    const hasLarge = urls.some(u => u.url.includes('150'));
    assert.ok(hasSmall, `${parser.name} missing pass-1 (40ac) URLs`);
    assert.ok(hasLarge, `${parser.name} missing pass-2 (150ac) URLs`);
  }
  const lw = new LandWatchParser();
  const lwUrls = lw.buildSearchUrls(singleCounty);
  assert.ok(
    lwUrls.some(u => u.url.endsWith('/missouri-land-for-sale/taney-county')),
    'LandWatch missing pass-1 (bare county page) URL'
  );
  assert.ok(
    lwUrls.some(u => u.url.includes('acres-over-150')),
    'LandWatch missing pass-2 (acres-over-150) URL'
  );
});

test('LandWatch is browser-rendered — a CoStar/Imperva client-rendered SPA', () => {
  // A plain fetch is 403'd and returns only an empty JS skeleton, so scrapeAll
  // must route this source through the real browser rather than mis-diagnosing
  // a zero-card fetch as markup drift.
  assert.equal(new LandWatchParser().requiresBrowserRender, true);
});

test('parser returns no listings on malformed cards without throwing', () => {
  const parser = new LandWatchParser();
  // A detail-link anchor with no parseable price/acres in its ancestry must be
  // dropped, not emitted.
  const badHtml = '<div><a href="/pid/12345">View</a><div>not a price</div></div>';
  const listings = parser.parseSearchPage(badHtml, 'Taney', 'MO');
  assert.deepEqual(listings, [], 'malformed card should be dropped, not emitted');
});

test('LandWatch extracts a listing from class-agnostic /pid/ card markup', () => {
  // Class-name agnostic: the engine keys off the "/pid/{digits}" detail href
  // and the price+acreage text in the card, NOT hand-picked CSS classes — so a
  // cosmetic reskin no longer zeroes the parser.
  const parser = new LandWatchParser();
  const html = `
    <html><body>
      <div class="whatever-they-reskin-to">
        <a href="/taney-county-missouri-land-for-sale/pid/12345">160 Acres in Taney County</a>
        <span>Taney County, MO</span>
        <span>160 acres</span>
        <span>$480,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Taney', 'MO');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 480000);
  assert.equal(listings[0].acres, 160);
  assert.equal(listings[0].url, 'https://www.landwatch.com/taney-county-missouri-land-for-sale/pid/12345');
  assert.equal(listings[0].county, 'Taney');
  assert.match(listings[0].name, /160 Acres in Taney County/);
});

test('LandWatch extracts a bare /pid/ detail link and takes total price over $/acre', () => {
  const parser = new LandWatchParser();
  const html = `
    <html><body>
      <div>
        <a href="/pid/98765">Rolling Pasture Tract</a>
        <span>Taney County, MO</span> <span>200 acres</span>
        <span>$3,000/acre — $600,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Taney', 'MO');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 600000, 'must take the total, not the per-acre figure');
  assert.equal(listings[0].url, 'https://www.landwatch.com/pid/98765');
});

test('LandWatch drops a nearby-county card when the page mixes inventory', () => {
  const parser = new LandWatchParser();
  const html = `
    <html><body>
      <div>
        <a href="/pid/111">Target Tract</a>
        <span>Taney County, MO</span> <span>120 acres</span> <span>$300,000</span>
      </div>
      <div>
        <a href="/pid/222">Neighbor Tract</a>
        <span>Christian County, MO</span> <span>150 acres</span> <span>$400,000</span>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Taney', 'MO');
  assert.equal(listings.length, 1);
  assert.match(listings[0].name, /Target Tract/);
});

// Real-capture regression: activates once a live LandWatch search page is
// captured from the production Mac (through the browser fallback that clears
// Imperva) and dropped in as this fixture. Until then it skips — the datacenter
// CI/cloud IP cannot fetch LandWatch, so there is nothing to assert against.
// Capture: SCRAPER_BROWSER_HEADED=true node scripts/capture-landwatch-fixture.js
test('LandWatch extracts real listings from a captured search page (when present)', (t) => {
  const fixture = path.join(__dirname, 'fixtures', 'landwatch-search.html');
  if (!fs.existsSync(fixture)) {
    t.skip('no captured LandWatch fixture — run scripts/capture-landwatch-fixture.js on the production Mac');
    return;
  }
  const parser = new LandWatchParser();
  const html = fs.readFileSync(fixture, 'utf8');
  // The capture script records the county/state it fetched in a leading
  // "<!-- landwatch-fixture county=Wayne state=KY -->" comment.
  const meta = html.match(/landwatch-fixture county=([^\s]+) state=([A-Z]{2})/);
  const county = meta ? meta[1].replace(/_/g, ' ') : 'Wayne';
  const state = meta ? meta[2] : 'KY';
  const listings = parser.parseSearchPage(html, county, state);
  assert.ok(listings.length > 0, 'captured page should yield at least one listing');
  for (const l of listings) {
    assert.match(l.url, /\/pid\/\d+/, `listing url should be a /pid/ detail link: ${l.url}`);
    assert.ok(l.price > 0, `listing should have a positive price: ${JSON.stringify(l)}`);
    assert.ok(l.acres > 0, `listing should have positive acreage: ${JSON.stringify(l)}`);
  }
});

// Captured 2026-08-05 via the evidence-capture pipeline (config/
// evidence-requests.json → nightly run on the production Mac → evidence-inbox
// branch). Confirms the /acres-over-150 path segment is real server-side
// filtering in LandWatch's 2026 URL scheme — the open question left when the
// scheme was rebuilt (the old minAcreage=150 query param had no confirmed
// equivalent). The same capture batch's unfiltered page contains 5-acre
// listings, so an all-≥150 result here is the filter working, not chance.
test('LandWatch /acres-over-150 filter segment returns only ≥150-acre listings (when captured)', (t) => {
  const fixture = path.join(__dirname, 'fixtures', 'landwatch-search-acres-over-150.html');
  if (!fs.existsSync(fixture)) {
    t.skip('no captured acres-over-150 fixture');
    return;
  }
  const parser = new LandWatchParser();
  const listings = parser.parseSearchPage(fs.readFileSync(fixture, 'utf8'), 'Wayne', 'KY');
  assert.ok(listings.length > 0, 'filtered page should still yield listings');
  for (const l of listings) {
    assert.ok(l.acres >= 150, `filter segment leaked a below-150 listing: ${l.acres}ac ${l.url}`);
  }
});

// End-to-end guard for the kill switch that cost two nightlies: LandWatch
// 400s an unsupported URL shape (Aug 6 + Aug 9), those 400s counted as
// bot-wall blocks, and the 5th one abandoned every remaining county. The real
// captured county page stands in for the pages that WERE working, so the test
// proves the run keeps producing leads through the 400s.
test('LandWatch: 400s on the large-tract pass cost only those series, never the run', async (t) => {
  const browserFetchModule = require('../lib/browser-fetch');
  const originalIsEnabled = browserFetchModule.isEnabled;
  browserFetchModule.isEnabled = () => true;
  t.after(() => { browserFetchModule.isEnabled = originalIsEnabled; });

  const countyHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'landwatch-search.html'), 'utf8');
  const counties = ['Wayne', 'Pulaski', 'Russell', 'Clinton', 'McCreary', 'Adair']
    .map(county => ({ county, state: 'KY', maxCPA: 3000 }));

  const parser = new LandWatchParser();
  parser.sleep = async () => {};
  const fetched = [];
  parser.browserFetch = async (url) => {
    fetched.push(url);
    if (url.includes('acres-over-')) {
      const err = new Error(`HTTP 400 for ${url}`);
      err.status = 400;
      throw err;
    }
    return countyHtml;
  };

  const listings = await parser.scrapeAll(counties);

  assert.equal(parser.stats.blockedPages, 0, '400s must not feed the bot-wall kill switch');
  assert.equal(parser.stats.errorPages, 0, 'nor the error-storm kill switch');
  assert.equal(parser.stats.unsupportedUrlPages, 6, 'one per county large-tract series');
  assert.ok(!parser.sourceIssues.some(issue => issue.type === 'site_abandoned'),
    'the run must not be abandoned');
  // Every county's large-tract page 1 is attempted, and each 400 exhausts its
  // series so pages 2-3 are never requested.
  assert.equal(fetched.filter(url => url.includes('acres-over-')).length, 6);
  assert.ok(!fetched.some(url => /acres-over-\d+\/page-\d/.test(url)),
    'a rejected large-tract page 1 must skip the rest of its series');
  assert.ok(listings.length > 0, 'the working county pages still produced leads');
});

test('county slugs strip punctuation so URLs do not 404', () => {
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls([
    { county: 'St. Clair', state: 'MO', maxCPA: 3000 },
    { county: "O'Brien", state: 'IA', maxCPA: 3000 },
  ]);
  assert.match(urls[0].url, /st-clair-county/);
  const stClairPath = new URL(urls[0].url).pathname;
  assert.ok(!stClairPath.includes('.'), `slug still contains a dot: ${stClairPath}`);
  const obrien = urls.find(u => u.county === "O'Brien");
  assert.match(obrien.url, /obrien-county/);
});

test('bot-challenge pages are detected, not treated as zero listings', () => {
  const parser = new LandWatchParser();
  const challenge = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
  assert.equal(parser.isBlockedPage(challenge), true);
  const incapsula = '<html><body><iframe src="/_Incapsula_Resource?x=1"></iframe></body></html>';
  assert.equal(parser.isBlockedPage(incapsula), true);
  const normal = '<html><body><div data-testid="listing-card">real content</div></body></html>';
  assert.equal(parser.isBlockedPage(normal), false);
});

test('CoStar error shells ("LandWatch / 400") count as blocked, never as markup drift', () => {
  // Real failure from the 2026-08-04 nightly: the site 400-rejects the old
  // URL form but renders a full React error shell (nav + footer, no cards),
  // which the pipeline mistook for a live page with stale selectors — 122
  // "markup drift" reports in one night. Title shape proven by the captured
  // evidence page www.landwatch.com-kentucky-wayne-county-...-8492863d.html.
  const { isBlockedHtml, isErrorShellHtml } = require('../lib/block-markers');
  const shell = '<html><head><title>LandWatch / 400</title></head><body><nav>full nav here</nav></body></html>';
  assert.equal(isBlockedHtml(shell), true, '400 shell must read as blocked');
  assert.equal(isErrorShellHtml(shell), true, 'and as a terminal error shell (no challenge polling)');
  assert.equal(isBlockedHtml('<html><head><title>Land.com / 503</title></head></html>'), true);

  // Real pages must never be flagged: search titles, and titles containing
  // slashes or numbers that are not "/ 4xx-5xx".
  const realSearch = '<html><head><title>Wayne County, KY Land for Sale, 178 Properties for Sale | LandWatch</title></head></html>';
  assert.equal(isBlockedHtml(realSearch), false);
  assert.equal(isErrorShellHtml(realSearch), false);
  const slashTitle = '<html><head><title>Tract 12 / 80 acres near Monticello</title></head></html>';
  assert.equal(isBlockedHtml(slashTitle), false);
  // A challenge page is blocked but NOT a terminal shell — polling stays on.
  const challengeAgain = '<html><head><title>Just a moment...</title></head><body></body></html>';
  assert.equal(isErrorShellHtml(challengeAgain), false);
});

test('scrapeAll records a blocked source issue instead of silent zero', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-test-'));
  const originalDataDir = process.env.SCRAPER_DATA_DIR;
  const originalDelay = process.env.SCRAPER_REQUEST_DELAY_MS;
  const originalMaxPage = process.env.SCRAPER_MAX_PAGE;
  process.env.SCRAPER_DATA_DIR = tmpDir;
  process.env.SCRAPER_REQUEST_DELAY_MS = '1';
  process.env.SCRAPER_MAX_PAGE = '1';

  // Generic scrapeAll behavior — uses a plain-fetch parser as the vehicle.
  // (LandWatch is now requiresBrowserRender, so it no longer uses fetchPage.)
  const parser = new LandAndFarmParser();
  parser.fetchPage = async () => '<html><head><title>Access Denied</title></head><body></body></html>';

  try {
    const listings = await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);
    assert.deepEqual(listings, []);
    assert.ok(parser.stats.blockedPages > 0, 'blocked pages should be counted');
    assert.ok(parser.sourceIssues.some(i => i.type === 'blocked'), 'blocked source issue should be recorded');
  } finally {
    if (originalDataDir === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = originalDataDir;
    if (originalDelay === undefined) delete process.env.SCRAPER_REQUEST_DELAY_MS;
    else process.env.SCRAPER_REQUEST_DELAY_MS = originalDelay;
    if (originalMaxPage === undefined) delete process.env.SCRAPER_MAX_PAGE;
    else process.env.SCRAPER_MAX_PAGE = originalMaxPage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('zero listings on page 1 without a no-results marker records markup drift', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-test-'));
  const originalDataDir = process.env.SCRAPER_DATA_DIR;
  const originalDelay = process.env.SCRAPER_REQUEST_DELAY_MS;
  const originalMaxPage = process.env.SCRAPER_MAX_PAGE;
  process.env.SCRAPER_DATA_DIR = tmpDir;
  process.env.SCRAPER_REQUEST_DELAY_MS = '1';
  process.env.SCRAPER_MAX_PAGE = '1';

  // Generic scrapeAll drift detection — plain-fetch vehicle (see note above).
  const parser = new LandAndFarmParser();
  // A live-looking page whose cards no longer match our selectors
  parser.fetchPage = async () => '<html><body><div class="totally-new-card-class">stuff</div></body></html>';

  try {
    await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);
    assert.ok(parser.sourceIssues.some(i => i.type === 'markup_drift'), 'markup drift issue should be recorded');
  } finally {
    if (originalDataDir === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = originalDataDir;
    if (originalDelay === undefined) delete process.env.SCRAPER_REQUEST_DELAY_MS;
    else process.env.SCRAPER_REQUEST_DELAY_MS = originalDelay;
    if (originalMaxPage === undefined) delete process.env.SCRAPER_MAX_PAGE;
    else process.env.SCRAPER_MAX_PAGE = originalMaxPage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('real cards on a state page are emitted and never mis-flagged as markup drift (LivingTheDream)', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-test-'));
  const originalDataDir = process.env.SCRAPER_DATA_DIR;
  const originalDelay = process.env.SCRAPER_REQUEST_DELAY_MS;
  const originalMaxPage = process.env.SCRAPER_MAX_PAGE;
  process.env.SCRAPER_DATA_DIR = tmpDir;
  process.env.SCRAPER_REQUEST_DELAY_MS = '1';
  process.env.SCRAPER_MAX_PAGE = '1';

  const parser = new LivingTheDreamParser();
  // A healthy state page with a real RealStack card. parseSearchPage emits
  // EVERY card (county selection is downstream in lib/filter.js now), so the
  // card is returned and, cards having matched, no markup-drift issue is raised
  // even though this listing sits in a non-target county.
  parser.fetchPage = async () => `
    <html><body>
      <div class="rs-listing-card rs-listing-item" data-lat="37.0" data-lng="-90.0">
        <div class="card-title"><a href="https://www.livingthedreamland.com/property/x-some-other-missouri/123/">80 Acres</a></div>
        <div class="location"><span>Some Other County,</span><span>MO</span></div>
        <div class="description">nice tract</div>
        <div class="info">
          <div class="info-label label--acre">80± Acres</div>
          <div class="info-label label--price">$200,000</div>
        </div>
      </div>
    </body></html>`;

  try {
    const listings = await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);
    assert.equal(listings.length, 1, 'the real card is emitted (filtering happens downstream)');
    assert.equal(listings[0].county, 'Some Other');
    assert.equal(listings[0].state, 'MO');
    assert.ok(
      !parser.sourceIssues.some(i => i.type === 'markup_drift'),
      'matched cards must not be reported as markup drift'
    );
  } finally {
    if (originalDataDir === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = originalDataDir;
    if (originalDelay === undefined) delete process.env.SCRAPER_REQUEST_DELAY_MS;
    else process.env.SCRAPER_REQUEST_DELAY_MS = originalDelay;
    if (originalMaxPage === undefined) delete process.env.SCRAPER_MAX_PAGE;
    else process.env.SCRAPER_MAX_PAGE = originalMaxPage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a genuine "no results" page does not raise a drift issue', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-test-'));
  const originalDataDir = process.env.SCRAPER_DATA_DIR;
  const originalDelay = process.env.SCRAPER_REQUEST_DELAY_MS;
  const originalMaxPage = process.env.SCRAPER_MAX_PAGE;
  process.env.SCRAPER_DATA_DIR = tmpDir;
  process.env.SCRAPER_REQUEST_DELAY_MS = '1';
  process.env.SCRAPER_MAX_PAGE = '1';

  // Generic scrapeAll no-results handling — plain-fetch vehicle (see note above).
  const parser = new LandAndFarmParser();
  parser.fetchPage = async () => '<html><body><p>No results found for your search. Try adjusting your filters.</p></body></html>';

  try {
    await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);
    assert.equal(parser.sourceIssues.length, 0, 'empty results should not record issues');
  } finally {
    if (originalDataDir === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = originalDataDir;
    if (originalDelay === undefined) delete process.env.SCRAPER_REQUEST_DELAY_MS;
    else process.env.SCRAPER_REQUEST_DELAY_MS = originalDelay;
    if (originalMaxPage === undefined) delete process.env.SCRAPER_MAX_PAGE;
    else process.env.SCRAPER_MAX_PAGE = originalMaxPage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('multi-state counties produce correct slugs for each state', () => {
  const parser = new LandWatchParser();
  const counties = [
    { county: 'Dallas', state: 'TX', maxCPA: 2000 },
    { county: 'Taney', state: 'MO', maxCPA: 4000 },
  ];
  const urls = parser.buildSearchUrls(counties);
  const txUrls = urls.filter(u => u.state === 'TX');
  const moUrls = urls.filter(u => u.state === 'MO');
  assert.ok(txUrls[0].url.includes('/texas-land-for-sale/'));
  assert.ok(moUrls[0].url.includes('/missouri-land-for-sale/'));
});

test('SCRAPER_MAX_PAGE limits validation runs to early pages', async () => {
  // Generic SCRAPER_MAX_PAGE cap — plain-fetch vehicle (see note above).
  const parser = new LandAndFarmParser();
  const originalFetchPage = parser.fetchPage;
  const originalMaxPage = process.env.SCRAPER_MAX_PAGE;
  const originalDelay = process.env.SCRAPER_REQUEST_DELAY_MS;
  const counties = [{ county: 'Taney', state: 'MO', maxCPA: 4000 }];
  const fetched = [];

  process.env.SCRAPER_MAX_PAGE = '1';
  process.env.SCRAPER_REQUEST_DELAY_MS = '1';
  parser.fetchPage = async (url) => {
    fetched.push(url);
    return '<html><body>No results found</body></html>';
  };
  parser.parseSearchPage = () => [];

  try {
    await parser.scrapeAll(counties);
    assert.equal(fetched.length, 2, 'expected pass-1 and pass-2 page 1 URLs only');
  } finally {
    parser.fetchPage = originalFetchPage;
    if (originalMaxPage === undefined) delete process.env.SCRAPER_MAX_PAGE;
    else process.env.SCRAPER_MAX_PAGE = originalMaxPage;
    if (originalDelay === undefined) delete process.env.SCRAPER_REQUEST_DELAY_MS;
    else process.env.SCRAPER_REQUEST_DELAY_MS = originalDelay;
  }
});

// --- Card-text extraction: the silent large-tract loss ---------------------
// Real captured LandWatch HTML. These lock in a fix for listings that were
// parsed as "cards" and then discarded for having no acreage, which the run
// reported as nothing wrong at all.

test('LandWatch large-tract page yields every listing the page says it has', () => {
  const LandWatchParser = require('../lib/parsers/landwatch');
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/landwatch-search-acres-over-150.html'), 'utf8');
  const parser = new LandWatchParser();
  const listings = parser.parseSearchPage(html, 'Wayne', 'KY');

  // The page's own header reads "1-6 of 6 Listings" and carries 6 detail links.
  assert.equal(parser._lastCardCount, 6);
  assert.equal(listings.length, 6, 'all 6 large tracts must survive extraction');

  // The two that used to vanish: their visible cards read "$585,000 • 259
  // acres" and "$1,137,000 • 265 acres", but the acreage was being read from
  // JSON description prose ("259.34 nrestricted acres", "264.95-acre
  // property") that matched no pattern.
  const byPrice = new Map(listings.map(l => [l.price, l]));
  assert.ok(byPrice.has(585000), 'the 259-acre $585,000 tract must be found');
  assert.ok(byPrice.has(1137000), 'the 265-acre $1,137,000 tract must be found');
  assert.equal(Math.round(byPrice.get(585000).acres), 259);
  assert.equal(Math.round(byPrice.get(1137000).acres), 265);
});

test('LandWatch county page 1 yields nearly all of its cards, not a third of them', () => {
  const LandWatchParser = require('../lib/parsers/landwatch');
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/landwatch-search.html'), 'utf8');
  const parser = new LandWatchParser();
  const listings = parser.parseSearchPage(html, 'Wayne', 'KY');

  assert.equal(parser._lastCardCount, 25);
  assert.ok(listings.length >= 22,
    `expected nearly all 25 cards to extract, got ${listings.length} (was 10 before the card-text fix)`);
});

test('card text is read from rendered content, never from an embedded JSON-LD script', () => {
  // Cheerio .text() includes <script> bodies, so a per-card JSON block was
  // being read as the card, and acreage came from description prose.
  const parser = new BaseParser('Test');
  const $ = cheerio.load(`<html><body><div class="card">
      <script type="application/ld+json">
        {"description":"a 9999 acres lake nearby","offers":{"price":123456}}
      </script>
      <a href="/listing/pid/1"><span>$585,000</span><span>&nbsp;•&nbsp;</span><span>259 acres</span></a>
    </div></body></html>`);
  const listings = parser.extractByDetailLinks($, { hrefPattern: /\/pid\/\d+/ });
  assert.equal(listings.length, 1);
  assert.equal(listings[0].acres, 259, 'the visible 259 acres wins over the script blob');
  assert.equal(listings[0].price, 585000);
});

test('adjacent elements do not run together and swallow the acreage', () => {
  // "<span>259 acres</span><p>1330 Kentucky 790...</p>" used to collapse to
  // "259 acres1330 Kentucky 790" — no word boundary after "acres", no match,
  // listing silently dropped.
  const parser = new BaseParser('Test');
  const $ = cheerio.load(`<html><body><div class="card">
      <a href="/listing/pid/2"><span>$1,137,000</span><span>265 acres</span></a>
      <p>1412 George Garner Road, Monticello, KY, 42633, Wayne County</p>
    </div></body></html>`);
  const listings = parser.extractByDetailLinks($, { hrefPattern: /\/pid\/\d+/ });
  assert.equal(listings.length, 1);
  assert.equal(listings[0].acres, 265);
});

test('extractAcres reads the hyphenated form big tracts are described with', () => {
  const parser = new BaseParser('Test');
  assert.equal(parser.extractAcres('this 1,200-acre ranch'), 1200);
  assert.equal(parser.extractAcres('a 264.95-acre property offers privacy'), 264.95);
  // Existing forms keep working.
  assert.equal(parser.extractAcres('278.19 Acres on Parmleysville Road'), 278.19);
  assert.equal(parser.extractAcres('201.15+/- acre property'), 201.15);
  assert.equal(parser.extractAcres('.499 Acres +/- lot'), 0.499);
  // A range must still take the acreage-bearing figure, not the lower bound.
  assert.equal(parser.extractAcres('10-50 acres available'), 50);
});
