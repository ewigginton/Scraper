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

// --- Cross-site source merging ------------------------------------------
// The same property on two sites becomes ONE record whose Source field keeps
// every source+link, instead of the second listing being dropped outright.

const { FIELDS } = airtable;

test('formatSourceLine renders the agreed `source — url` shape', () => {
  assert.equal(
    airtable.formatSourceLine('LandAndFarm', 'https://landandfarm.com/p/1'),
    'LandAndFarm — https://landandfarm.com/p/1'
  );
});

test('parseSourceUrls finds links anywhere, tolerating plain names and legacy free text', () => {
  const text = [
    'LandWatch',
    'LandAndFarm — https://landandfarm.com/p/1',
    'also seen at https://land.com/p/2 (called in by Nora)',
  ].join('\n');

  assert.deepEqual(airtable.parseSourceUrls(text), [
    'https://landandfarm.com/p/1',
    'https://land.com/p/2',
  ]);
  assert.deepEqual(airtable.parseSourceUrls('LandWatch'), [], 'a plain source name yields no urls');
  assert.deepEqual(airtable.parseSourceUrls(''), []);
  assert.deepEqual(airtable.parseSourceUrls(undefined), []);
});

test('parseSourceUrls strips sentence punctuation a human left stuck to a link', () => {
  assert.deepEqual(airtable.parseSourceUrls('see https://foo.com/x.'), ['https://foo.com/x']);
  assert.deepEqual(airtable.parseSourceUrls('https://foo.com/x, https://bar.com/y;'), [
    'https://foo.com/x',
    'https://bar.com/y',
  ]);
  assert.deepEqual(airtable.parseSourceUrls('(https://foo.com/x)'), ['https://foo.com/x']);
  assert.deepEqual(airtable.parseSourceUrls('"https://foo.com/x"!'), ['https://foo.com/x']);
  assert.deepEqual(
    airtable.parseSourceUrls('https://foo.com/wiki/Tract_(north)'),
    ['https://foo.com/wiki/Tract_(north)'],
    'a closing bracket the url itself opened is part of the url'
  );
  assert.deepEqual(airtable.parseSourceUrls('https://foo.com/x/'), ['https://foo.com/x/'], 'a trailing slash is not punctuation');
});

test('buildMergedSourceText recognizes a link a human noted with trailing punctuation', () => {
  const result = airtable.buildMergedSourceText(
    'LandWatch\nNora says it is also on https://laf.com/p/1.',
    'https://landwatch.com/p/1',
    'LandAndFarm',
    'https://laf.com/p/1'
  );
  assert.equal(result.changed, false, 'no cosmetic duplicate line for an already-noted link');
});

test('buildMergedSourceText appends a line and keeps the primary source name first', () => {
  const { text, changed } = airtable.buildMergedSourceText(
    'LandWatch', 'https://landwatch.com/p/1', 'LandAndFarm', 'https://landandfarm.com/p/1'
  );
  assert.equal(changed, true);
  assert.deepEqual(text.split('\n'), [
    'LandWatch',
    'LandAndFarm — https://landandfarm.com/p/1',
  ]);
});

test('buildMergedSourceText is a no-op when the url is already recorded', () => {
  // Already the record's primary 'Listing ' url
  const primary = airtable.buildMergedSourceText(
    'LandWatch', 'https://landwatch.com/p/1', 'LandWatch', 'https://landwatch.com/p/1'
  );
  assert.equal(primary.changed, false);
  assert.equal(primary.text, 'LandWatch');

  // Already merged in on an earlier night
  const already = airtable.buildMergedSourceText(
    'LandWatch\nLandAndFarm — https://landandfarm.com/p/1',
    'https://landwatch.com/p/1',
    'LandAndFarm',
    'https://landandfarm.com/p/1'
  );
  assert.equal(already.changed, false);

  // No url to merge
  assert.equal(airtable.buildMergedSourceText('LandWatch', 'https://x/1', 'Land.com', null).changed, false);
});

test('buildMergedSourceText appends to a second merge without losing the first', () => {
  const first = airtable.buildMergedSourceText(
    'LandWatch', 'https://landwatch.com/p/1', 'LandAndFarm', 'https://laf.com/1'
  );
  const second = airtable.buildMergedSourceText(
    first.text, 'https://landwatch.com/p/1', 'Land.com', 'https://land.com/1'
  );
  assert.equal(second.changed, true);
  assert.deepEqual(second.text.split('\n'), [
    'LandWatch',
    'LandAndFarm — https://laf.com/1',
    'Land.com — https://land.com/1',
  ]);
});

test('listingToFields renders additionalSources as multiline Source, deduped and without the self url', () => {
  const fields = airtable.listingToFields({
    name: 'Taney Tract',
    price: 300000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://landwatch.com/p/1',
    source: 'LandWatch',
    stage: 'New Lead',
    additionalSources: [
      { source: 'LandAndFarm', url: 'https://laf.com/1' },
      { source: 'LandAndFarm again', url: 'https://laf.com/1' },  // duplicate url
      { source: 'LandWatch', url: 'https://landwatch.com/p/1' },  // the listing's own url
      { source: 'Land.com', url: 'https://land.com/1' },
    ],
  });

  assert.deepEqual(fields[FIELDS.source].split('\n'), [
    'LandWatch',
    'LandAndFarm — https://laf.com/1',
    'Land.com — https://land.com/1',
  ]);
  assert.equal(fields[FIELDS.url], 'https://landwatch.com/p/1', "'Listing ' still holds exactly one url");
});

test('listingToFields leaves Source as the plain source name when nothing was merged', () => {
  const fields = airtable.listingToFields({
    name: 'Plain', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://landwatch.com/p/2', source: 'LandWatch', stage: 'New Lead',
  });
  assert.equal(fields[FIELDS.source], 'LandWatch');
});

test('buildSourceFieldValue keeps line 1 a plain source name even with no primary source', () => {
  const value = airtable.buildSourceFieldValue({
    url: 'https://landwatch.com/p/1',
    source: null,
    additionalSources: [{ source: 'LandAndFarm', url: 'https://laf.com/1' }],
  });

  assert.deepEqual(value.split('\n'), [
    'Unknown source',
    'LandAndFarm — https://laf.com/1',
  ]);
  assert.deepEqual(
    airtable.parseSourceUrls(value),
    ['https://laf.com/1'],
    'line 1 carries no url, so the dedup index never mistakes it for a merged link'
  );
});

test('buildDedupIndex indexes merged Source urls alongside primary urls, with their records', () => {
  const merged = {
    id: 'recMerged',
    fields: {
      [FIELDS.url]: 'https://landwatch.com/p/1',
      [FIELDS.source]: 'LandWatch\nLandAndFarm — https://laf.com/1',
      [FIELDS.fingerprint]: 'fp-merged',
    },
  };
  const plain = {
    id: 'recPlain',
    fields: {
      [FIELDS.url]: 'https://land.com/p/9',
      [FIELDS.source]: 'Land.com',
      [FIELDS.fingerprint]: 'fp-plain',
    },
  };

  const index = airtable.buildDedupIndex([merged, plain]);

  assert.equal(index.urlSet.has('https://landwatch.com/p/1'), true);
  assert.equal(index.urlSet.has('https://laf.com/1'), true, 'a merged secondary link dedups as a plain url later');
  assert.equal(index.urlToRecord.get('https://laf.com/1').id, 'recMerged');
  assert.equal(index.urlToRecord.get('https://land.com/p/9').id, 'recPlain');
  assert.equal(index.fingerprintToRecord.get('fp-merged').id, 'recMerged');
  assert.equal(index.records.length, 2);
});

test('checkDuplicate resolves the existing record for url and fingerprint matches', () => {
  const listing = {
    name: 'Cross-site', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://laf.com/1', source: 'LandAndFarm',
  };
  const record = {
    id: 'recExisting',
    fields: {
      [FIELDS.url]: 'https://landwatch.com/p/1',
      [FIELDS.source]: 'LandWatch',
      [FIELDS.fingerprint]: generateFingerprint(listing),
    },
  };
  const index = airtable.buildDedupIndex([record]);

  const fpMatch = airtable.checkDuplicate(listing, index);
  assert.equal(fpMatch.matchType, 'fingerprint');
  assert.equal(fpMatch.existingRecord.id, 'recExisting');

  const urlMatch = airtable.checkDuplicate(
    { ...listing, url: 'https://landwatch.com/p/1', acres: 999, price: 1 }, index
  );
  assert.equal(urlMatch.matchType, 'url');
  assert.equal(urlMatch.existingRecord.id, 'recExisting');
});

test('checkDuplicate tolerates an old-shape index with no record maps', () => {
  const listing = {
    name: 'Legacy', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://lw.com/1',
  };
  const legacyIndex = {
    urlSet: new Set(['https://lw.com/1']),
    fingerprintSet: new Set([generateFingerprint(listing)]),
  };

  const urlResult = airtable.checkDuplicate(listing, legacyIndex);
  assert.equal(urlResult.isDuplicate, true);
  assert.equal(urlResult.existingRecord, null, 'no record maps → null, never a throw');

  const fpResult = airtable.checkDuplicate({ ...listing, url: 'https://other.com/1' }, legacyIndex);
  assert.equal(fpResult.matchType, 'fingerprint');
  assert.equal(fpResult.existingRecord, null);
});

/**
 * Drive the real mergeSourceIntoRecord against a simulated Airtable record
 * store, stubbing only the module boundaries it calls through module.exports
 * (updateRecord / getRecordById). getRecordById hands back a COPY so a test
 * can hold a stale snapshot exactly as the dedup index does, and updateRecord
 * really applies the write — sequential merges therefore behave as they do in
 * production instead of each seeing a pristine record.
 */
function stubMergeBoundaries(t, { records = [] } = {}) {
  const originals = { updateRecord: airtable.updateRecord, getRecordById: airtable.getRecordById };
  const store = new Map();
  for (const record of records) store.set(record.id, { ...record.fields });
  const updates = [];
  const fetches = [];
  airtable.updateRecord = async (recordId, fields, protectStage) => {
    updates.push({ recordId, fields, protectStage });
    store.set(recordId, { ...(store.get(recordId) || {}), ...fields });
    return { updated: true };
  };
  airtable.getRecordById = async (recordId) => {
    fetches.push(recordId);
    return { id: recordId, fields: { ...(store.get(recordId) || {}) } };
  };
  t.after(() => Object.assign(airtable, originals));
  return { updates, fetches, store };
}

test('mergeSourceIntoRecord writes ONLY the Source field on the existing record', async (t) => {
  const existing = {
    id: 'recTarget',
    fields: {
      [FIELDS.url]: 'https://landwatch.com/p/1',
      [FIELDS.source]: 'LandWatch',
      [FIELDS.stage]: 'Emma Review',
      [FIELDS.price]: 300000,
    },
  };
  const { updates } = stubMergeBoundaries(t, { records: [existing] });

  const result = await airtable.mergeSourceIntoRecord(existing, {
    source: 'LandAndFarm', url: 'https://laf.com/1',
  });

  assert.equal(result.merged, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].recordId, 'recTarget');
  assert.deepEqual(Object.keys(updates[0].fields), [FIELDS.source], 'never Stage, price, or acres');
  assert.deepEqual(updates[0].fields[FIELDS.source].split('\n'), [
    'LandWatch',
    'LandAndFarm — https://laf.com/1',
  ]);
});

test('mergeSourceIntoRecord is a no-op (no write, no throw) when the url is already recorded', async (t) => {
  const existing = {
    id: 'recTarget',
    fields: {
      [FIELDS.url]: 'https://landwatch.com/p/1',
      [FIELDS.source]: 'LandWatch\nLandAndFarm — https://laf.com/1',
    },
  };
  const { updates } = stubMergeBoundaries(t, { records: [existing] });

  const already = await airtable.mergeSourceIntoRecord(existing, { source: 'LandAndFarm', url: 'https://laf.com/1' });
  assert.equal(already.merged, false);
  assert.match(already.reason, /already records/);

  const primary = await airtable.mergeSourceIntoRecord(existing, { source: 'LandWatch', url: 'https://landwatch.com/p/1' });
  assert.equal(primary.merged, false);

  const noUrl = await airtable.mergeSourceIntoRecord(existing, { source: 'LandWatch' });
  assert.equal(noUrl.merged, false);

  const noRecord = await airtable.mergeSourceIntoRecord(null, { source: 'X', url: 'https://x/1' });
  assert.equal(noRecord.merged, false);

  assert.equal(updates.length, 0, 'a no-op merge must never write');
});

test('mergeSourceIntoRecord reads the record first when only its id is known (no blind clobber)', async (t) => {
  const { updates, fetches } = stubMergeBoundaries(t, {
    records: [{
      id: 'recWrittenTonight',
      fields: {
        [FIELDS.url]: 'https://landwatch.com/p/1',
        [FIELDS.source]: 'LandWatch\nLand.com — https://land.com/1',
      },
    }],
  });

  const result = await airtable.mergeSourceIntoRecord(
    { id: 'recWrittenTonight', fields: {} },
    { source: 'LandAndFarm', url: 'https://laf.com/1' }
  );

  assert.equal(result.merged, true);
  assert.deepEqual(fetches, ['recWrittenTonight'], 'the current Source is read before appending');
  assert.deepEqual(updates[0].fields[FIELDS.source].split('\n'), [
    'LandWatch',
    'Land.com — https://land.com/1',
    'LandAndFarm — https://laf.com/1',
  ], 'an earlier merge on the same record survives');
});

/**
 * The clobber the verifier proved: the dedup index holds ONE snapshot object
 * per record, so every merge tonight is handed the same (by then stale)
 * fields. Merge #2 must not rebuild Source from pre-merge text.
 */
test('mergeSourceIntoRecord: two merges into the SAME shared snapshot both survive', async (t) => {
  // Exactly what buildDedupIndex hands out: one entry, reused by every caller.
  const sharedEntry = {
    id: 'recShared',
    fields: {
      [FIELDS.url]: 'https://landwatch.com/p/1',
      [FIELDS.source]: 'LandWatch',
    },
  };
  const { updates, fetches } = stubMergeBoundaries(t, { records: [sharedEntry] });

  const first = await airtable.mergeSourceIntoRecord(sharedEntry, { source: 'LandAndFarm', url: 'https://laf.com/p/1' });
  const second = await airtable.mergeSourceIntoRecord(sharedEntry, { source: 'WhitetailProperties', url: 'https://whitetail.com/p/1' });

  assert.equal(first.merged, true);
  assert.equal(second.merged, true);
  assert.equal(updates.length, 2);
  assert.equal(fetches.length, 2, 'the record is re-read before each merge');
  assert.deepEqual(updates[1].fields[FIELDS.source].split('\n'), [
    'LandWatch',
    'LandAndFarm — https://laf.com/p/1',
    'WhitetailProperties — https://whitetail.com/p/1',
  ], 'the second merge appends to the first instead of replacing it');
  assert.deepEqual(sharedEntry.fields[FIELDS.source].split('\n'), [
    'LandWatch',
    'LandAndFarm — https://laf.com/p/1',
    'WhitetailProperties — https://whitetail.com/p/1',
  ], 'the shared dedup-index snapshot is kept current for later readers');
});

test('mergeSourceIntoRecord: a third merge still keeps all earlier lines', async (t) => {
  const sharedEntry = {
    id: 'recShared',
    fields: { [FIELDS.url]: 'https://landwatch.com/p/1', [FIELDS.source]: 'LandWatch' },
  };
  const { store } = stubMergeBoundaries(t, { records: [sharedEntry] });

  await airtable.mergeSourceIntoRecord(sharedEntry, { source: 'LandAndFarm', url: 'https://laf.com/p/1' });
  await airtable.mergeSourceIntoRecord(sharedEntry, { source: 'Land.com', url: 'https://land.com/p/1' });
  await airtable.mergeSourceIntoRecord(sharedEntry, { source: 'MossyOakProperties', url: 'https://mossyoak.com/p/1' });

  assert.deepEqual(store.get('recShared')[FIELDS.source].split('\n'), [
    'LandWatch',
    'LandAndFarm — https://laf.com/p/1',
    'Land.com — https://land.com/p/1',
    'MossyOakProperties — https://mossyoak.com/p/1',
  ]);
  assert.deepEqual(airtable.parseSourceUrls(store.get('recShared')[FIELDS.source]).length, 3);
});

test('mergeSourceIntoRecord never clobbers a Source edited after the dedup index loaded', async (t) => {
  // The index loads at the top of the run; Emma may type into Source hours
  // later, and another process may merge into the same record.
  const staleSnapshot = {
    id: 'recStale',
    fields: { [FIELDS.url]: 'https://landwatch.com/p/1', [FIELDS.source]: 'LandWatch' },
  };
  const { updates, store } = stubMergeBoundaries(t, { records: [staleSnapshot] });
  store.set('recStale', {
    [FIELDS.url]: 'https://landwatch.com/p/1',
    [FIELDS.source]: 'LandWatch\ncalled the agent 7/29 — also on https://land.com/p/9',
  });

  const result = await airtable.mergeSourceIntoRecord(staleSnapshot, { source: 'LandAndFarm', url: 'https://laf.com/p/1' });

  assert.equal(result.merged, true);
  assert.deepEqual(updates[0].fields[FIELDS.source].split('\n'), [
    'LandWatch',
    'called the agent 7/29 — also on https://land.com/p/9',
    'LandAndFarm — https://laf.com/p/1',
  ], "the human's line survives the merge");
});

test('mergeSourceIntoRecord: the no-op check runs against the FRESH text, not the snapshot', async (t) => {
  const staleSnapshot = {
    id: 'recStale',
    fields: { [FIELDS.url]: 'https://landwatch.com/p/1', [FIELDS.source]: 'LandWatch' },
  };
  const { updates, store } = stubMergeBoundaries(t, { records: [staleSnapshot] });
  // Another merge already added this link after the snapshot was taken.
  store.set('recStale', {
    [FIELDS.url]: 'https://landwatch.com/p/1',
    [FIELDS.source]: 'LandWatch\nLandAndFarm — https://laf.com/p/1',
  });

  const result = await airtable.mergeSourceIntoRecord(staleSnapshot, { source: 'LandAndFarm', url: 'https://laf.com/p/1' });

  assert.equal(result.merged, false, 'no double-count for a link already recorded');
  assert.match(result.reason, /already records/);
  assert.equal(updates.length, 0, 'and no write');
});

test('mergeSourceIntoRecord propagates Airtable failures to the caller', async (t) => {
  stubMergeBoundaries(t, {
    records: [{ id: 'recTarget', fields: { [FIELDS.source]: 'LandWatch' } }],
  });
  airtable.updateRecord = async () => { throw new Error('Airtable 503'); };

  await assert.rejects(
    () => airtable.mergeSourceIntoRecord(
      { id: 'recTarget', fields: { [FIELDS.source]: 'LandWatch' } },
      { source: 'LandAndFarm', url: 'https://laf.com/1' }
    ),
    /Airtable 503/
  );
});

test('mergeSourceIntoRecord leaves the caller snapshot untouched when the read fails', async (t) => {
  stubMergeBoundaries(t, { records: [] });
  airtable.getRecordById = async () => { throw new Error('Airtable 429'); };
  const snapshot = { id: 'recTarget', fields: { [FIELDS.source]: 'LandWatch' } };

  await assert.rejects(
    () => airtable.mergeSourceIntoRecord(snapshot, { source: 'LandAndFarm', url: 'https://laf.com/1' }),
    /Airtable 429/
  );
  assert.equal(snapshot.fields[FIELDS.source], 'LandWatch');
});

test('writeListings returns the created record ids paired with their listing urls', async (t) => {
  const savedEnv = {
    AIRTABLE_LAND_TOKEN: process.env.AIRTABLE_LAND_TOKEN,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  };
  process.env.AIRTABLE_LAND_TOKEN = process.env.AIRTABLE_LAND_TOKEN || 'patTestToken';
  process.env.AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appTestBase';

  const originalTable = airtable.getLeadsTable;
  let batchCount = 0;
  airtable.getLeadsTable = () => ({
    create: async (batch) => {
      batchCount++;
      // Airtable resolves with record objects exposing getId()
      return batch.map((_, i) => ({ getId: () => `rec${batchCount}_${i}` }));
    },
  });
  t.after(() => {
    airtable.getLeadsTable = originalTable;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const listings = Array.from({ length: 12 }, (_, i) => ({
    name: `Lead ${i}`, price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: `https://lw.com/p/${i}`, source: 'LandWatch', stage: 'New Lead',
  }));

  const result = await airtable.writeListings(listings);

  assert.equal(result.created, 12);
  assert.equal(result.errors.length, 0);
  assert.equal(result.records.length, 12, 'every created record is reported back with its id');
  assert.deepEqual(result.records[0], { id: 'rec1_0', url: 'https://lw.com/p/0' });
  // Batches of 10: the 11th listing is the second batch's first record.
  assert.deepEqual(result.records[10], { id: 'rec2_0', url: 'https://lw.com/p/10' });

  assert.deepEqual((await airtable.writeListings([])).records, [], 'empty write still returns a records array');
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

test('a punctuation-terminated url merges once and is recognized forever after', () => {
  // A human-pasted intake link ending in '.' must not defeat its own
  // recognition: the merged line stores the trimmed url, and every later
  // comparison trims both sides, so the second merge is a no-op.
  const first = airtable.buildMergedSourceText('LandWatch', 'https://lw.com/p/1', 'Intake: x.com (nora)', 'https://x.com/p/1.');
  assert.equal(first.changed, true);
  assert.equal(first.text, 'LandWatch\nIntake: x.com (nora) — https://x.com/p/1');

  const again = airtable.buildMergedSourceText(first.text, 'https://lw.com/p/1', 'Intake: x.com (nora)', 'https://x.com/p/1.');
  assert.equal(again.changed, false, 'the same punctuation-terminated url must not be appended twice');
  assert.equal(again.text, first.text);

  // And it must never be re-appended as a duplicate of the primary url either.
  const primaryDup = airtable.buildMergedSourceText('LandWatch', 'https://lw.com/p/1', 'LandWatch', 'https://lw.com/p/1.');
  assert.equal(primaryDup.changed, false);
});

test('checkDuplicate url layer matches a merged link even when the incoming url carries pasted punctuation', () => {
  const record = {
    id: 'recMerged',
    fields: {
      [airtable.FIELDS.url]: 'https://lw.com/p/1',
      [airtable.FIELDS.source]: 'LandWatch\nIntake: x.com (nora) — https://x.com/p/1',
    },
  };
  const index = airtable.buildDedupIndex([record]);

  const result = airtable.checkDuplicate(
    { name: 'Lead', url: 'https://x.com/p/1.', county: 'Taney', state: 'MO', acres: 100, price: 300000 },
    index
  );
  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'url', 'the cheap url layer must catch it, not the fingerprint layer');
  assert.equal(result.existingRecord.id, 'recMerged');
});
