'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BaseParser = require('../lib/parsers/base-parser');
const airtable = require('../lib/airtable');
const { applyDetailToListing } = require('../lib/scraper');

// A bare parser instance is enough — extractDetailCoordinates and
// parseCoordinates are generic BaseParser methods with no site state.
function makeParser() {
  return new BaseParser('CoordTestSite');
}

const FIXTURES = path.join(__dirname, 'fixtures');
const EVIDENCE = path.join(__dirname, '..', 'data', 'evidence');

// A minimal parser whose parseDetailPage returns nothing structured, so
// applyDetailToListing exercises the generic extractDetailCoordinates path.
class DetailParser extends BaseParser {
  constructor() { super('DetailCoordSite'); }
  parseDetailPage() { return {}; }
}

// ---------------------------------------------------------------------------
// (a) REAL captured detail pages. Both were checked by hand: the LANDFLIP
// detail page carries JSON-LD (BreadcrumbList + Product only — NO
// GeoCoordinates) and no geo meta / map coordinates; the MidwestLandGroup
// detail page carries no coordinates of any kind. So the honest assertion for
// both real pages is null — this feature can only extract coordinates from
// pages that actually publish them, and neither of these does.
// ---------------------------------------------------------------------------
test('extractDetailCoordinates: real LANDFLIP detail fixture carries no coordinates → null', () => {
  const html = fs.readFileSync(path.join(FIXTURES, 'landflip-detail-420517.html'), 'utf8');
  assert.equal(makeParser().extractDetailCoordinates(html), null);
});

test('extractDetailCoordinates: real LANDFLIP evidence capture (160KB) carries no coordinates → null', (t) => {
  // data/evidence is gitignored — the full capture exists only on machines
  // that ran the evidence pipeline (the trimmed committed fixture above
  // covers the same assertion everywhere, including CI's fresh checkout).
  const capturePath = path.join(EVIDENCE, 'www.landflip.com-land-420517-10628af3.html');
  if (!fs.existsSync(capturePath)) {
    t.skip('full evidence capture not present in this checkout');
    return;
  }
  const html = fs.readFileSync(capturePath, 'utf8');
  assert.equal(makeParser().extractDetailCoordinates(html), null);
});

test('extractDetailCoordinates: real MidwestLandGroup detail fixture carries no coordinates → null', () => {
  const html = fs.readFileSync(path.join(FIXTURES, 'midwestlandgroup-detail-latimer.html'), 'utf8');
  assert.equal(makeParser().extractDetailCoordinates(html), null);
});

// ---------------------------------------------------------------------------
// (b) Synthetic fixtures — one per source pattern the extractor supports.
//     Coordinates chosen inside the continental-US bounds (a Missouri/Kentucky
//     tract, ~36–37 N, ~-92 W) so they survive parseCoordinates validation.
// ---------------------------------------------------------------------------
test('extractDetailCoordinates: JSON-LD GeoCoordinates', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Place",
     "geo":{"@type":"GeoCoordinates","latitude":36.712,"longitude":-92.481}}
  </script></head><body></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '36.712, -92.481');
});

test('extractDetailCoordinates: JSON-LD tolerates numeric-string lat/lng and @graph nesting', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebPage"},
      {"@type":"Product","geo":{"@type":"GeoCoordinates","latitude":"37.05","longitude":"-93.20"}}
    ]}
  </script></head><body></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '37.05, -93.2');
});

test('extractDetailCoordinates: meta geo.position (lat;lng)', () => {
  const html = `<html><head><meta name="geo.position" content="36.60;-92.40"></head><body></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '36.6, -92.4');
});

test('extractDetailCoordinates: meta ICBM (lat, lng)', () => {
  const html = `<html><head><meta name="ICBM" content="36.90, -93.10"></head><body></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '36.9, -93.1');
});

test('extractDetailCoordinates: og:latitude / og:longitude meta pair', () => {
  const html = `<html><head>
    <meta property="og:latitude" content="35.44">
    <meta property="og:longitude" content="-92.11">
  </head><body></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '35.44, -92.11');
});

test('extractDetailCoordinates: place:location:latitude/longitude meta pair (content-before-property order)', () => {
  const html = `<html><head>
    <meta content="34.55" property="place:location:latitude">
    <meta content="-92.99" property="place:location:longitude">
  </head><body></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '34.55, -92.99');
});

test('extractDetailCoordinates: google.com/maps?q=LAT,LNG link', () => {
  const html = `<html><body><a href="https://www.google.com/maps?q=36.25,-92.75&z=14">Map</a></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '36.25, -92.75');
});

test('extractDetailCoordinates: google maps /@LAT,LNG,zoom link', () => {
  const html = `<html><body><a href="https://www.google.com/maps/@36.31,-92.62,15z">Map</a></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '36.31, -92.62');
});

test('extractDetailCoordinates: maps.apple.com ll= link', () => {
  const html = `<html><body><a href="https://maps.apple.com/?ll=36.40,-92.55&q=Parcel">Apple Map</a></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '36.4, -92.55');
});

test('extractDetailCoordinates: Google Maps JS LatLng(LAT, LNG) call', () => {
  const html = `<html><body><script>var c = new google.maps.LatLng(36.77, -92.34);</script></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), '36.77, -92.34');
});

test('extractDetailCoordinates: "lat"/"lng" JSON pair in a script (both key orders)', () => {
  const latFirst = `<html><body><script>window.map = {"lat": 36.12, "lng": -92.88};</script></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(latFirst), '36.12, -92.88');

  const lngFirst = `<html><body><script>window.map = {"lng": -92.88, "lat": 36.12};</script></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(lngFirst), '36.12, -92.88');
});

test('extractDetailCoordinates: JSON-LD wins over a less-trustworthy map link on the same page', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"GeoCoordinates","latitude":36.50,"longitude":-92.50}
  </script></head><body>
    <a href="https://www.google.com/maps?q=40.00,-90.00">Map</a>
  </body></html>`;
  // The map link is also in continental-US bounds, so a wrong precedence would
  // still validate — this pins JSON-LD as the source that must win.
  assert.equal(makeParser().extractDetailCoordinates(html), '36.5, -92.5');
});

// ---------------------------------------------------------------------------
// (b cont.) Out-of-bounds rejection + hostile-input bounded time.
// ---------------------------------------------------------------------------
test('extractDetailCoordinates: out-of-bounds coordinates (London UK) are rejected → null', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"GeoCoordinates","latitude":51.5074,"longitude":-0.1278}
  </script></head><body></body></html>`;
  assert.equal(makeParser().extractDetailCoordinates(html), null);
});

test('extractDetailCoordinates: garbage / weird HTML never throws, yields null', () => {
  const parser = makeParser();
  for (const junk of ['', null, undefined, '<<<>>> not html', '<html><body>', 42, {}, []]) {
    assert.doesNotThrow(() => parser.extractDetailCoordinates(junk));
    assert.equal(parser.extractDetailCoordinates(junk), null);
  }
});

test('extractDetailCoordinates: hostile oversized/deeply-nested HTML is bounded in time', () => {
  const parser = makeParser();
  // Oversized doc with a valid coordinate near the top: the byte guard trims
  // the scan to the leading slice, and the pure-regex path stays linear.
  const oversized = '<html><head><meta name="ICBM" content="36.5, -92.5"></head><body>'
    + 'a'.repeat(1300000) + '</body></html>';
  let started = Date.now();
  assert.equal(parser.extractDetailCoordinates(oversized), '36.5, -92.5');
  assert.ok(Date.now() - started < 2000, 'oversized scan must stay bounded');

  // Deeply nested tags (tag-count guard) plus a hostile nested-JSON blob: must
  // not stall or throw.
  const hostile = '<html><body>' + '<div>'.repeat(60000) + 'x' + '</div>'.repeat(60000)
    + '<script>' + '['.repeat(5000) + '</script></body></html>';
  started = Date.now();
  assert.doesNotThrow(() => parser.extractDetailCoordinates(hostile));
  assert.ok(Date.now() - started < 2000, 'hostile scan must stay bounded');
});

// ---------------------------------------------------------------------------
// (c) applyDetailToListing sets coordinates only when the listing is missing them.
// ---------------------------------------------------------------------------
test('applyDetailToListing: sets coordinates from the detail page when the listing has none', () => {
  const parser = new DetailParser();
  const listing = { name: 'Ridge Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', coordinates: null };
  const html = `<html><head><meta name="geo.position" content="36.65;-93.22"></head><body></body></html>`;
  applyDetailToListing(parser, listing, html);
  assert.equal(listing.coordinates, '36.65, -93.22');
});

test('applyDetailToListing: never overwrites coordinates the listing already carries', () => {
  const parser = new DetailParser();
  const listing = { name: 'Card Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', coordinates: '40.00, -90.00' };
  const html = `<html><head><meta name="geo.position" content="36.65;-93.22"></head><body></body></html>`;
  applyDetailToListing(parser, listing, html);
  assert.equal(listing.coordinates, '40.00, -90.00', 'pre-existing coordinate preserved');
});

test('applyDetailToListing: leaves coordinates null when the detail page has none', () => {
  const parser = new DetailParser();
  const listing = { name: 'Blank Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', coordinates: null };
  const html = `<html><body><p>No coordinates anywhere in this page.</p></body></html>`;
  applyDetailToListing(parser, listing, html);
  assert.ok(!listing.coordinates, 'stays empty when nothing is extractable');
});

// ---------------------------------------------------------------------------
// (d) End-to-end: an enriched listing's extracted coordinates reach the field
//     map listingToFields produces — under the trailing-space Coordinate field
//     name (read via airtable.FIELDS, never hardcoded), which review night reads.
// ---------------------------------------------------------------------------
test('end-to-end: extracted coordinates reach listingToFields under the Coordinate field', () => {
  const parser = new DetailParser();
  const listing = { name: 'Flood Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', coordinates: null };
  const html = `<html><head><script type="application/ld+json">
    {"@type":"GeoCoordinates","latitude":36.61,"longitude":-93.28}
  </script></head><body></body></html>`;
  applyDetailToListing(parser, listing, html);
  assert.equal(listing.coordinates, '36.61, -93.28');

  const fields = airtable.listingToFields(listing);
  assert.equal(fields[airtable.FIELDS.coordinates], '36.61, -93.28',
    'coordinates land in the Coordinate field lib/review.js flood check reads');
});
