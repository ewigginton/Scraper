'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LandWatchParser = require('../lib/parsers/landwatch');
const LandComParser = require('../lib/parsers/landcom');
const LandAndFarmParser = require('../lib/parsers/landfarm');
const LandsOfAmericaParser = require('../lib/parsers/landsofamerica');
const LivingTheDreamParser = require('../lib/parsers/livingthedream');

const testCounties = [
  { county: 'San Augustine', state: 'TX', maxCPA: 2000 },
  { county: 'Taney', state: 'MO', maxCPA: 4000 },
];

test('LandWatch builds current /{state}-land-for-sale/{county}-county/acres-over-N URLs', () => {
  // The pre-2026 /{state}/{county}-county/land-for-sale?minAcreage=&sort=
  // query form is 400-rejected by the site — the 2026-08-04 nightly burned
  // 244 pages on it. Filters are path segments: page 1 is the county page
  // filtered to the acreage floor; deeper pages append /page-N.
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls(testCounties);
  assert.equal(urls[0].url, 'https://www.landwatch.com/texas-land-for-sale/san-augustine-county/acres-over-40');
  const page2 = urls.find(u => u.county === 'San Augustine' && u.page === 2);
  assert.equal(page2.url, 'https://www.landwatch.com/texas-land-for-sale/san-augustine-county/acres-over-40/page-2');
  // The dead query-param form must never come back
  assert.ok(urls.every(u => !u.url.includes('?')), 'no query params in the current scheme');
});

test('LandWatch page 1 and /page-N of the county series share one pagination series key', () => {
  const parser = new LandWatchParser();
  const base = 'https://www.landwatch.com/kentucky-land-for-sale/wayne-county/acres-over-40';
  const k1 = parser.paginationSeriesKey(base, 'Wayne', 'KY');
  const k2 = parser.paginationSeriesKey(`${base}/page-2`, 'Wayne', 'KY');
  const k10 = parser.paginationSeriesKey(`${base}/page-10`, 'Wayne', 'KY');
  // Bare page 1 and /page-N collapse to ONE key so a failed page 1 skips the
  // deeper pages (the MossyOak ?pg= bug, path-segment edition).
  assert.equal(k1, k2);
  assert.equal(k2, k10);
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
  // LandWatch reads ONE series per county — the county filtered to the
  // acreage floor — so neither the unfiltered county page nor a separate
  // large-tract pass is requested any more (both were subsets or supersets
  // of the same listings, at extra request cost).
  const lw = new LandWatchParser();
  const lwUrls = lw.buildSearchUrls(singleCounty);
  assert.ok(
    lwUrls.every(u => u.url.startsWith('https://www.landwatch.com/missouri-land-for-sale/taney-county/acres-over-40')),
    lwUrls.map(u => u.url).join('\n')
  );
  assert.ok(!lwUrls.some(u => u.url.endsWith('/taney-county')), 'no unfiltered county page');
  assert.ok(!lwUrls.some(u => u.url.includes('acres-over-150')), 'no separate large-tract pass');
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

// ---------- LandWatch county series (/acres-over-40/page-N) ----------
//
// Live evidence 2026-10-05: Pittsburg County, OK's unfiltered county page
// totals 365 listings (15 pages, mostly under 40 acres; the old code read 3),
// while /acres-over-40 totals 61 — 25 + 25 + 11 cards over three pages, none
// under 40 acres. The page's __SERVER_STATE__ carries that total, so the
// series stops after page 3 without requesting an empty page 4. Fixtures are
// the real pages.

const PITTSBURG_AO40 = 'https://www.landwatch.com/oklahoma-land-for-sale/pittsburg-county/acres-over-40';

function loadPittsburgOver40Page(n) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', `landwatch-search-acres-over-40-pittsburg-page-${n}.html`), 'utf8');
}

function loadLandWatchFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

/** The page with its stated total (state blob AND meta description) removed — the "total unreadable" case. */
function withoutTotal(html) {
  const stripped = html
    .replace(/"totalCount":\d+/g, '"totalCountRemoved":0')
    .replace(/LandWatch has [\d,]+ land listings/g, 'LandWatch has many land listings');
  assert.notEqual(stripped, html, 'fixture had a total to remove');
  return stripped;
}

test('LandWatch builds ONE county series: /acres-over-{minAcres} then /page-2..10, every page sized 25', () => {
  const settings = require('../config/settings.json');
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  const base = `https://www.landwatch.com/oklahoma-land-for-sale/pittsburg-county/acres-over-${settings.filtering.minAcres}`;
  assert.equal(base, PITTSBURG_AO40, 'the floor in settings.json is 40');
  const expected = [[base, 1]];
  for (let page = 2; page <= LandWatchParser.MAX_PAGES_PER_COUNTY; page++) expected.push([`${base}/page-${page}`, page]);
  assert.deepEqual(urls.map(u => [u.url, u.page]), expected);
  assert.equal(LandWatchParser.MAX_PAGES_PER_COUNTY, 10);
  assert.ok(urls.every(u => u.county === 'Pittsburg' && u.state === 'OK'));
  assert.ok(urls.every(u => u.pageSize === LandWatchParser.RESULTS_PER_PAGE && u.pageSize === 25));
  // Only the capped last page carries the coverage check
  assert.deepEqual(urls.filter(u => u.warnIfFullAtCards).map(u => u.page), [10]);
  // One series key for the whole county
  assert.equal(new Set(urls.map(u => parser.paginationSeriesKey(u.url, u.county, u.state))).size, 1);
});

test('LandWatch reads the search total from __SERVER_STATE__ (searchPage.searchResults.totalCount)', () => {
  const parser = new LandWatchParser();
  assert.equal(parser.searchTotalCount(loadPittsburgOver40Page(1)), 61);
  assert.equal(parser.searchTotalCount(loadPittsburgOver40Page(3)), 61);
  assert.equal(parser.searchTotalCount(loadLandWatchFixture('landwatch-search-acres-over-40-wayne-single-page.html')), 21);
  assert.equal(parser.searchTotalCount(loadLandWatchFixture('landwatch-search-empty-robertson-acres-over-1000.html')), 0);
  assert.equal(parser.searchTotalCount(withoutTotal(loadPittsburgOver40Page(1))), null);
  // Meta description alone (the state blob's total removed) still gives it
  assert.equal(parser.searchTotalCount(loadPittsburgOver40Page(1).replace(/"totalCount":\d+/, '"x":0')), 61);
  assert.equal(parser.searchTotalCount('<html><body>no state blob</body></html>'), null);
  assert.equal(parser.searchTotalCount('<script id="__SERVER_STATE__" type="application/json">{not json</script>'), null);
  // parseSearchPage leaves it for scrapeAll
  parser.parseSearchPage(loadPittsburgOver40Page(2), 'Pittsburg', 'OK');
  assert.equal(parser._lastTotalCount, 61);
});

test('LandWatch browser-rendered page (what production reads): empty state blob, total read from the meta description', () => {
  // Real Chrome render via lib/browser-fetch.js, 2026-10-05. Client
  // rendering empties <script id="__SERVER_STATE__">, so without the meta
  // fallback every county would cost one extra request past its last page.
  const html = loadLandWatchFixture('landwatch-search-acres-over-40-pittsburg-page-1-browser-render.html');
  assert.match(html, /<script id="__SERVER_STATE__" type="application\/json"><\/script>/);
  const parser = new LandWatchParser();
  assert.equal(parser.searchTotalCount(html), 61);
  const listings = parser.parseSearchPage(html, 'Pittsburg', 'OK');
  assert.equal(listings.length, 25);
  assert.equal(parser._lastTotalCount, 61);
  assert.ok(listings.every(l => l.acres >= 40));
});

test('LandWatch Pittsburg acres-over-40 fixtures: pages 1-3 yield all 61 listings, every one 40+ acres', () => {
  const parser = new LandWatchParser();
  const p1 = parser.parseSearchPage(loadPittsburgOver40Page(1), 'Pittsburg', 'OK');
  const p2 = parser.parseSearchPage(loadPittsburgOver40Page(2), 'Pittsburg', 'OK');
  const p3 = parser.parseSearchPage(loadPittsburgOver40Page(3), 'Pittsburg', 'OK');
  assert.deepEqual([p1.length, p2.length, p3.length], [25, 25, 11]);
  const all = [...p1, ...p2, ...p3];
  assert.equal(new Set(all.map(l => l.url)).size, 61, 'no listing repeats across pages');
  for (const l of all) {
    assert.ok(l.acres >= 40, `filter leaked a ${l.acres}ac listing: ${l.url}`);
    assert.ok(l.price > 0, `no price: ${l.url}`);
  }
  // The 560-acre tract the old large-tract pass only found on ITS page-2
  assert.ok(all.some(l => l.url.includes('/pid/425937328') && l.acres === 560 && l.price === 2380000));
});

function makeLandWatchScrapeHarness(t, pages) {
  // Serve fixture HTML by URL through the browser path LandWatch uses
  // (requiresBrowserRender), with no real network, no sleeping, and no
  // source-health files written.
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

  const parser = new LandWatchParser();
  const fetched = [];
  parser.sleep = async () => {};
  parser.recordSourceIssue = (issue) => { parser.sourceIssues.push({ source: parser.name, ...issue }); return null; };
  parser.browserFetch = async (url) => {
    fetched.push(url);
    if (!(url in pages)) throw new Error(`unexpected fetch ${url}`);
    return pages[url];
  };
  return { parser, fetched };
}

test('scrapeAll stops the county series at the last page its total implies (61 results = 3 pages)', async (t) => {
  const { parser, fetched } = makeLandWatchScrapeHarness(t, {
    [PITTSBURG_AO40]: loadPittsburgOver40Page(1),
    [`${PITTSBURG_AO40}/page-2`]: loadPittsburgOver40Page(2),
    [`${PITTSBURG_AO40}/page-3`]: loadPittsburgOver40Page(3),
  });
  const listings = await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.deepEqual(fetched, [PITTSBURG_AO40, `${PITTSBURG_AO40}/page-2`, `${PITTSBURG_AO40}/page-3`],
    'page 4 is never requested: 3 x 25 >= 61');
  assert.equal(listings.length, 61);
  assert.deepEqual(parser.sourceIssues, []);
  assert.equal(parser.stats.driftPages, 0);
  assert.equal(parser.stats.checked, 3);
});

test('scrapeAll reads a single-page county with ONE request (Wayne KY: 21 results)', async (t) => {
  const wayne = 'https://www.landwatch.com/kentucky-land-for-sale/wayne-county/acres-over-40';
  const { parser, fetched } = makeLandWatchScrapeHarness(t, {
    [wayne]: loadLandWatchFixture('landwatch-search-acres-over-40-wayne-single-page.html'),
  });
  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY', maxCPA: 2500 }]);
  assert.deepEqual(fetched, [wayne]);
  assert.equal(listings.length, 21);
  assert.deepEqual(parser.sourceIssues, []);
});

test('a county with no 40+ acre listings (explicit total 0) is genuinely empty, not markup drift', async (t) => {
  // Real empty render (live 2026-10-05, robertson-county/acres-over-1000):
  // "No Listings" header, totalCount 0, padded with 16 other-county
  // "similar properties" cards that verifyCounty rejects.
  const robertson = 'https://www.landwatch.com/kentucky-land-for-sale/robertson-county/acres-over-40';
  const emptyPage = loadLandWatchFixture('landwatch-search-empty-robertson-acres-over-1000.html');
  const parser0 = new LandWatchParser();
  assert.deepEqual(parser0.parseSearchPage(emptyPage, 'Robertson', 'KY'), []);
  assert.equal(parser0.looksLikeEmptyResults(emptyPage), true);

  const { parser, fetched } = makeLandWatchScrapeHarness(t, { [robertson]: emptyPage });
  const listings = await parser.scrapeAll([{ county: 'Robertson', state: 'KY', maxCPA: 2500 }]);
  assert.deepEqual(fetched, [robertson], 'no page 2 for an empty county');
  assert.equal(listings.length, 0);
  assert.deepEqual(parser.sourceIssues, []);
  assert.equal(parser.stats.driftPages, 0);

  // Same, with no padding cards at all: zero cards on page 1 would be the
  // drift signature, but the explicit zero total says the county is empty.
  const bareEmpty = '<html><body><main><h1>No Listings</h1></main>' +
    '<script id="__SERVER_STATE__" type="application/json">{"searchPage":{"searchResults":{"propertyResults":[],"similarProperties":[],"totalCount":0}}}</script></body></html>';
  const second = makeLandWatchScrapeHarness(t, { [robertson]: bareEmpty });
  await second.parser.scrapeAll([{ county: 'Robertson', state: 'KY', maxCPA: 2500 }]);
  assert.deepEqual(second.fetched, [robertson]);
  assert.equal(second.parser.stats.driftPages, 0);
  assert.deepEqual(second.parser.sourceIssues, []);
});

test('without a readable total, the series stops at the first short page', async (t) => {
  const { parser, fetched } = makeLandWatchScrapeHarness(t, {
    [PITTSBURG_AO40]: withoutTotal(loadPittsburgOver40Page(1)),
    [`${PITTSBURG_AO40}/page-2`]: withoutTotal(loadPittsburgOver40Page(2)),
    [`${PITTSBURG_AO40}/page-3`]: withoutTotal(loadPittsburgOver40Page(3)), // 11 cards
  });
  const listings = await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(fetched.length, 3, 'page 3 has 11 < 25 cards, so page 4 is not requested');
  assert.equal(listings.length, 61);
  assert.deepEqual(parser.sourceIssues, []);
});

test('without a readable total, a zero-card page-2 ends the series silently; only page 1 can raise drift', async (t) => {
  // A rendered page with no cards and no empty-results phrase — the drift
  // signature on page 1, but on page 2+ just the end of the results.
  const bare = '<html><head><title>Pittsburg County, OK Land for Sale | LandWatch</title></head><body><main><h1>Land for sale</h1></main></body></html>';
  const { parser, fetched } = makeLandWatchScrapeHarness(t, {
    [PITTSBURG_AO40]: withoutTotal(loadPittsburgOver40Page(1)),
    [`${PITTSBURG_AO40}/page-2`]: bare,
  });
  const listings = await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.equal(listings.length, 25);
  assert.equal(fetched.length, 2, 'series ends at the empty page-2');
  assert.equal(parser.stats.driftPages, 0);
  assert.ok(!parser.sourceIssues.some(i => i.type === 'markup_drift'));

  // The same bare page as PAGE 1 is still reported as drift.
  const second = makeLandWatchScrapeHarness(t, { [PITTSBURG_AO40]: bare });
  await second.parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.deepEqual(second.fetched, [PITTSBURG_AO40], 'drifted page 1 ends the series too');
  assert.equal(second.parser.stats.driftPages, 1);
  assert.ok(second.parser.sourceIssues.some(i => i.type === 'markup_drift' && i.url === PITTSBURG_AO40));
});

test('a failed page 1 skips the county\'s deeper pages', async (t) => {
  const { parser, fetched } = makeLandWatchScrapeHarness(t, {});
  parser.browserFetch = async (url) => {
    fetched.push(url);
    throw new Error(`navigation timeout for ${url}`);
  };
  await parser.scrapeAll([{ county: 'Pittsburg', state: 'OK', maxCPA: 2500 }]);
  assert.deepEqual(fetched, [PITTSBURG_AO40]);
  assert.equal(parser.stats.errorPages, 1);
});

// The acres-over-150 captures below are kept as parser evidence (real
// LandWatch markup, server-side acreage filtering); the scraper no longer
// requests that series.
const PITTSBURG_AO150 = 'https://www.landwatch.com/oklahoma-land-for-sale/pittsburg-county/acres-over-150';

function loadPittsburgPage(n) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', `landwatch-search-acres-over-150-pittsburg-page-${n}.html`), 'utf8');
}

test('LandWatch Pittsburg acres-over-150 fixtures: page 1 + page-2 yield all 28 large tracts, page-3 is empty', () => {
  const parser = new LandWatchParser();
  const p1 = parser.parseSearchPage(loadPittsburgPage(1), 'Pittsburg', 'OK');
  const p2 = parser.parseSearchPage(loadPittsburgPage(2), 'Pittsburg', 'OK');
  const p3 = parser.parseSearchPage(loadPittsburgPage(3), 'Pittsburg', 'OK');
  assert.equal(p1.length, 25);
  assert.equal(p2.length, 3);
  assert.equal(p3.length, 0);
  assert.equal(parser._lastCardCount, 0, 'page-3 has no cards at all');
  // Page title: "... 28 Properties for Sale | LandWatch"
  assert.match(loadPittsburgPage(1), /28 Properties for Sale/);
  const all = [...p1, ...p2];
  assert.equal(new Set(all.map(l => l.url)).size, 28, 'no listing repeats across pages');
  for (const l of all) {
    assert.ok(l.acres >= 150, `filter leaked a ${l.acres}ac listing: ${l.url}`);
    assert.ok(l.price > 0 && l.price / l.acres < 50000, `implausible $${l.price} / ${l.acres}ac: ${l.url}`);
  }
  // The 560-acre tract that only appears on page-2
  const tract560 = p2.find(l => l.url.includes('/pid/425937328'));
  assert.ok(tract560, 'page-2 carries pid 425937328');
  assert.equal(tract560.acres, 560);
  assert.equal(tract560.price, 2380000);
});

test('LandWatch builds le-flore-county for the Airtable "Leflore" county (generic slug returns HTTP 400)', () => {
  const LandWatchParser = require('../lib/parsers/landwatch');
  const urls = new LandWatchParser().buildSearchUrls([{ county: 'Leflore', state: 'OK' }]).map(u => u.url);
  assert.ok(urls.every(u => u.includes('/oklahoma-land-for-sale/le-flore-county')), urls.join('\n'));
  assert.ok(new LandWatchParser().countySlug('Pittsburg') === 'pittsburg');
});

test('LandWatch and Whitetail search URLs honor a SCRAPER_MIN_ACRES override', () => {
  const prev = process.env.SCRAPER_MIN_ACRES;
  process.env.SCRAPER_MIN_ACRES = '20';
  try {
    const LandWatchParser = require('../lib/parsers/landwatch');
    const WhitetailParser = require('../lib/parsers/whitetail');
    const lw = new LandWatchParser().buildSearchUrls([{ county: 'Pittsburg', state: 'OK' }])[0].url;
    const wt = new WhitetailParser().buildSearchUrls([{ county: 'Dewey', state: 'OK' }])[0].url;
    assert.ok(lw.includes('/acres-over-20'), lw);
    assert.ok(wt.includes('acreage_min=20'), wt);
  } finally {
    if (prev === undefined) delete process.env.SCRAPER_MIN_ACRES; else process.env.SCRAPER_MIN_ACRES = prev;
  }
});
