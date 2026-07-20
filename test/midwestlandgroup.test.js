'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MidwestLandGroupParser = require('../lib/parsers/midwestlandgroup');

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
