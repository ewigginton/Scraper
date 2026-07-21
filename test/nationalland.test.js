'use strict';

// The trimmed fixture below holds real cards captured (headed-browser render)
// from data/evidence/nationalland.com-land-for-sale-kentucky-10322d1a.html —
// the full raw capture lives on the evidence-inbox branch (data/evidence is
// gitignored here). Pull that branch to re-verify or refresh the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const NationalLandRealtyParser = require('../lib/parsers/nationalland');
const browserFetch = require('../lib/browser-fetch');

const searchHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'nationalland-kentucky-search.html'),
  'utf8',
);

// ---------- buildSearchUrls ----------

test('buildSearchUrls dedupes states (one series per state) and builds /land-for-sale/{slug} with ?page pagination', () => {
  const parser = new NationalLandRealtyParser();
  const urls = parser.buildSearchUrls([
    { county: 'Adair', state: 'KY' },
    { county: 'Warren', state: 'KY' },
    { county: 'Taney', state: 'MO' },
  ]);

  assert.deepEqual(urls.map(u => u.url), [
    'https://nationalland.com/land-for-sale/kentucky',
    'https://nationalland.com/land-for-sale/kentucky?page=2',
    'https://nationalland.com/land-for-sale/missouri',
    'https://nationalland.com/land-for-sale/missouri?page=2',
  ]);
  assert.equal(urls[0].page, 1);
  assert.equal(urls[1].page, 2);

  // Multi-word state slugs are lowercased and hyphenated.
  const nm = parser.buildSearchUrls([{ county: 'Rio Arriba', state: 'NM' }]);
  assert.equal(nm[0].url, 'https://nationalland.com/land-for-sale/new-mexico');
});

test('requiresBrowserRender is set — the listings page is a client-rendered React SPA', () => {
  assert.equal(new NationalLandRealtyParser().requiresBrowserRender, true);
});

// ---------- parseSearchPage (real captured cards) ----------

test('parseSearchPage extracts real cards from the KY fixture with correct fields', () => {
  const parser = new NationalLandRealtyParser();
  const listings = parser.parseSearchPage(searchHtml, null, 'KY');

  // Fixture holds 6 real cards; one is PENDING and dropped, so 5 are emitted.
  assert.equal(parser._lastCardCount, 6, 'all real cards counted for drift detection');
  assert.equal(listings.length, 5, 'the PENDING card is not emitted');

  const known = listings.find(l => l.url === 'https://nationalland.com/listing/rock-lick-creek-retreat');
  assert.ok(known, 'Rock Lick Creek Retreat extracted');
  assert.equal(known.name, 'Rock Lick Creek Retreat');
  assert.equal(known.price, 650000);
  assert.equal(known.acres, 240);
  assert.equal(known.county, 'Adair');
  assert.equal(known.state, 'KY'); // supplied by buildSearchUrls (per-state page)

  // A decimal-acreage card parses too.
  const shawnee = listings.find(l => l.url.endsWith('/the-shawnee-lake-lot'));
  assert.ok(shawnee);
  assert.equal(shawnee.acres, 1.02);
  assert.equal(shawnee.price, 75000);
  assert.equal(shawnee.county, 'Logan');

  // Every emitted card carries a /listing/{slug} URL and its own county + state.
  assert.ok(listings.every(l => /\/listing\/[^/]+$/.test(l.url)), 'all URLs are /listing/{slug}');
  assert.ok(listings.every(l => l.county && l.state), 'every card carries county + state');
});

test('parseSearchPage skips PENDING/SOLD/UNDER CONTRACT cards but still counts them', () => {
  const parser = new NationalLandRealtyParser();
  const listings = parser.parseSearchPage(searchHtml, null, 'KY');
  // The Owsley "Buildable Hunting and Recreation Farm" card is PENDING.
  assert.ok(!listings.some(l => l.county === 'Owsley'), 'PENDING card dropped');
  // ...but it was still counted so a PENDING-heavy page is not read as drift.
  assert.equal(parser._lastCardCount, 6);
});

// ---------- robustness ----------

test('parseSearchPage on garbage/empty HTML returns [] without throwing', () => {
  const parser = new NationalLandRealtyParser();
  assert.deepEqual(parser.parseSearchPage('<html><body><div id="root"></div></body></html>', null, 'KY'), []);
  assert.deepEqual(parser.parseSearchPage('', null, 'KY'), []);
});

// ---------- client-rendered fetch routing (mirrors MidwestLandGroup) ----------

test('scrapeAll fetches the client-rendered page via browserFetch, never fetchPageSmart', async (t) => {
  const originalIsEnabled = browserFetch.isEnabled;
  browserFetch.isEnabled = () => true;
  t.after(() => { browserFetch.isEnabled = originalIsEnabled; });

  const parser = new NationalLandRealtyParser();
  parser.sleep = () => Promise.resolve();
  let browserCalls = 0;
  let smartCalls = 0;
  parser.browserFetch = async () => { browserCalls++; return searchHtml; };
  parser.fetchPageSmart = async () => { smartCalls++; return '<html><body><div id="root"></div></body></html>'; };

  const listings = await parser.scrapeAll([{ county: 'Adair', state: 'KY', maxCPA: 5000 }]);

  assert.ok(browserCalls >= 1, 'page fetched through the browser');
  assert.equal(smartCalls, 0, 'plain fetchPageSmart never used for a client-rendered source');
  assert.ok(listings.length >= 1, 'real cards parsed from the browser-rendered page');
  assert.ok(!parser.sourceIssues.some(i => i.type === 'markup_drift'), 'a healthy render records no drift issue');
});

test('browser unavailable → clean skip with an explanatory issue, no drift issue', async (t) => {
  const originalIsEnabled = browserFetch.isEnabled;
  browserFetch.isEnabled = () => false;
  t.after(() => { browserFetch.isEnabled = originalIsEnabled; });

  const parser = new NationalLandRealtyParser();
  parser.sleep = () => Promise.resolve();
  let smartCalls = 0;
  parser.fetchPageSmart = async () => { smartCalls++; return '<html><body><div id="root"></div></body></html>'; };

  const listings = await parser.scrapeAll([{ county: 'Adair', state: 'KY', maxCPA: 5000 }]);

  assert.equal(listings.length, 0, 'no listings — the site is skipped, not mis-parsed');
  assert.equal(smartCalls, 0, 'the plain shell fetch is never attempted');
  assert.ok(parser.sourceIssues.some(i => i.type === 'fetch_or_parse_error' && /browser rendering/i.test(i.error)));
  assert.ok(!parser.sourceIssues.some(i => i.type === 'markup_drift'), 'no markup-drift mis-diagnosis');
  assert.equal(parser.stats.driftPages, 0);
});
