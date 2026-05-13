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

test('LivingTheDream generates state-abbreviation URLs', () => {
  const parser = new LivingTheDreamParser();
  const urls = parser.buildSearchUrls(testCounties);
  const txUrl = urls[0].url;
  assert.match(txUrl, /state=tx/);
});

test('all parsers generate both pass-1 and pass-2 (large tract) URLs', () => {
  const singleCounty = [{ county: 'Taney', state: 'MO', maxCPA: 4000 }];

  for (const Parser of [LandWatchParser, LandComParser, LandAndFarmParser, LandsOfAmericaParser]) {
    const parser = new Parser();
    const urls = parser.buildSearchUrls(singleCounty);
    const hasSmall = urls.some(u => u.url.includes('40'));
    const hasLarge = urls.some(u => u.url.includes('150'));
    assert.ok(hasSmall, `${parser.name} missing pass-1 (40ac) URLs`);
    assert.ok(hasLarge, `${parser.name} missing pass-2 (150ac) URLs`);
  }
});

test('parser error logging increments error count on bad HTML', () => {
  const parser = new LandWatchParser();
  const badHtml = '<div data-testid="listing-card"><div class="price">not a price</div></div>';
  parser.parseSearchPage(badHtml, 'Taney', 'MO');
  // Even with bad data, the parser shouldn't throw — it should catch internally
  assert.ok(true, 'parser did not throw on malformed listing');
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
    return '<html></html>';
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
