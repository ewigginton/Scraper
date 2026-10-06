'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { readListingSubject, classifyStatus, detectSource, visibleText } = require('../lib/listing-subject');
const { findAvailabilityMatches } = require('../lib/availability');

// Real pages saved by the 2026-10-05 New Lead audit (script bodies other than
// JSON-LD, styles, svg and tokens stripped). Expected values are the
// adversarially verified readings from the 2026-10-05 cleanup plan.
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', `subject-${name}.html`), 'utf8');

const CASES = [
  {
    name: 'landwatch-available-darlington',
    url: 'https://www.landwatch.com/darlington-county-south-carolina-undeveloped-land-for-sale/pid/425066098',
    want: { source: 'LandWatch', status: 'Available', statusKind: 'active', unavailable: false, price: 1700000, acres: 531.91, county: 'Darlington', state: 'SC' },
  },
  {
    name: 'landwatch-available-lafayette',
    url: 'https://www.landwatch.com/lafayette-county-mississippi-recreational-property-for-sale/pid/427850551',
    want: { source: 'LandWatch', status: 'Available', statusKind: 'active', unavailable: false, price: 311610, acres: 78, county: 'Lafayette', state: 'MS' },
  },
  {
    name: 'landwatch-under-contract',
    url: 'https://www.landwatch.com/henry-county-tennessee-farms-and-ranches-for-sale/pid/426783020',
    want: { source: 'LandWatch', status: 'Under Contract', statusKind: 'pending', unavailable: true, price: 749000, acres: 331, county: 'Henry', state: 'TN' },
  },
  {
    name: 'landwatch-off-market',
    url: 'https://www.landwatch.com/knott-county-kentucky-recreational-property-for-sale/pid/425510193',
    want: { source: 'LandWatch', status: 'Off Market', statusKind: 'sold', unavailable: true, price: 130000, acres: 125, county: 'Knott', state: 'KY' },
  },
  {
    name: 'whitetail-for-sale',
    url: 'https://www.whitetailproperties.com/hunting-land/kentucky/graves/country-home-and-wooded-acreage-in-graves-county-ky',
    want: { source: 'WhitetailProperties', status: 'For Sale', statusKind: 'active', unavailable: false, price: 199900, acres: 7.094, county: 'Graves', state: 'KY' },
  },
  {
    name: 'whitetail-sold',
    url: 'https://www.whitetailproperties.com/hunting-land/missouri/dallas/194-acre-cattle-farm-with-quality-pasture-lake-extensive-improvements-and-home-in-conway-missouri',
    want: { source: 'WhitetailProperties', status: 'Sold', statusKind: 'sold', unavailable: true, price: null, acres: 194.18, county: 'Dallas', state: 'MO' },
  },
  {
    name: 'whitetail-pending',
    url: 'https://www.whitetailproperties.com/hunting-land/kentucky/breckinridge/small-property-with-large-opportunity',
    want: { source: 'WhitetailProperties', status: 'Pending Under Contract', statusKind: 'pending', unavailable: true, price: null, acres: 30.97, county: 'Breckinridge', state: 'KY' },
  },
  {
    name: 'mossyoak-nearby-under-contract',
    url: 'https://www.mossyoakproperties.com/property/oakridge-road-5-bowie-texas/96718/',
    want: { source: 'MossyOakProperties', status: 'Available', statusKind: 'active', unavailable: false, price: 205000, acres: 75, county: 'Bowie', state: 'TX' },
  },
  {
    name: 'mossyoak-under-contract',
    url: 'https://www.mossyoakproperties.com/property/120-acres-timber-with-trails-and-creek-clinton-ar-van-buren-county-van-buren-arkansas/110874/',
    want: { source: 'MossyOakProperties', status: 'Under Contract', statusKind: 'pending', unavailable: true, price: 250000, acres: 120, county: 'Van Buren', state: 'AR' },
  },
  {
    name: 'tuttland-active',
    url: 'https://www.tuttland.com/land-sale/alabama/bibb-county/730-ac-bibb-county-al-sportmans-paradisetimber-investment',
    want: { source: 'TuttLand', status: 'Active', statusKind: 'active', unavailable: false, price: 1995000, acres: 730, county: 'Bibb', state: 'AL' },
  },
  {
    name: 'nationalland-active',
    url: 'https://nationalland.com/listing/dempsey-road-hunting-tract',
    want: { source: 'NationalLandRealty', status: 'ACTIVE', statusKind: 'active', unavailable: false, price: 159500, acres: 58, county: 'Lamar', state: 'AL' },
  },
];

for (const c of CASES) {
  test(`readListingSubject: real ${c.name} page reads the subject listing`, () => {
    const r = readListingSubject(fixture(c.name), c.url);
    assert.equal(r.ok, true, r.note);
    for (const [key, value] of Object.entries(c.want)) {
      assert.equal(r[key], value, `${key}`);
    }
  });
}

test('readListingSubject: a LandWatch error shell is unreadable, never "available"', () => {
  const r = readListingSubject(fixture('landwatch-error-shell'),
    'https://www.landwatch.com/carroll-county-tennessee-undeveloped-land-for-sale/pid/424902515');
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, false);
  assert.equal(r.statusKind, null);
  assert.equal(r.acres, null);
  assert.match(r.note, /error shell/);
});

test('readListingSubject: a Mossy Oak "Nearby Properties" Under Contract badge is not the subject\'s status', () => {
  const html = fixture('mossyoak-nearby-under-contract');
  // The trap is really in the page: a whole-page scan finds "under contract".
  assert.ok(findAvailabilityMatches(visibleText(html)).includes('under contract'));
  const r = readListingSubject(html, 'https://www.mossyoakproperties.com/property/oakridge-road-5-bowie-texas/96718/');
  assert.equal(r.unavailable, false);
  assert.equal(r.status, 'Available');
});

test('readListingSubject: TuttLand\'s filter menu ("Under Contract Sold") never sets the status', () => {
  const html = fixture('tuttland-active');
  assert.match(visibleText(html), /Under Contract Sold/);
  const r = readListingSubject(html, 'https://www.tuttland.com/land-sale/alabama/bibb-county/730-ac-bibb-county-al-sportmans-paradisetimber-investment');
  assert.equal(r.unavailable, false);
  assert.equal(r.statusKind, 'active');
});

test('readListingSubject: TuttLand JSON-LD SoldOut wins over an "Active" panel badge', () => {
  const html = fixture('tuttland-active').replace('https://schema.org/InStock', 'https://schema.org/SoldOut');
  const r = readListingSubject(html, 'https://www.tuttland.com/land-sale/alabama/bibb-county/x');
  assert.equal(r.status, 'Sold');
  assert.equal(r.statusKind, 'sold');
  assert.equal(r.unavailable, true);
});

const TUTT_URL = 'https://www.tuttland.com/land-sale/alabama/bibb-county/730-ac-bibb-county-al-sportmans-paradisetimber-investment';

test('readListingSubject: TuttLand panel badge "Under Contract" flags the listing even when JSON-LD still says InStock', () => {
  const html = fixture('tuttland-active');
  assert.match(html, /schema\.org\/InStock/);
  const r = readListingSubject(html.replace('<strong>Active</strong>', '<strong>Under Contract</strong>'), TUTT_URL);
  assert.equal(r.status, 'Under Contract');
  assert.equal(r.statusKind, 'pending');
  assert.equal(r.unavailable, true);
  const sold = readListingSubject(html.replace('<strong>Active</strong>', '<strong>Sold</strong>'), TUTT_URL);
  assert.equal(sold.statusKind, 'sold');
});

test('readListingSubject: TuttLand with neither panel badge nor JSON-LD availability is status unknown, never active', () => {
  const html = fixture('tuttland-active')
    .replace('<strong>Active</strong>', '<strong></strong>')
    .replace(/"availability"\s*:\s*"[^"]*"/g, '"x":"y"')
    .replace(/https:\/\/schema\.org\/InStock/g, '');
  const r = readListingSubject(html, TUTT_URL);
  assert.equal(r.ok, true);
  assert.equal(r.status, null);
  assert.equal(r.statusKind, null);
  assert.equal(r.unavailable, false);
  assert.match(r.note, /status not shown/);
});

test('readListingSubject: LANDFLIP page without JSON-LD availability is status unknown', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'landflip-detail-420517.html'), 'utf8');
  const r = readListingSubject(html, 'https://www.landflip.com/land/420517');
  assert.equal(r.source, 'LANDFLIP');
  assert.equal(r.ok, true);
  assert.equal(r.statusKind, null);
  assert.match(r.note, /status not shown/);
});

test('readListingSubject: schema LimitedAvailability / PreOrder stay unknown (not guessed as Under Contract)', () => {
  for (const a of ['LimitedAvailability', 'PreOrder']) {
    const html = `<html><head><script type="application/ld+json">{"@type":"Product","offers":{"price":"250000","availability":"https://schema.org/${a}"}}</script></head>
      <body><h1>Creek Tract</h1><p>120 acres</p></body></html>`;
    const r = readListingSubject(html, 'https://example-land.com/listing/creek');
    assert.equal(r.status, null, a);
    assert.equal(r.statusKind, null, a);
  }
});

test('readListingSubject: generic site — on-page "Under Contract" / "SOLD -" wins over a stale JSON-LD InStock', () => {
  const ld = '<script type="application/ld+json">{"@type":"Product","offers":{"price":"250000","availability":"https://schema.org/InStock"}}</script>';
  const uc = readListingSubject(`<html><head>${ld}</head><body><h1>Creek Tract</h1><p>Under Contract. 120 acres.</p></body></html>`,
    'https://example-land.com/listing/creek');
  assert.equal(uc.statusKind, 'pending');
  assert.equal(uc.unavailable, true);
  const sold = readListingSubject(`<html><head><title>SOLD - Creek Tract</title>${ld}</head><body><p>120 acres.</p></body></html>`,
    'https://example-land.com/listing/creek');
  assert.equal(sold.statusKind, 'sold');
  const live = readListingSubject(`<html><head>${ld}</head><body><h1>Creek Tract</h1><p>120 acres.</p></body></html>`,
    'https://example-land.com/listing/creek');
  assert.equal(live.statusKind, 'active');
});

test('readListingSubject: generic site — a nearby-listings section is cut before reading', () => {
  const html = `<html><head><title>Ridge Tract</title></head><body>
    <h1>Ridge Tract</h1><p>160 acres of timber. Price $480,000.</p>
    <section class="nearby-listings"><h2>Nearby Properties</h2>
      <div>Under Contract — 12 acres</div><div>Under Contract — 12 acres</div><div>Sold — 12 acres</div>
    </section></body></html>`;
  const r = readListingSubject(html, 'https://example-land.com/listing/ridge-tract');
  assert.equal(r.source, 'generic');
  assert.equal(r.ok, true);
  assert.equal(r.unavailable, false);
  assert.equal(r.acres, 160);
});

test('readListingSubject: generic site — the subject\'s own "under contract" is still caught', () => {
  const r = readListingSubject('<html><body><h1>Tract</h1><p>160 acres. This property is under contract.</p></body></html>',
    'https://example-land.com/listing/1');
  assert.equal(r.ok, true);
  assert.equal(r.statusKind, 'pending');
  assert.equal(r.unavailable, true);
});

test('readListingSubject: generic site — JSON-LD availability beats page text', () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Product","name":"80 acres","offers":{"price":"200000","availability":"https://schema.org/SoldOut"}}</script></head>
    <body><h1>Tract</h1><p>80 acres, all clear.</p></body></html>`;
  const r = readListingSubject(html, 'https://example-land.com/listing/2');
  assert.equal(r.status, 'Sold');
  assert.equal(r.price, 200000);
  assert.equal(r.acres, 80);
});

test('readListingSubject: a page with no price, acreage or status is unreadable', () => {
  const r = readListingSubject('<html><body><div id="root"></div></body></html>', 'https://example-land.com/x');
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, false);
  assert.equal(readListingSubject('', 'https://www.landwatch.com/x').ok, false);
});

test('classifyStatus maps each site\'s status words', () => {
  const table = {
    Available: 'active', 'For Sale': 'active', 'New Listing': 'active', Reduced: 'active', New: 'active', ACTIVE: 'active',
    'Under Contract': 'pending', 'Pending Under Contract': 'pending', PENDING: 'pending', 'sale pending': 'pending',
    Sold: 'sold', SOLD: 'sold', 'Off Market': 'sold', 'off-market': 'sold', 'no longer available': 'sold',
  };
  for (const [word, kind] of Object.entries(table)) assert.equal(classifyStatus(word), kind, word);
  assert.equal(classifyStatus(null), null);
  assert.equal(classifyStatus('Something Else'), null);
});

test('detectSource picks the reader by hostname', () => {
  assert.equal(detectSource('https://www.landwatch.com/x'), 'LandWatch');
  assert.equal(detectSource('https://www.whitetailproperties.com/x'), 'WhitetailProperties');
  assert.equal(detectSource('https://www.mossyoakproperties.com/x'), 'MossyOakProperties');
  assert.equal(detectSource('https://nationalland.com/listing/x'), 'NationalLandRealty');
  assert.equal(detectSource('https://www.tuttland.com/x'), 'TuttLand');
  assert.equal(detectSource('https://www.landflip.com/land/1'), 'LANDFLIP');
  assert.equal(detectSource('https://www.landandfarm.com/x'), 'LandAndFarm');
  assert.equal(detectSource('https://example.com/x'), 'generic');
  assert.equal(detectSource('not a url'), 'generic');
});

test('LANDFLIP: real detail page reads price/acres/county from its own blocks', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'landflip-detail-420517.html'), 'utf8');
  const r = readListingSubject(html, 'https://www.landflip.com/land/420517');
  assert.equal(r.source, 'LANDFLIP');
  assert.equal(r.ok, true);
  assert.equal(r.price, 489900);
  assert.equal(r.acres, 11);
  assert.equal(r.county, 'Taylor');
  assert.equal(r.state, 'KY');
  // No JSON-LD availability and no status phrase in the subject's own text:
  // status unknown (never "available").
  assert.equal(r.statusKind, null);
  assert.equal(r.unavailable, false);
});

const LANDFLIP_URL = 'https://www.landflip.com/land/420517';
const landflipFixture = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'landflip-detail-420517.html'), 'utf8');

test('LANDFLIP: "Under Contract" in the subject\'s title or h1 is read, though JSON-LD has no availability', () => {
  const html = landflipFixture();
  const inTitle = readListingSubject(
    html.replace('<title>Campbellsville KY Barndominium,', '<title>Under Contract - Campbellsville KY Barndominium,'), LANDFLIP_URL);
  assert.equal(inTitle.statusKind, 'pending');
  assert.equal(inTitle.unavailable, true);
  assert.equal(inTitle.price, 489900);
  assert.equal(inTitle.acres, 11);

  const inH1 = readListingSubject(
    html.replace('<h1>Campbellsville KY Barndominium</h1>', '<h1>Campbellsville KY Barndominium (Under Contract)</h1>'), LANDFLIP_URL);
  assert.equal(inH1.statusKind, 'pending');

  const soldH1 = readListingSubject(
    html.replace('<h1>Campbellsville KY Barndominium</h1>', '<h1>SOLD - Campbellsville KY Barndominium</h1>'), LANDFLIP_URL);
  assert.equal(soldH1.statusKind, 'sold');

  const inMeta = readListingSubject(
    html.replace('<meta name="description" content="Campbellsville KY Barndominium.', '<meta name="description" content="Campbellsville KY Barndominium. Off market.'), LANDFLIP_URL);
  assert.equal(inMeta.statusKind, 'sold');
});

test('LANDFLIP: "Under Contract" only in a Similar Listings section is not the subject\'s status', () => {
  const html = landflipFixture().replace('</body>',
    '<h2>Similar Listings</h2><div class="card"><h3>Green River 40 Acres</h3><span>Under Contract</span></div></body>');
  const r = readListingSubject(html, LANDFLIP_URL);
  assert.equal(r.statusKind, null);
  assert.equal(r.unavailable, false);
});

test('LandAndFarm: subject-scoped text "Under Contract" is read when JSON-LD has no availability', () => {
  const html = '<html><head><title>120 Acres in Adair County, KY | Land and Farm</title></head>'
    + '<body><h1>120 Acres Creek Tract - Under Contract</h1><p>$360,000. 120 acres of timber.</p>'
    + '<section class="similar-properties"><p>Sold - 80 acres</p></section></body></html>';
  const r = readListingSubject(html, 'https://www.landandfarm.com/property/120-acres-in-adair-county-kentucky/123/');
  assert.equal(r.source, 'LandAndFarm');
  assert.equal(r.statusKind, 'pending');
  assert.equal(r.acres, 120);
  const live = readListingSubject(html.replace(' - Under Contract', ''), 'https://www.landandfarm.com/property/x/123/');
  assert.equal(live.statusKind, null, 'the Similar section\'s "Sold" is not the subject\'s');
});

test('National Land without its ACTIVE header: subject-scoped text status is read', () => {
  const html = '<html><head><title>SOLD - 58 Acres in Lamar County, Alabama</title></head>'
    + '<body><p>58 +/- acres of hunting land. $159,500</p></body></html>';
  const r = readListingSubject(html, 'https://nationalland.com/listing/58-acres-lamar');
  assert.equal(r.source, 'NationalLandRealty');
  assert.equal(r.statusKind, 'sold');
});
