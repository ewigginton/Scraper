'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const LandWatchParser = require('../lib/parsers/landwatch');
const LandComParser = require('../lib/parsers/landcom');
const LandAndFarmParser = require('../lib/parsers/landfarm');
const LandsOfAmericaParser = require('../lib/parsers/landsofamerica');
const LivingTheDreamParser = require('../lib/parsers/livingthedream');

const testCounties = [
  { county: 'San Augustine', state: 'TX', maxCPA: 2000 },
  { county: 'Taney', state: 'MO', maxCPA: 4000 },
];

test('LandWatch generates correct URL slugs', () => {
  const parser = new LandWatchParser();
  const urls = parser.buildSearchUrls(testCounties);
  const first = urls[0].url;
  assert.match(first, /landwatch\.com\/texas\/san-augustine-county/);
  assert.match(first, /minAcreage=40/);
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

// LandAndFarm is deliberately absent: it has been rebuilt against real captured
// markup (test/landfarm.test.js), and the site has no min-acres query parameter
// at all — the "40"/"150" this loop looks for only ever existed in the invented
// query string the rebuild deleted. Its URL shape is now pinned field-for-field
// against the fixture instead. The three parsers left here are the CoStar sites
// still awaiting the same rebuild, so the assertion stays exactly as strict for
// them.
test('the not-yet-rebuilt CoStar parsers generate both pass-1 and pass-2 (large tract) URLs', () => {
  const singleCounty = [{ county: 'Taney', state: 'MO', maxCPA: 4000 }];

  for (const Parser of [LandWatchParser, LandComParser, LandsOfAmericaParser]) {
    const parser = new Parser();
    const urls = parser.buildSearchUrls(singleCounty);
    const hasSmall = urls.some(u => u.url.includes('40'));
    const hasLarge = urls.some(u => u.url.includes('150'));
    assert.ok(hasSmall, `${parser.name} missing pass-1 (40ac) URLs`);
    assert.ok(hasLarge, `${parser.name} missing pass-2 (150ac) URLs`);
  }
});

test('parser returns no listings on malformed cards without throwing', () => {
  const parser = new LandWatchParser();
  const badHtml = '<div data-testid="listing-card"><div class="price">not a price</div></div>';
  const listings = parser.parseSearchPage(badHtml, 'Taney', 'MO');
  assert.deepEqual(listings, [], 'malformed card should be dropped, not emitted');
});

test('LandWatch extracts a listing from realistic card markup', () => {
  const parser = new LandWatchParser();
  const html = `
    <html><body>
      <div data-testid="listing-card">
        <h2 class="listing-title">160 Acres in Taney County</h2>
        <div class="price">$480,000</div>
        <div class="acres">160 acres</div>
        <p class="description">Beautiful rolling pasture with creek frontage.</p>
        <a href="/land/pid/12345">View</a>
      </div>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Taney', 'MO');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 480000);
  assert.equal(listings[0].acres, 160);
  assert.equal(listings[0].url, 'https://www.landwatch.com/land/pid/12345');
  assert.equal(listings[0].county, 'Taney');
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

  const parser = new LandWatchParser();
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

  const parser = new LandWatchParser();
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

  const parser = new LandWatchParser();
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
  assert.ok(txUrls[0].url.includes('/texas/'));
  assert.ok(moUrls[0].url.includes('/missouri/'));
});

test('SCRAPER_MAX_PAGE limits validation runs to early pages', async () => {
  const parser = new LandWatchParser();
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
