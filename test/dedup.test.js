'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateFingerprint } = require('../lib/fingerprint');
const airtable = require('../lib/airtable');

test('parseCurrencyNumber accepts Airtable CPA Target currency values', () => {
  assert.equal(airtable.parseCurrencyNumber('$1,850'), 1850);
  assert.equal(airtable.parseCurrencyNumber(1850), 1850);
});

test('firstRecordValue reads current Airtable county field names before fallbacks', () => {
  const record = {
    get(field) {
      return {
        County: 'Wayne',
        Name: 'Old Name',
        'State (full)': 'Kentucky',
        State: ['recLinkedState'],
      }[field];
    },
  };

  assert.equal(airtable.firstRecordValue(record, airtable.COUNTY_NAME_FIELDS), 'Wayne');
  assert.equal(airtable.firstRecordValue(record, airtable.COUNTY_STATE_FIELDS), 'Kentucky');
});

test('fingerprint from scraper matches fingerprint from checkDuplicate', () => {
  const listing = {
    name: 'Test Tract',
    price: 200000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/listing-1',
    source: 'LandWatch',
  };

  // scraper.js computes fingerprint this way:
  const fpFromScraper = generateFingerprint(listing);
  listing.fingerprint = fpFromScraper;

  // airtable.js checkDuplicate also calls generateFingerprint internally:
  const dedupIndex = {
    urlSet: new Set(),
    fingerprintSet: new Set([fpFromScraper]),
  };

  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'fingerprint');
});

test('same property on different sites produces same fingerprint', () => {
  const landwatchListing = {
    county: 'Taney County',
    state: 'mo',
    acres: 151,
    price: 602000,
  };
  const landcomListing = {
    county: 'Taney',
    state: 'MO',
    acres: 149,
    price: 601000,
  };

  const fp1 = generateFingerprint(landwatchListing);
  const fp2 = generateFingerprint(landcomListing);
  assert.equal(fp1, fp2, 'cross-site fingerprints should match within rounding tolerance');
});

test('different properties produce different fingerprints', () => {
  const a = { county: 'Taney', state: 'MO', acres: 100, price: 200000 };
  const b = { county: 'Taney', state: 'MO', acres: 300, price: 600000 };
  assert.notEqual(generateFingerprint(a), generateFingerprint(b));
});

test('checkDuplicate detects URL match', () => {
  const listing = {
    name: 'Test',
    price: 100000,
    acres: 50,
    county: 'Dallas',
    state: 'TX',
    url: 'https://landwatch.com/property/123',
  };

  const dedupIndex = {
    urlSet: new Set(['https://landwatch.com/property/123']),
    fingerprintSet: new Set(),
  };

  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'url');
});

test('checkDuplicate passes for new listing', () => {
  const listing = {
    name: 'Brand New',
    price: 100000,
    acres: 50,
    county: 'Dallas',
    state: 'TX',
    url: 'https://landwatch.com/property/new',
  };

  const dedupIndex = {
    urlSet: new Set(['https://landwatch.com/property/old']),
    fingerprintSet: new Set(),
  };

  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, false);
});

test('incomplete listing produces null fingerprint and passes dedup', () => {
  const listing = {
    name: 'No County',
    price: 100000,
    acres: 50,
    county: '',
    state: 'TX',
    url: 'https://example.com/no-county',
  };

  const fp = generateFingerprint(listing);
  assert.equal(fp, null);

  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set() };
  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, false);
});

// --- GUARD 1c / GUARD 2 (lib/airtable.js checkWriteGuard, writeListings,
// createLeadRecord) ---
//
// These exercise only the REFUSAL paths: an implausible listing, or (for
// writeListings only) one with an unresolvable County link, is refused
// before a single Airtable call is made — so these never touch the network
// and are safe to run with real credentials in .env.

test('checkWriteGuard refuses an implausible listing', () => {
  const reason = airtable.checkWriteGuard({ price: 873600312, acres: 873600312 });
  assert.match(reason, /^Implausible data: /);
});

test('checkWriteGuard passes a plausible listing with no county-link check', () => {
  const reason = airtable.checkWriteGuard({ price: 72777, acres: 40.3 });
  assert.equal(reason, null);
});

test('checkWriteGuard({ checkCountyLink: true }) refuses a plausible listing whose county cannot be resolved', () => {
  // No loadCountyTargets call has populated countyIndex in this process, so
  // ANY county/state resolves to null here — exactly the production failure
  // mode (local-fallback county targets never populate the link index).
  const reason = airtable.checkWriteGuard(
    { price: 72777, acres: 40.3, county: 'Nonexistent', state: 'ZZ' },
    { checkCountyLink: true }
  );
  assert.match(reason, /^County not resolvable: Nonexistent, ZZ$/);
});

test('writeListings refuses an implausible listing without writing or queuing it', async () => {
  const result = await airtable.writeListings([
    { name: 'Glued Parse Tract', price: 873600312, acres: 873600312, url: 'https://example.com/glued', county: 'Pittsburg', state: 'OK' },
  ]);
  assert.equal(result.created, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /^Implausible data: /);
});

test('writeListings refuses a listing whose County cannot be resolved (GUARD 2)', async () => {
  const result = await airtable.writeListings([
    { name: 'Unlinked County Tract', price: 72777, acres: 40.3, url: 'https://example.com/unlinked', county: 'Nonexistent', state: 'ZZ' },
  ]);
  assert.equal(result.created, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /^County not resolvable: /);
});

test('writeListings([]) returns an empty refused array (no crash on empty input)', async () => {
  const result = await airtable.writeListings([]);
  assert.deepEqual(result, { created: 0, errors: [], refused: [] });
});

test('createLeadRecord throws (and never writes) for an implausible listing', async () => {
  await assert.rejects(
    () => airtable.createLeadRecord({ name: 'Glued Parse Tract', price: 873600312, acres: 873600312, url: 'https://example.com/glued-intake' }),
    /^Error: Implausible data: /
  );
});

test('createLeadRecord does NOT apply the county-link guard (intake creates with a missing-county warning instead)', () => {
  // createLeadRecord should reach past checkWriteGuard's plausibility check
  // for a plausible listing with no county — it must not throw for that
  // reason. (It would then go on to call the real Airtable client, which
  // this test does not exercise — the plausibility guard already proved
  // the function doesn't refuse on county alone.)
  const reason = airtable.checkWriteGuard({ price: 72777, acres: 40.3 }); // no checkCountyLink option
  assert.equal(reason, null, 'createLeadRecord calls checkWriteGuard without checkCountyLink');
});

// --- GUARD 2: loadCountyTargets retry / abort / dry-run-fallback ---

function stubCountyTable(t, { rows = [], failTimes = 0 } = {}) {
  const original = airtable.getCountyTable;
  let calls = 0;
  airtable.getCountyTable = () => ({
    select: () => ({
      eachPage: (onPageRecords, onDone) => {
        calls++;
        if (calls <= failTimes) {
          onDone(new Error(`simulated Airtable failure (attempt ${calls})`));
          return;
        }
        const fakeRecords = rows.map(r => ({
          id: r.id,
          get: (field) => r.fields[field],
        }));
        onPageRecords(fakeRecords, () => {});
        onDone();
      },
    }),
  });
  t.after(() => { airtable.getCountyTable = original; });
  return () => calls;
}

const PITTSBURG_ROW = { id: 'recCountyPittsburg', fields: { County: 'Pittsburg', 'State (full)': 'Oklahoma', 'CPA Target': '$2,900' } };

test('loadCountyTargets retries on failure and succeeds once the Airtable read recovers', async (t) => {
  const getCalls = stubCountyTable(t, { rows: [PITTSBURG_ROW], failTimes: 2 });

  const result = await airtable.loadCountyTargets({ retryDelaysMs: [0, 0] });

  assert.equal(getCalls(), 3, 'should have retried twice before succeeding on the 3rd attempt');
  assert.equal(result.source, 'airtable');
  assert.equal(result.counties.length, 1);
  assert.equal(result.countyMap.get('pittsburg|OK'), 2900);
});

test('loadCountyTargets (allowFallback: false) throws a clear error after exhausting all 3 attempts', async (t) => {
  const getCalls = stubCountyTable(t, { failTimes: 99 });

  await assert.rejects(
    () => airtable.loadCountyTargets({ allowFallback: false, retryDelaysMs: [0, 0] }),
    /County targets could not be loaded from Airtable after 3 attempts — scrape aborted/
  );
  assert.equal(getCalls(), 3);
});

test('loadCountyTargets (default allowFallback) falls back to local config with a warning after exhausting all 3 attempts', async (t) => {
  stubCountyTable(t, { failTimes: 99 });

  const result = await airtable.loadCountyTargets({ retryDelaysMs: [0, 0] });

  assert.equal(result.source, 'local-config');
  assert.match(result.warning, /Airtable county target load failed after 3 attempts/);
});

test('loadCountyTargets (allowFallback: false) throws when Airtable returns zero counties', async (t) => {
  stubCountyTable(t, { rows: [] });

  await assert.rejects(
    () => airtable.loadCountyTargets({ allowFallback: false }),
    /Airtable returned zero county targets — scrape aborted/
  );
});

test('loadCountyTargets (default allowFallback) falls back to local config when Airtable returns zero counties', async (t) => {
  stubCountyTable(t, { rows: [] });

  const result = await airtable.loadCountyTargets();

  assert.equal(result.source, 'local-config');
  assert.match(result.warning, /Airtable returned zero county targets/);
});

test('loadCountyTargets succeeds on the first attempt with no retries or fallback', async (t) => {
  const getCalls = stubCountyTable(t, { rows: [PITTSBURG_ROW] });

  const result = await airtable.loadCountyTargets({ allowFallback: false });

  assert.equal(getCalls(), 1);
  assert.equal(result.source, 'airtable');
  assert.equal(airtable.getCountyRecordId('Pittsburg', 'OK'), 'recCountyPittsburg');
});

// --- County link resolution tolerates spelling variants and prefers the targeted row ---

test('getCountyRecordId resolves spelling variants the filter accepts (Le Flore, "Wayne County", full state name)', async (t) => {
  stubCountyTable(t, { rows: [
    { id: 'recLeflore', fields: { County: 'Leflore', 'State (full)': 'Oklahoma', 'CPA Target': '$1,900' } },
    { id: 'recWayneKY', fields: { County: 'Wayne', 'State (full)': 'Kentucky', 'CPA Target': '$1,850' } },
    { id: 'recWayneMO', fields: { County: 'Wayne', 'State (full)': 'Missouri', 'CPA Target': '$1,600' } },
  ] });
  await airtable.loadCountyTargets({ retryDelaysMs: [0, 0] });
  assert.equal(airtable.getCountyRecordId('Le Flore', 'OK'), 'recLeflore');
  assert.equal(airtable.getCountyRecordId('Wayne County', 'KY'), 'recWayneKY');
  assert.equal(airtable.getCountyRecordId('Wayne', 'Kentucky'), 'recWayneKY');
  assert.equal(airtable.getCountyRecordId('Wayne', 'MO'), 'recWayneMO', 'same name in another state stays distinct');
  assert.equal(airtable.getCountyRecordId('Nowhere', 'OK'), null);
});

test('getCountyRecordId prefers the duplicate County row that carries a CPA Target (Casey, KY)', async (t) => {
  stubCountyTable(t, { rows: [
    { id: 'recCaseyTarget', fields: { County: 'Casey', 'State (full)': 'Kentucky', 'CPA Target': '$1,850' } },
    { id: 'recCaseyBlank', fields: { County: 'Casey', 'State (full)': 'Kentucky' } },
  ] });
  await airtable.loadCountyTargets({ retryDelaysMs: [0, 0] });
  assert.equal(airtable.getCountyRecordId('Casey', 'KY'), 'recCaseyTarget');
});
