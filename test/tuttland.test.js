'use strict';

// The trimmed fixture below holds the 12 real featured-property cards captured
// from data/evidence/www.tuttland.com-index-2c25c47c.html (the full raw capture
// lives on the evidence-inbox branch — data/evidence is gitignored here). Pull
// that branch to re-verify or refresh the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TuttLandParser = require('../lib/parsers/tuttland');

const searchHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'tuttland-index.html'),
  'utf8',
);

// ---------- buildSearchUrls ----------

test('buildSearchUrls dedupes states and builds /land-sale/{slug}/ only for covered states', () => {
  const parser = new TuttLandParser();
  const urls = parser.buildSearchUrls([
    { county: 'Dallas', state: 'AL' },
    { county: 'Autauga', state: 'AL' },
    { county: 'McNairy', state: 'TN' },
    { county: 'Fulton', state: 'KY' }, // NOT covered by Tutt Land
  ]);

  assert.deepEqual(urls.map(u => u.url), [
    'https://www.tuttland.com/land-sale/alabama/',
    'https://www.tuttland.com/land-sale/tennessee/',
  ]);
  assert.ok(!urls.some(u => u.state === 'KY'), 'non-covered KY produces no URL');
  assert.equal(urls[0].page, 1);
});

test('all five coverage states build a state page; a non-covered state does not', () => {
  const parser = new TuttLandParser();
  const covered = ['AL', 'GA', 'MS', 'TN', 'FL'];
  for (const st of covered) {
    const urls = parser.buildSearchUrls([{ county: 'X', state: st }]);
    assert.equal(urls.length, 1, `${st} is covered`);
  }
  assert.equal(parser.buildSearchUrls([{ county: 'X', state: 'MO' }]).length, 0, 'MO is not covered');
});

test('requiresBrowserRender is false and results are not treated as newest-first', () => {
  const parser = new TuttLandParser();
  assert.equal(parser.requiresBrowserRender, false);
  assert.equal(parser.resultsSortedNewestFirst, false);
});

// ---------- parseSearchPage (real captured cards) ----------

test('parseSearchPage extracts real cards with correct price/acres/county/state', () => {
  const parser = new TuttLandParser();
  const listings = parser.parseSearchPage(searchHtml, null, null);

  // 12 real cards; 2 are "Under Contract" and dropped, so 10 are emitted.
  assert.equal(parser._lastCardCount, 12, 'all real cards counted for drift detection');
  assert.equal(listings.length, 10, 'the two Under Contract cards are not emitted');

  // A known AL card parses exactly (price from schema.org meta, acres from the
  // mislabeled .tl-county span, county+state from the .tl-subtitle location).
  const swift = listings.find(l => l.url.endsWith('/367-acres-autauga-county-swift-creek-tract'));
  assert.ok(swift, 'Swift Creek Tract found');
  assert.equal(swift.name, 'Swift Creek Tract');
  assert.equal(swift.price, 1795000);
  assert.equal(swift.acres, 367);
  assert.equal(swift.county, 'Autauga');
  assert.equal(swift.state, 'AL');
  assert.equal(swift.url, 'https://www.tuttland.com/land-sale/alabama/autauga-county/367-acres-autauga-county-swift-creek-tract');

  // A "New"-status card is kept; a comma-grouped acreage parses.
  const broken = listings.find(l => l.name === 'Broken Arrow Farm');
  assert.ok(broken, 'Active card kept');
  assert.equal(broken.acres, 1513);
  assert.equal(broken.price, 10600000);

  // A TN card carries its own state, not the null fallback.
  const wolf = listings.find(l => l.name === 'Wolf Pen Rd');
  assert.ok(wolf);
  assert.equal(wolf.county, 'McNairy');
  assert.equal(wolf.state, 'TN');

  // Every emitted card carries a /land-sale/{state}/{county}-county/{slug} URL
  // and its own county + state.
  assert.ok(
    listings.every(l => /\/land-sale\/[^/]+\/[^/]+-county\/[^/]+$/.test(l.url)),
    'all URLs are state/county-county/slug detail links',
  );
  assert.ok(listings.every(l => l.county && l.state), 'every card carries county + state');
});

test('parseSearchPage skips Under Contract cards but still counts them', () => {
  const parser = new TuttLandParser();
  const listings = parser.parseSearchPage(searchHtml, null, null);
  // "Hicks Breeder Farm" (Dale County) and "2 Tract" (Winston County) are Under Contract.
  assert.ok(!listings.some(l => l.name === 'Hicks Breeder Farm'), 'Under Contract card dropped');
  assert.ok(!listings.some(l => l.name === '2 Tract'), 'Under Contract card dropped');
  assert.equal(parser._lastCardCount, 12, 'both still counted so the page is not read as drift');
});

test('parseSearchPage falls back to the passed state when a card location is unusable', () => {
  const parser = new TuttLandParser();
  const html = `
    <html><body>
      <article class="tl-tile tl-status-active">
        <meta itemprop="price" content="480000.00">
        <a class="tl-hit" href="/land-sale/georgia/decatur-county/nice-tract">Nice Tract</a>
        <span class="tl-line tl-county">160 acres</span>
        <span class="tl-line tl-tile-title" itemprop="name">Nice Tract</span>
      </article>
    </body></html>`;
  const listings = parser.parseSearchPage(html, null, 'GA');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].state, 'GA', 'falls back to the per-state page state');
  assert.equal(listings[0].county, null, 'no county in the card location');
  assert.equal(listings[0].acres, 160);
});

// ---------- robustness ----------

test('parseSearchPage on garbage/empty HTML returns [] without throwing', () => {
  const parser = new TuttLandParser();
  assert.deepEqual(parser.parseSearchPage('<html><body>nothing here</body></html>', null, null), []);
  assert.deepEqual(parser.parseSearchPage('', null, null), []);
});
