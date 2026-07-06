'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { initFilter, filterListing, getCPATarget } = require('../lib/filter');
const { generateFingerprint, locationKey, roundTo } = require('../lib/fingerprint');
const { extractPrice, parsePriceText } = require('../lib/price-checker');
const { matchesKeyword, analyzeLead } = require('../lib/review');
const airtable = require('../lib/airtable');
const localStore = require('../lib/local-store');

// ---------- filter boundaries ----------

function makeCountyMap() {
  return new Map([['taney|MO', 4000]]);
}

function listingAt(cpa) {
  return {
    name: 'Boundary Test',
    price: cpa * 100,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: `https://example.com/${cpa}`,
  };
}

test('filter accepts exactly 20% over as New Lead (inclusive boundary)', () => {
  initFilter(makeCountyMap());
  const result = filterListing(listingAt(4800)); // exactly +20%
  assert.equal(result.passed, true);
  assert.equal(result.stage, 'New Lead');
});

test('filter accepts exactly 30% over as Watch (inclusive boundary)', () => {
  initFilter(makeCountyMap());
  const result = filterListing(listingAt(5200)); // exactly +30%
  assert.equal(result.passed, true);
  assert.equal(result.stage, 'Watch For Price Drop');
});

test('filter rejects just past 30% over', () => {
  initFilter(makeCountyMap());
  const result = filterListing({ ...listingAt(5200), price: 520001 }); // one dollar past +30%
  assert.equal(result.passed, false);
});

test('getCPATarget resolves "Wayne County" / full state name via normalization', () => {
  initFilter(new Map([['wayne|KY', 2500]]));
  assert.equal(getCPATarget('Wayne', 'KY'), 2500);
  assert.equal(getCPATarget('Wayne County', 'KY'), 2500);
  assert.equal(getCPATarget('Wayne County', 'Kentucky'), 2500);
  assert.equal(getCPATarget('Pulaski', 'KY'), null);
});

// ---------- price extraction ----------

test('parsePriceText rejects per-acre figures', () => {
  assert.equal(parsePriceText('$3,500/acre'), null);
  assert.equal(parsePriceText('$3,500/AC'), null);
  assert.equal(parsePriceText('$3,500 per acre'), null);
});

test('parsePriceText rejects price ranges', () => {
  assert.equal(parsePriceText('$100,000 - $150,000'), null);
  assert.equal(parsePriceText('$100,000 to $150,000'), null);
});

test('parsePriceText parses a normal price', () => {
  assert.equal(parsePriceText('$1,250,000'), 1250000);
  assert.equal(parsePriceText('450000'), 450000);
});

test('extractPrice does not return a per-acre figure as the total price', () => {
  const html = '<html><body><div class="price">$3,500/acre</div></body></html>';
  assert.equal(extractPrice(html), null);
});

test('extractPrice prefers JSON-LD structured data', () => {
  const html = `
    <html><head>
      <script type="application/ld+json">{"@type":"Product","offers":{"price":"485000"}}</script>
    </head><body><div class="price">$3,500/acre</div></body></html>`;
  assert.equal(extractPrice(html), 485000);
});

// ---------- fingerprint / dedup ----------

test('roundTo never rounds a real value into a falsy zero bucket', () => {
  assert.equal(roundTo(2000, 5000), 5000);
  assert.ok(generateFingerprint({ county: 'Taney', state: 'MO', acres: 42, price: 2000 }) !== null);
});

test('locationKey buckets acreage and normalizes county', () => {
  assert.equal(
    locationKey('Taney County', 'mo', 151),
    locationKey('Taney', 'MO', 149)
  );
});

test('checkDuplicate catches same property at a different price bucket via location match', () => {
  // Same tract: $300,000 on one site (already in Airtable), $289,000 on another.
  // Fingerprints differ ($5k buckets), but location + 10% price tolerance matches.
  const existing = { county: 'Taney', state: 'MO', acres: 100, price: 300000 };
  const incoming = {
    county: 'Taney County',
    state: 'MO',
    acres: 100,
    price: 289000,
    url: 'https://other-site.com/listing',
  };
  assert.notEqual(generateFingerprint(existing), generateFingerprint(incoming));

  const locationMap = new Map();
  airtable.addToLocationMap(locationMap, existing);
  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set(), locationMap };

  const result = airtable.checkDuplicate(incoming, dedupIndex);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'location-price');
});

test('checkDuplicate does NOT merge different tracts of similar size at different prices', () => {
  const existing = { county: 'Taney', state: 'MO', acres: 100, price: 300000 };
  const different = {
    county: 'Taney',
    state: 'MO',
    acres: 100,
    price: 220000, // 27% apart — a different property
    url: 'https://other-site.com/different',
  };
  const locationMap = new Map();
  airtable.addToLocationMap(locationMap, existing);
  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set(), locationMap };

  const result = airtable.checkDuplicate(different, dedupIndex);
  assert.equal(result.isDuplicate, false);
});

// ---------- retry classification ----------

test('isRetryableError: 4xx (except 429) is not retryable, 429/5xx/network is', () => {
  assert.equal(airtable.isRetryableError({ statusCode: 422 }), false);
  assert.equal(airtable.isRetryableError({ statusCode: 403 }), false);
  assert.equal(airtable.isRetryableError({ statusCode: 429 }), true);
  assert.equal(airtable.isRetryableError({ statusCode: 503 }), true);
  assert.equal(airtable.isRetryableError(new Error('socket hang up')), true);
});

test('escapeFormulaValue escapes single quotes', () => {
  assert.equal(airtable.escapeFormulaValue("O'Brien"), "O\\'Brien");
});

// ---------- review keyword matching ----------

test('keyword matching uses word boundaries — "Shoal Creek" is not an HOA', () => {
  assert.equal(matchesKeyword('beautiful land near shoal creek', 'hoa'), false);
  assert.equal(matchesKeyword('property has an hoa with fees', 'hoa'), true);
});

test('"no road noise" does not trip a road-access dealbreaker', () => {
  const record = {
    fields: {
      Name: 'Quiet Tract',
      'Property Notes': 'Peaceful setting with no road noise. Paved road frontage.',
      Acres: 200,
      '$/A': 3000,
      County: 'Taney',
      State: 'MO',
    },
  };
  initFilter(new Map([['taney|MO', 4000]]));
  const analysis = analyzeLead(record);
  assert.deepEqual(analysis.dealbreakers, []);
});

test('missing $/A scores as unknown, not as an excellent price', () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    fields: {
      Name: 'No CPA',
      'Property Notes': '',
      Acres: 200,
      '$/A': 0,
      County: 'Taney',
      State: 'MO',
    },
  };
  const analysis = analyzeLead(record);
  assert.equal(analysis.priceClass, 'unknown');
  assert.equal(analysis.overPercent, null);
});

// ---------- failed-write replay queue ----------

test('failed writes can be loaded for replay and archived exactly once', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-replay-'));
  const originalDataDir = process.env.SCRAPER_DATA_DIR;
  process.env.SCRAPER_DATA_DIR = tmpDir;

  try {
    const listings = [
      { name: 'Queued A', url: 'https://example.com/a', price: 100000, acres: 50, county: 'Taney', state: 'MO' },
      { name: 'Queued B', url: 'https://example.com/b', price: 200000, acres: 80, county: 'Taney', state: 'MO' },
    ];
    const filePath = localStore.persistFailedListings(listings, { table: 'Leads', operation: 'create', error: 'test' });
    assert.ok(fs.existsSync(filePath));

    const pending = localStore.loadPendingFailedWrites();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].listings.length, 2);
    assert.equal(pending[0].listings[0].name, 'Queued A');

    localStore.archiveFailedWrites(pending[0].filePath);
    assert.equal(localStore.loadPendingFailedWrites().length, 0, 'archived file must not be replayed again');
    const doneDir = path.join(tmpDir, 'failed-writes', 'done');
    assert.equal(fs.readdirSync(doneDir).length, 1);
  } finally {
    if (originalDataDir === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('corrupt lines in a failed-write file are skipped, valid ones survive', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-replay-'));
  const originalDataDir = process.env.SCRAPER_DATA_DIR;
  process.env.SCRAPER_DATA_DIR = tmpDir;

  try {
    const dir = path.join(tmpDir, 'failed-writes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), [
      JSON.stringify({ savedAt: 'x', context: {}, listing: { name: 'Good', url: 'https://example.com/good' } }),
      '{ this is not json',
      JSON.stringify({ savedAt: 'x', context: {}, listing: { name: 'Also Good', url: 'https://example.com/also' } }),
    ].join('\n') + '\n');

    const pending = localStore.loadPendingFailedWrites();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].listings.length, 2);
  } finally {
    if (originalDataDir === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
