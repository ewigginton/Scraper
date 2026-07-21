'use strict';

// The trimmed fixture below holds real RealStack cards captured from
// data/evidence/www.livingthedreamland.com-land-for-sale-8f92fbe0.html (the
// full raw capture lives on the evidence-inbox branch — data/evidence is
// gitignored here). Pull that branch to re-verify or refresh the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LivingTheDreamParser = require('../lib/parsers/livingthedream');

const searchHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'livingthedream-search.html'),
  'utf8',
);

// ---------- buildSearchUrls ----------

test('buildSearchUrls builds per-state pages only for covered states, deduped, with ?pg pagination', () => {
  const parser = new LivingTheDreamParser();
  // Two MO counties + one KY county + one non-covered OK county. Covered states
  // (MO, KY) each yield ONE series (state pages are statewide inventory); OK is
  // skipped because the site does not cover it.
  const urls = parser.buildSearchUrls([
    { county: 'Wayne', state: 'MO' },
    { county: 'Barry', state: 'MO' },
    { county: 'Fulton', state: 'KY' },
    { county: 'Latimer', state: 'OK' },
  ]);

  assert.deepEqual(urls.map(u => u.url), [
    'https://www.livingthedreamland.com/land-for-sale/missouri/',
    'https://www.livingthedreamland.com/land-for-sale/missouri/?pg=2',
    'https://www.livingthedreamland.com/land-for-sale/kentucky/',
    'https://www.livingthedreamland.com/land-for-sale/kentucky/?pg=2',
  ]);
  assert.ok(!urls.some(u => u.state === 'OK'), 'non-covered OK produces no URL');
  assert.equal(urls[0].page, 1);
  assert.equal(urls[1].page, 2);
});

test('KS/AR/IL are NOT covered — the captured index links only MO and KY state pages', () => {
  // The page title/meta advertise "MO, KY, KS, AR, IL", but the captured
  // /land-for-sale/ index links exactly two per-state pages (missouri, kentucky)
  // and every listing on it is MO or KY. Kansas/Arkansas/Illinois state pages
  // 404'd last run, so buildSearchUrls must skip them. Verified against
  // data/evidence/www.livingthedreamland.com-land-for-sale-8f92fbe0.html.
  const parser = new LivingTheDreamParser();
  const urls = parser.buildSearchUrls([
    { county: 'Cherokee', state: 'KS' },
    { county: 'Benton', state: 'AR' },
    { county: 'Pope', state: 'IL' },
    { county: 'Wayne', state: 'MO' },
  ]);
  assert.ok(!urls.some(u => ['KS', 'AR', 'IL'].includes(u.state)), 'no KS/AR/IL URLs');
  assert.deepEqual(urls.map(u => u.state), ['MO', 'MO'], 'only the covered MO state series is built');
});

test('resultsSortedNewestFirst is false — the default page order is price-descending, newest sort is JS-only', () => {
  // The captured page runs $17.5M -> $2.25M (price desc) and the "Newest"
  // option is a JS-driven data-rsfs select with no crawlable URL param, so
  // deeper pages are NOT guaranteed older: incremental early-stop stays off.
  assert.equal(new LivingTheDreamParser().resultsSortedNewestFirst, false);
});

// ---------- parseSearchPage (real captured cards) ----------

test('parseSearchPage extracts real cards with correct price/acres/county/state/coords', () => {
  const parser = new LivingTheDreamParser();
  const listings = parser.parseSearchPage(searchHtml, null, null);

  assert.equal(listings.length, 4);
  assert.equal(parser._lastCardCount, 4);

  // A known MO card is parsed exactly.
  const keener = listings.find(l => l.url.endsWith('/keener-springs-wayne-missouri/101028/'));
  assert.ok(keener, 'Keener Springs card found');
  assert.equal(keener.name, 'Keener Springs');
  assert.equal(keener.price, 2750000);
  assert.equal(keener.acres, 65);
  assert.equal(keener.county, 'Wayne');
  assert.equal(keener.state, 'MO');
  assert.equal(keener.coordinates, '36.92607, -90.522413'); // from data-lat/data-lng
  assert.match(keener.description, /Keener Springs is a truly rare/);

  // A KY card carries the KY state span.
  const fulton = listings.find(l => l.url.includes('/island-8-fulton-county-ky-'));
  assert.ok(fulton, 'Fulton KY card found');
  assert.equal(fulton.state, 'KY');
  assert.equal(fulton.county, 'Fulton');
  assert.equal(fulton.acres, 4780);
  assert.equal(fulton.price, 13500000);
});

test('parseSearchPage reads a multi-word, punctuated county (St. Louis)', () => {
  const parser = new LivingTheDreamParser();
  const listings = parser.parseSearchPage(searchHtml, null, null);
  const stl = listings.find(l => /Missouri Bottom 72\.7/.test(l.name));
  assert.ok(stl, 'St. Louis County card found');
  assert.equal(stl.county, 'St. Louis');
  assert.equal(stl.state, 'MO');
});

test('every parsed card carries a /property/ detail URL and its own county+state', () => {
  const parser = new LivingTheDreamParser();
  const listings = parser.parseSearchPage(searchHtml, null, null);
  assert.ok(listings.every(l => /\/property\/[^/]+\/\d+\/$/.test(l.url)), 'all URLs are /property/{slug}/{id}/');
  assert.ok(listings.every(l => l.county && l.state), 'every card carries county + state');
});

// ---------- robustness ----------

test('parseSearchPage on garbage/empty HTML returns [] without throwing', () => {
  const parser = new LivingTheDreamParser();
  assert.deepEqual(parser.parseSearchPage('<html><body>nothing here</body></html>', null, null), []);
  assert.deepEqual(parser.parseSearchPage('', null, null), []);
});
