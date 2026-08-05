'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAcreageNumber } = require('../lib/acreage');
const BaseParser = require('../lib/parsers/base-parser');
const { extractAcres } = require('../lib/intake');
const LandflipParser = require('../lib/parsers/landflip');

// ---------- shared numeric parser (lib/acreage.js) ----------

test('parseAcreageNumber: leading-decimal, plain-decimal, comma-grouped, and plain-integer forms', () => {
  assert.equal(parseAcreageNumber('.24'), 0.24, 'a leading decimal point with no digit before it');
  assert.equal(parseAcreageNumber('0.24'), 0.24);
  assert.equal(parseAcreageNumber('1,234.5'), 1234.5);
  assert.equal(parseAcreageNumber('40'), 40);
});

test('parseAcreageNumber: rejects zero, negative, and junk', () => {
  assert.equal(parseAcreageNumber('0'), null);
  assert.equal(parseAcreageNumber(''), null);
  assert.equal(parseAcreageNumber(null), null);
  assert.equal(parseAcreageNumber('not a number'), null);
});

// ---------- base-parser.js extractByDetailLinks engine (LandWatch/Whitetail/MossyOak) ----------

test('BaseParser#extractAcres: a leading-decimal card figure never loses its decimal point', () => {
  const parser = new BaseParser('Test');
  // Real bug: '.24 acres' text on a card was silently parsed as 24 acres
  // (the '.' was skipped because the old regex required a digit before it),
  // which let a 0.24-acre listing slip past the 40-acre minimum.
  assert.equal(parser.extractAcres('$45,000 | .24 Acres'), 0.24);
  assert.equal(parser.extractAcres('$45,000 | 0.24 Acres'), 0.24);
  assert.equal(parser.extractAcres('$3,200,000 | 1,234.5 Acres'), 1234.5);
  assert.equal(parser.extractAcres('$100,000 | 40 acres'), 40);
});

test('BaseParser#parseAcres: routed through the same shared numeric parser', () => {
  const parser = new BaseParser('Test');
  assert.equal(parser.parseAcres('.24 Acres'), 0.24);
  assert.equal(parser.parseAcres('160.5'), 160.5);
  assert.equal(parser.parseAcres('155± Acres'), 155);
});

// ---------- Listing Intake free-text extraction ----------

test('intake extractAcres: leading-decimal text in a submitted-URL page parses correctly', () => {
  assert.equal(extractAcres('This tract is .24 acres in size.'), 0.24);
  assert.equal(extractAcres('Lot size: 0.24 Acres'), 0.24);
  assert.equal(extractAcres('A sprawling 1,234.5 acres of prime land.'), 1234.5);
  assert.equal(extractAcres('40 acres of pasture'), 40);
});

// ---------- LANDFLIP's own acreage regexes ----------

test('LANDFLIP parseDetailPage: a leading-decimal acreage in the meta description parses correctly', () => {
  const parser = new LandflipParser();
  const html = '<html><head><meta name="description" content="A tract with .24 acres by Town in Wayne County, Kentucky 40000."></head><body></body></html>';
  const out = parser.parseDetailPage(html);
  assert.equal(out.acres, 0.24);
});

test('LANDFLIP parseSearchPage: a leading-decimal "N Acres : $X" search-card tag parses correctly', () => {
  const parser = new LandflipParser();
  const html = `
    <html><body>
      <article class="list-block">
        <div class="list-info">
          <h4><a href="/land/999">Tiny Lot</a></h4>
          <p>Town : Wayne Co : KY</p>
        </div>
        <span class="price-ac">.24 Acres : $45,000</span>
      </article>
    </body></html>`;
  const listings = parser.parseSearchPage(html, 'Wayne', 'KY');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].acres, 0.24);
  assert.equal(listings[0].price, 45000);
});
