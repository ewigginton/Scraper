'use strict';

// The trimmed fixtures below (index + one detail page) are enough to pin the
// parser's selectors. The FULL raw captured evidence (complete pages, not the
// reduced fixtures) lives on the `source-evidence` branch at commit c5f5853 —
// it is kept off main because data/evidence is gitignored here. Pull that branch
// when re-verifying against the real markup or refreshing these fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MidwestLandGroupParser = require('../lib/parsers/midwestlandgroup');
const browserFetch = require('../lib/browser-fetch');

const indexHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'midwestlandgroup-index.html'),
  'utf8',
);
const detailHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'midwestlandgroup-detail-latimer.html'),
  'utf8',
);

// ---------- buildSearchUrls ----------

test('MidwestLandGroup returns the single national /listings/ index (no per-county URL)', () => {
  const parser = new MidwestLandGroupParser();
  // The site has no per-county/per-state URL and JS-only pagination, so the
  // county list is ignored and exactly one crawlable page is returned.
  const urls = parser.buildSearchUrls([
    { county: 'Wayne', state: 'KY' },
    { county: 'Latimer', state: 'OK' },
  ]);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://midwestlandgroup.com/listings/');
  assert.equal(urls[0].page, 1);
});

// ---------- parseSearchPage (real captured index HTML) ----------

test('parseSearchPage extracts listing detail URLs from the real index fixture', () => {
  const parser = new MidwestLandGroupParser();
  const listings = parser.parseSearchPage(indexHtml, null, null);

  assert.ok(listings.length >= 1, 'at least one card parsed from the index');

  const urls = listings.map(l => l.url);
  // A known real slug must be present...
  assert.ok(
    urls.some(u => u === 'https://midwestlandgroup.com/listings/barron-80/'),
    'barron-80 detail URL extracted',
  );
  // ...and the RSS feed and bare index must never be treated as listings.
  assert.ok(!urls.some(u => u.includes('/listings/feed/')), 'feed URL excluded');
  assert.ok(!urls.some(u => /\/listings\/$/.test(u)), 'bare index URL excluded');
});

test('parseSearchPage reads precise card fields (price/acres/county/state)', () => {
  const parser = new MidwestLandGroupParser();
  const listings = parser.parseSearchPage(indexHtml, null, null);
  const barron = listings.find(l => l.url.endsWith('/barron-80/'));

  assert.ok(barron, 'barron-80 card found');
  assert.equal(barron.price, 303600);
  assert.equal(barron.acres, 80);
  assert.equal(barron.county, 'Barron');
  // State is stored as the two-letter abbreviation the pipeline keys on.
  assert.equal(barron.state, 'WI');
  assert.match(barron.name, /Maple Plain 80/);
});

test('parseSearchPage skips the hidden JS card template', () => {
  const parser = new MidwestLandGroupParser();
  const listings = parser.parseSearchPage(indexHtml, null, null);
  // Every parsed listing has a real, non-empty detail URL — the hidden
  // template (empty href) must not appear.
  assert.ok(listings.every(l => /\/listings\/[^/]+\/$/.test(l.url)));
  assert.equal(parser._lastCardCount, listings.length, 'card count excludes the template');
});

// ---------- parseDetailPage (real captured detail HTML) ----------

test('parseDetailPage pulls price/acres/county/state from the Latimer detail fixture', () => {
  const parser = new MidwestLandGroupParser();
  const detail = parser.parseDetailPage(detailHtml);

  assert.equal(detail.price, 8810350);
  assert.equal(detail.acres, 5501.92);
  assert.equal(detail.county, 'Latimer');
  assert.equal(detail.state, 'OK'); // Oklahoma → OK (repo state convention)
  assert.ok(detail.description && detail.description.length > 50, 'a description was extracted');
  assert.match(detail.description, /Located in Latimer County/);
  // The "Property Description" heading is stripped from the block.
  assert.doesNotMatch(detail.description, /^Property Description/i);
});

// ---------- robustness ----------

test('parseSearchPage on a garbage/empty page returns [] without throwing', () => {
  const parser = new MidwestLandGroupParser();
  assert.deepEqual(parser.parseSearchPage('<html><body>nothing here</body></html>', null, null), []);
  assert.deepEqual(parser.parseSearchPage('', null, null), []);
});

test('parseDetailPage on a garbage/empty/null page returns no listing fields without throwing', () => {
  const parser = new MidwestLandGroupParser();
  // Empty/null yield a wholly empty object.
  assert.deepEqual(parser.parseDetailPage(''), {});
  assert.deepEqual(parser.parseDetailPage(null), {});
  // A page with body text but no labeled detail rows must not invent
  // price/acres/county/state (a stray description from body prose is harmless).
  const garbage = parser.parseDetailPage('<html><body>nothing here</body></html>');
  assert.equal(garbage.price, undefined);
  assert.equal(garbage.acres, undefined);
  assert.equal(garbage.county, undefined);
  assert.equal(garbage.state, undefined);
});

// ---------- BUG 2: the client-rendered index is fetched through the browser ----------

test('requiresBrowserRender is set — the /listings/ index is client-rendered', () => {
  // A plain fetch returns only the hidden JS card template, so scrapeAll must
  // route this source through the real browser.
  assert.equal(new MidwestLandGroupParser().requiresBrowserRender, true);
});

test('scrapeAll fetches the client-rendered index via browserFetch, never fetchPageSmart', async (t) => {
  const originalIsEnabled = browserFetch.isEnabled;
  browserFetch.isEnabled = () => true;
  t.after(() => { browserFetch.isEnabled = originalIsEnabled; });

  const parser = new MidwestLandGroupParser();
  parser.sleep = () => Promise.resolve();
  let browserCalls = 0;
  let smartCalls = 0;
  // The browser renders the real index; the plain path must never be taken.
  parser.browserFetch = async () => { browserCalls++; return indexHtml; };
  parser.fetchPageSmart = async () => { smartCalls++; return '<html>empty skeleton</html>'; };

  const listings = await parser.scrapeAll([{ county: 'Barron', state: 'WI', maxCPA: 5000 }]);

  assert.equal(browserCalls, 1, 'index fetched through the browser exactly once');
  assert.equal(smartCalls, 0, 'plain fetchPageSmart never used for a client-rendered source');
  assert.ok(listings.length >= 1, 'real cards parsed from the browser-rendered index');
  assert.equal(parser.sourceIssues.length, 0, 'a healthy browser render records no source issue');
});

test('flag + browser unavailable → clean skip with an explanatory issue, no drift issue', async (t) => {
  const originalIsEnabled = browserFetch.isEnabled;
  browserFetch.isEnabled = () => false; // browser disabled/unavailable this run
  t.after(() => { browserFetch.isEnabled = originalIsEnabled; });

  const parser = new MidwestLandGroupParser();
  parser.sleep = () => Promise.resolve();
  let smartCalls = 0;
  parser.fetchPageSmart = async () => { smartCalls++; return '<html>empty skeleton</html>'; };

  const listings = await parser.scrapeAll([{ county: 'Barron', state: 'WI', maxCPA: 5000 }]);

  assert.equal(listings.length, 0, 'no listings — the site is skipped, not mis-parsed');
  assert.equal(smartCalls, 0, 'the plain skeleton fetch is never attempted');
  // Exactly one issue, and it explains the browser-render requirement — NOT the
  // "zero cards matched" markup-drift mis-diagnosis last night produced.
  assert.equal(parser.sourceIssues.length, 1);
  assert.equal(parser.sourceIssues[0].type, 'fetch_or_parse_error');
  assert.match(parser.sourceIssues[0].error, /browser rendering/i);
  assert.ok(!parser.sourceIssues.some(i => i.type === 'markup_drift'), 'no markup-drift mis-diagnosis');
  assert.equal(parser.stats.driftPages, 0);
});
