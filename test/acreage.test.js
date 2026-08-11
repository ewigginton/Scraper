'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAcreageNumber, extractStructuredTextAcres } = require('../lib/acreage');
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

// ---------- structured-signal text patterns (lib/acreage.js) ----------

test('extractStructuredTextAcres: price-adjacent bullet and "View ... priced at" patterns, decimal-safe', () => {
  assert.equal(extractStructuredTextAcres('$150,000 • 0.94 acres'), 0.94);
  assert.equal(extractStructuredTextAcres('$1,234,000 · 1,234.5 Acres'), 1234.5);
  assert.equal(extractStructuredTextAcres('View 0.94 acres priced at $150,000'), 0.94);
  assert.equal(extractStructuredTextAcres('View .499 acres priced at $12,000'), 0.499, 'a leading decimal never loses its point');
  assert.equal(
    extractStructuredTextAcres('Nestled on 600 acres bordering Savage Gulf State Park'),
    null,
    'plain description prose naming an unrelated acreage is not a structured signal'
  );
});

// ---------- BaseParser#extractDetailAcres: the "N-acre lake" bug ----------
// Real LandWatch production failures (each became a bogus Airtable lead before
// this fix): a search-card regex snagged a big acreage figure from nearby
// description prose (a lake/park/development's own size) instead of the
// listing's true small acreage. Every detail page carried a correct
// structured signal (JSON-LD or price-adjacent text) alongside the misleading
// prose — extractDetailAcres must prefer that structured signal every time.

test('extractDetailAcres: "on the gorgeous 1,000 acre Lake Halford" (true 0.94ac) — price-bullet line wins', () => {
  const parser = new BaseParser('Test');
  const html = `<html><head>
    <meta name="description" content="0.94 acres in Wayne County, Kentucky. Nestled beside the gorgeous 1,000 acre Lake Halford, this parcel offers incredible views.">
    </head><body><main>
      <h1>Lake Halford Retreat</h1>
      <div class="price-line">$150,000 • 0.94 acres</div>
      <p>Nestled beside the gorgeous 1,000 acre Lake Halford, this parcel offers incredible views and easy access.</p>
    </main></body></html>`;
  assert.equal(parser.extractDetailAcres(html), 0.94);
});

test('extractDetailAcres: "Nestled on 600 acres bordering Savage Gulf State Park" (true 5.01ac) — "View ... priced at" wins', () => {
  const parser = new BaseParser('Test');
  const html = `<html><body><main>
      <h1>Savage Gulf Bluff Tract</h1>
      <p>View 5.01 acres priced at $89,900. Nestled on 600 acres bordering Savage Gulf State Park, this tract has incredible bluff views.</p>
    </main></body></html>`;
  assert.equal(parser.extractDetailAcres(html), 5.01);
});

test('extractDetailAcres: "access to a 120 acre lake" (true 1.04ac) — JSON-LD structured field wins', () => {
  const parser = new BaseParser('Test');
  const html = `<html><head>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Lake Access Tract","acres":1.04,"offers":{"@type":"Offer","price":45000}}
    </script>
    </head><body><main>
      <h1>Lake Access Tract</h1>
      <p>This parcel has deeded access to a 120 acre lake just down the road.</p>
    </main></body></html>`;
  assert.equal(parser.extractDetailAcres(html), 1.04);
});

test('extractDetailAcres: "74ACRES" development (true 5.93ac) — price-bullet line wins over the all-caps figure', () => {
  const parser = new BaseParser('Test');
  const html = `<html><body><main>
      <h1>Hidden Ridge Lot 12</h1>
      <div class="price-acres">$210,000 • 5.93 acres</div>
      <p>Located in the prestigious 74ACRES development, this homesite backs to green space.</p>
    </main></body></html>`;
  assert.equal(parser.extractDetailAcres(html), 5.93);
});

test('extractDetailAcres: ".241 acres" and ".499 Acres +/-" — the title/heading tier never drops the leading decimal', () => {
  const parser = new BaseParser('Test');
  const decimalLoss1 = `<html><body><main><h1>House Lot .241 Acres</h1><p>Wooded corner lot with utilities at the street.</p></main></body></html>`;
  assert.equal(parser.extractDetailAcres(decimalLoss1), 0.241, '.241 must never be read as 241');

  const decimalLoss2 = `<html><body><main><h1>.499 Acres +/- Building Lot</h1><p>Level building lot ready for your new home.</p></main></body></html>`;
  assert.equal(parser.extractDetailAcres(decimalLoss2), 0.499, '.499 must never be read as 499');
});

test('extractDetailAcres: schema.org QuantitativeValue lotSize with an acre unit is read', () => {
  const parser = new BaseParser('Test');
  const html = `<html><head>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","lotSize":{"@type":"QuantitativeValue","value":40,"unitText":"ACR"}}
    </script>
    </head><body></body></html>`;
  assert.equal(parser.extractDetailAcres(html), 40);
});

test('extractDetailAcres: free-text description is the LAST resort, only used when nothing structured exists', () => {
  const parser = new BaseParser('Test');
  // No JSON-LD, no price-bullet/View-priced-at text, no h1 — with nothing
  // structured available, the generic description-prose match is all that's
  // left (documenting the known limitation: garbage in, garbage out, but only
  // when every more-trustworthy signal is genuinely absent).
  const html = `<html><body><main><p>This property sits near a 120 acre lake.</p></main></body></html>`;
  assert.equal(parser.extractDetailAcres(html), 120);
});

test('extractDetailAcres: garbage/absent HTML never throws', () => {
  const parser = new BaseParser('Test');
  for (const junk of ['', null, undefined, '<<<>>> not html', 42, {}]) {
    assert.doesNotThrow(() => parser.extractDetailAcres(junk));
  }
});
