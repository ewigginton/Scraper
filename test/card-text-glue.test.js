'use strict';

// Shared card-text extraction hardening (lib/parsers/base-parser.js
// extractByDetailLinks / extractTotalPrice / extractAcres, lib/acreage.js).
// Source incident: the 2026-09-15 nightly wrote 81 WhitetailProperties leads
// whose price and acreage were fused ("$873,600312 acres" -> 873,600,312 ac).

const test = require('node:test');
const assert = require('node:assert/strict');

const BaseParser = require('../lib/parsers/base-parser');
const LandWatchParser = require('../lib/parsers/landwatch');
const { ACREAGE_NUMBER, parseAcreageNumber } = require('../lib/acreage');

const acresPhrase = new RegExp(`(${ACREAGE_NUMBER})\\s*(?:±|\\+\\/-)?\\s*acres?\\b`, 'i');
function rawAcres(text) {
  const m = String(text).match(acresPhrase);
  return m ? parseAcreageNumber(m[1]) : null;
}

test('ACREAGE_NUMBER keeps leading-decimal and well-formed comma figures', () => {
  assert.equal(rawAcres('.24 acres'), 0.24);
  assert.equal(rawAcres('0.24 acres'), 0.24);
  assert.equal(rawAcres('40 acres'), 40);
  assert.equal(rawAcres('155± Acres'), 155);
  assert.equal(rawAcres('30 +/- acres'), 30);
  assert.equal(rawAcres('1,272 acres'), 1272);
  assert.equal(rawAcres('40,000 acres'), 40000);
  assert.equal(rawAcres('1,234.5 acres'), 1234.5);
});

test('ACREAGE_NUMBER refuses a digit run glued onto a comma-grouped number (never misreads it)', () => {
  // Every comma must be followed by exactly 3 digits, and a match may not
  // start inside another number — so none of these yields a (wrong) value.
  assert.equal(rawAcres('$873,600312 acres ±'), null);
  assert.equal(rawAcres('$1,950,0001272 acres'), null);
  assert.equal(rawAcres('$1,340,938812.69 acres'), null);
  assert.equal(rawAcres('1,00 acres'), null);
});

test('extractTotalPrice stops a comma-grouped price at its last valid group', () => {
  const p = new BaseParser('T');
  assert.equal(p.extractTotalPrice('Reduced $873,600312 acres ±'), 873600);
  assert.equal(p.extractTotalPrice('For Sale $1,950,0001272 acres'), 1950000);
  assert.equal(p.extractTotalPrice('For Sale $1,340,938812.69 acres'), 1340938);
  assert.equal(p.extractTotalPrice('Reduced $44,5006.62 acres'), 44500);
  // Unchanged behaviour on normal text
  assert.equal(p.extractTotalPrice('$2,900/acre • $1,250,000 • 431 acres'), 1250000);
  assert.equal(p.extractTotalPrice('$12,500.50 total'), 12500.5);
  assert.equal(p.extractTotalPrice('$250000 for 80 acres'), 250000);
  assert.equal(p.extractTotalPrice('$5,000 down'), null, 'amounts under $10,000 are not total prices');
});

test('extractAcres reads the acreage that follows a glued price', () => {
  const p = new BaseParser('T');
  assert.equal(p.extractAcres('Reduced $873,600312 acres ± Dewey County'), 312);
  assert.equal(p.extractAcres('For Sale $1,340,938812.69 acres ±'), 812.69);
  assert.equal(p.extractAcres('Reduced $44,5006.62 acres ±'), 6.62);
  assert.equal(p.extractAcres('Reduced $359,00093 acres ± Hardin County'), 93);
  // Unchanged behaviour on normal text
  assert.equal(p.extractAcres('$1,250,000 • 431 acres'), 431);
  assert.equal(p.extractAcres('Lot .24 acres $15,000'), 0.24);
  assert.equal(p.extractAcres('no acreage here $100,000'), null);
});

test('card text excludes <script> content, so JSON-LD prose cannot override the card\'s displayed acreage', () => {
  // Shape of a real LandWatch card (test/fixtures/landwatch-search-acres-over-150.html,
  // pid 423684859): the photo anchor's ancestor holds a JSON-LD script whose
  // description says "300 acres", while the card itself shows 297 acres.
  // cheerio's .text() includes script bodies; the card text must not.
  const parser = new LandWatchParser();
  const html = `<div class="results">
    <div class="card">
      <div class="photo"><div><div><a href="/x-for-sale/pid/423684859"><img></a></div></div>
        <script type="application/ld+json">{"description":"Nestled within 300 acres", "price":"$850,000"}</script></div>
      <div class="body"><a href="/x-for-sale/pid/423684859"><span>$850,000</span> • <span>297 acres</span></a>
        <a href="/x-for-sale/pid/423684859">597 Lost Hollow RD, Monticello, KY, Wayne County</a></div>
    </div></div>`;
  const listings = parser.parseSearchPage(html, 'Wayne', 'KY');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 850000);
  assert.equal(listings[0].acres, 297);
  assert.doesNotMatch(listings[0].description, /@context|Nestled/);
});

test('a card walk stops at an ancestor that holds another listing\'s detail link', () => {
  // The first listing has no price of its own; the old walk climbed to the
  // shared list container and took the SECOND listing's price and acreage.
  const parser = new LandWatchParser();
  const html = `<section><div class="list">
    <div><a href="/a-for-sale/pid/1">Auction tract</a><span>120 acres</span></div>
    <div><a href="/b-for-sale/pid/2">Priced tract</a><span>$400,000</span> <span>200 acres</span></div>
  </div></section>`;
  const listings = parser.parseSearchPage(html, 'Wayne', 'KY');
  assert.deepEqual(listings.map(l => [l.url.split('/').pop(), l.price, l.acres]), [['2', 400000, 200]]);
  assert.equal(parser._lastCardCount, 2);
});
