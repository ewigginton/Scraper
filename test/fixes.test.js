'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { initFilter, filterListing, getCPATarget } = require('../lib/filter');
const { generateFingerprint, locationKey, roundTo } = require('../lib/fingerprint');
const { extractPrice, parsePriceText, mergeNoteEntry } = require('../lib/price-checker');
const { matchesKeyword, analyzeLead, runReview } = require('../lib/review');
const { parseFloodResponse, parseCoordinateString, isHighRiskZone } = require('../lib/flood');
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

test('checkDuplicate flags (but does not drop) same-location similar-price listings', () => {
  // Might be the same tract at $300,000 on one site and $289,000 on another —
  // or two sibling tracts. It is written with a warning, never silently skipped.
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
  assert.equal(result.isDuplicate, false, 'suspected cross-site matches must still be written');
  assert.match(result.suspectedCrossSite, /Possible cross-site duplicate/);
});

test('checkDuplicate does not even flag similar-size tracts at clearly different prices', () => {
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
  assert.equal(result.suspectedCrossSite, undefined);
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

test('keyword matching uses word boundaries — availability phrases match, unrelated prose does not', () => {
  assert.equal(matchesKeyword('property is under contract', 'under contract'), true);
  assert.equal(matchesKeyword('this tract is now off-market', 'off-market'), true);
  assert.equal(matchesKeyword('open pasture with no restrictions', 'under contract'), false);
});

// ---------- availability-status flags ----------

test('analyzeLead flags "under contract" as availability, NOT a dealbreaker, and never auto-rejects', () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    fields: {
      Name: 'Pending Tract',
      'Scraper Notes': 'Beautiful rolling pasture. This property is under contract as of last week.',
      Acres: 200,
      '$/A': 3000,
      County: 'Taney',
      State: 'MO',
    },
  };
  const analysis = analyzeLead(record);
  assert.ok(
    analysis.availabilityFlags.some(f => f.includes('under contract')),
    `expected an availability flag, got: ${analysis.availabilityFlags}`
  );
  assert.deepEqual(analysis.dealbreakers, [], 'availability status must never count as a dealbreaker');
  assert.equal(analysis.yellowFlags.length, 0, 'availability status is not a yellow flag either');
});

test('analyzeLead: bare "sold"/"contingent" removed — comp/closing prose does not raise an availability flag', () => {
  // 'sold' and 'contingent' were dropped from AVAILABILITY_FLAGS because they
  // false-positive on ordinary comp/closing prose that describes NEIGHBORING
  // sales or a closing condition, not this listing's own status.
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    fields: {
      Name: 'Comp Prose Tract',
      'Scraper Notes': 'Similar tracts have sold for $3,000/acre. Access is contingent upon a completed survey.',
      Acres: 200,
      '$/A': 3000,
      County: 'Taney',
      State: 'MO',
    },
  };
  const analysis = analyzeLead(record);
  assert.deepEqual(analysis.availabilityFlags, [], 'comp/closing prose must not raise an availability flag');
});

test('runReview surfaces an availability flag in report.flagged without touching Stage', async (t) => {
  const { FIELDS, STAGES } = airtable;
  const record = {
    id: 'recAvail0000001X',
    fields: {
      Name: 'Under Contract Tract',
      Stage: STAGES.newLead,
      [FIELDS.price]: 200000,
      [FIELDS.acres]: 100,
      [FIELDS.notes]: 'Nice tract. Sale pending as of this week.',
      [FIELDS.created]: new Date().toISOString(),
    },
  };
  const original = {
    getRecordsByStage: airtable.getRecordsByStage,
    resolveCountyFields: airtable.resolveCountyFields,
    updateRecord: airtable.updateRecord,
  };
  const updates = [];
  airtable.getRecordsByStage = async stage => (stage === STAGES.newLead ? [record] : []);
  airtable.resolveCountyFields = () => ({ county: 'Taney', state: 'MO' });
  airtable.updateRecord = async (recordId, fields) => { updates.push({ recordId, fields }); return { id: recordId }; };
  t.after(() => Object.assign(airtable, original));

  initFilter(new Map([['taney|MO', 4000]]));
  const report = await runReview();

  assert.equal(report.flagged.length, 1);
  assert.ok(report.flagged[0].flags.some(f => f.includes('sale pending')));
  for (const u of updates) assert.equal('Stage' in u.fields, false, 'review must never write Stage');
});

test('runReview: a 600ac lead below standout score still lands in report.largeTracts', async (t) => {
  const { FIELDS, STAGES } = airtable;
  const record = {
    id: 'recLarge0000001X',
    fields: {
      Name: 'Big Bend Ranch',
      Stage: STAGES.newLead,
      [FIELDS.price]: 1800000,
      [FIELDS.acres]: 600, // > preferredAcresMax (400) — no sweet-spot bonus, won't standout
      [FIELDS.notes]: '',
      [FIELDS.created]: new Date().toISOString(),
    },
  };
  const original = {
    getRecordsByStage: airtable.getRecordsByStage,
    resolveCountyFields: airtable.resolveCountyFields,
    updateRecord: airtable.updateRecord,
  };
  const updates = [];
  airtable.getRecordsByStage = async stage => (stage === STAGES.newLead ? [record] : []);
  airtable.resolveCountyFields = () => ({ county: 'Taney', state: 'MO' });
  airtable.updateRecord = async (recordId, fields) => { updates.push({ recordId, fields }); return { id: recordId }; };
  t.after(() => Object.assign(airtable, original));

  initFilter(new Map([['taney|MO', 4000]]));
  const report = await runReview();

  assert.equal(report.standouts.length, 0, 'a 600ac tract scores below standout — must not appear there');
  assert.equal(report.largeTracts.length, 1);
  assert.equal(report.largeTracts[0].name, 'Big Bend Ranch');
  assert.equal(report.largeTracts[0].acres, 600);
  assert.equal(report.largeTractHighlightMin, 500);
});

test('runReview: a 300ac lead does not appear in report.largeTracts', async (t) => {
  const { FIELDS, STAGES } = airtable;
  const record = {
    id: 'recSmall0000001X',
    fields: {
      Name: 'Modest Tract',
      Stage: STAGES.newLead,
      [FIELDS.price]: 900000,
      [FIELDS.acres]: 300,
      [FIELDS.notes]: '',
      [FIELDS.created]: new Date().toISOString(),
    },
  };
  const original = {
    getRecordsByStage: airtable.getRecordsByStage,
    resolveCountyFields: airtable.resolveCountyFields,
    updateRecord: airtable.updateRecord,
  };
  airtable.getRecordsByStage = async stage => (stage === STAGES.newLead ? [record] : []);
  airtable.resolveCountyFields = () => ({ county: 'Taney', state: 'MO' });
  airtable.updateRecord = async () => ({ id: 'x' });
  t.after(() => Object.assign(airtable, original));

  initFilter(new Map([['taney|MO', 4000]]));
  const report = await runReview();

  assert.equal(report.largeTracts.length, 0);
});

test('runReview: largeTractHighlightMin setting override is respected', async (t) => {
  const { FIELDS, STAGES } = airtable;
  const record = {
    id: 'recOverride00001X',
    fields: {
      Name: 'Override Tract',
      Stage: STAGES.newLead,
      [FIELDS.price]: 750000,
      [FIELDS.acres]: 300, // below the 500 default, above a 250 override
      [FIELDS.notes]: '',
      [FIELDS.created]: new Date().toISOString(),
    },
  };
  const original = {
    getRecordsByStage: airtable.getRecordsByStage,
    resolveCountyFields: airtable.resolveCountyFields,
    updateRecord: airtable.updateRecord,
  };
  airtable.getRecordsByStage = async stage => (stage === STAGES.newLead ? [record] : []);
  airtable.resolveCountyFields = () => ({ county: 'Taney', state: 'MO' });
  airtable.updateRecord = async () => ({ id: 'x' });
  t.after(() => Object.assign(airtable, original));

  const settings = require('../config/settings.json');
  const originalMin = settings.review.largeTractHighlightMin;
  settings.review.largeTractHighlightMin = 250;
  t.after(() => { settings.review.largeTractHighlightMin = originalMin; });

  initFilter(new Map([['taney|MO', 4000]]));
  const report = await runReview();

  assert.equal(report.largeTractHighlightMin, 250);
  assert.equal(report.largeTracts.length, 1);
  assert.equal(report.largeTracts[0].name, 'Override Tract');
});

test('"no road noise" does not trip a road-access dealbreaker', () => {
  const record = {
    fields: {
      Name: 'Quiet Tract',
      'Scraper Notes': 'Peaceful setting with no road noise. Paved road frontage.',
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
      'Scraper Notes': '',
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

// ---------- property-note merging (price-cut messages in Airtable) ----------

test('mergeNoteEntry inserts above the AUTO ANALYSIS marker so review does not wipe it', () => {
  const existing = 'Emma: called agent 6/1\n\n--- AUTO ANALYSIS ---\nScore: ★★★☆☆';
  const merged = mergeNoteEntry(existing, '[2026-07-06] ⬆️ PRICE DROP: $500,000 → $450,000');
  const [above] = merged.split('--- AUTO ANALYSIS ---');
  assert.match(above, /PRICE DROP/);
  assert.match(above, /called agent/);
  assert.match(merged, /Score: ★★★☆☆/);
});

test('mergeNoteEntry appends cleanly when no marker exists', () => {
  const merged = mergeNoteEntry('', '[2026-07-06] Price drop: $100,000 → $95,000');
  assert.equal(merged, '[2026-07-06] Price drop: $100,000 → $95,000');
});

// ---------- FEMA flood ----------

test('isHighRiskZone classifies A/V zones as high risk, X/NONE as not', () => {
  for (const zone of ['A', 'AE', 'AH', 'AO', 'A99', 'V', 'VE']) {
    assert.equal(isHighRiskZone(zone), true, `${zone} should be high risk`);
  }
  for (const zone of ['X', 'D', 'NONE', '', null]) {
    assert.equal(isHighRiskZone(zone), false, `${zone} should not be high risk`);
  }
});

test('parseFloodResponse handles hit, miss, and malformed responses', () => {
  const hit = parseFloodResponse({ features: [{ attributes: { FLD_ZONE: 'AE', ZONE_SUBTY: 'FLOODWAY' } }] });
  assert.equal(hit.zone, 'AE');
  assert.equal(hit.isHighRisk, true);

  const preferHighRisk = parseFloodResponse({
    features: [
      { attributes: { FLD_ZONE: 'X' } },
      { attributes: { FLD_ZONE: 'AE' } },
    ],
  });
  assert.equal(preferHighRisk.zone, 'AE');

  const miss = parseFloodResponse({ features: [] });
  assert.equal(miss.zone, 'NONE');
  assert.equal(miss.isHighRisk, false);
  assert.equal(miss.mapped, false);

  assert.equal(parseFloodResponse(null), null);
  assert.equal(parseFloodResponse({ error: { message: 'boom' } }), null);
});

test('parseCoordinateString parses the Airtable Coordinate format and rejects junk', () => {
  assert.deepEqual(parseCoordinateString('36.84, -84.85'), { lat: 36.84, lng: -84.85 });
  assert.equal(parseCoordinateString(''), null);
  assert.equal(parseCoordinateString('not coords'), null);
  assert.equal(parseCoordinateString('51.5, -0.1'), null); // outside continental US
});

test('a high-risk flood zone becomes a yellow flag in lead analysis', () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    fields: {
      Name: 'River Tract',
      'Scraper Notes': 'Nice bottomland.',
      Acres: 200,
      '$/A': 3500,
      County: 'Taney',
      State: 'MO',
    },
  };
  const flood = { zone: 'AE', isHighRisk: true, mapped: true };
  const analysis = analyzeLead(record, { flood });
  assert.ok(analysis.yellowFlags.some(f => f.includes('fema flood zone ae')), `flags: ${analysis.yellowFlags}`);
  assert.equal(analysis.flood.zone, 'AE');

  // and a minimal-hazard zone does not add a flag
  const safeAnalysis = analyzeLead(record, { flood: { zone: 'NONE', isHighRisk: false, mapped: false } });
  assert.ok(!safeAnalysis.yellowFlags.some(f => f.includes('fema')));
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
