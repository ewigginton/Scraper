'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initFilter, filterListing } = require('../lib/filter');
const { generateFingerprint } = require('../lib/fingerprint');
const airtable = require('../lib/airtable');
const {
  selectTargetCounties,
  resolveParserCounties,
  processScrapedListings,
  runBotWallRetries,
  resolveBotWallCooldownMinutes,
  isMissingFilterCriticalField,
} = require('../lib/scraper');
const { stableHash, dayIndex, selectRotationCounties } = require('../lib/county-rotation');
const { buildScraperBody } = require('../lib/notify');
const BaseParser = require('../lib/parsers/base-parser');

test('full pipeline: filter -> fingerprint -> dedup flow', () => {
  initFilter(new Map([
    ['taney|MO', 4000],
    ['dallas|TX', 3000],
  ]));

  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set() };
  const sessionFingerprints = new Map();
  const passed = [];

  const listings = [
    // Should pass: under target
    { name: 'Good Deal', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/1', source: 'LandWatch' },
    // Should be rejected: over 30%
    { name: 'Too Expensive', price: 600000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/2', source: 'LandWatch' },
    // Should pass: different county
    { name: 'Dallas Tract', price: 200000, acres: 100, county: 'Dallas', state: 'TX', url: 'https://lw.com/3', source: 'LandWatch' },
    // Should be deduped: same URL as first
    { name: 'Duplicate URL', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/1', source: 'Land.com' },
    // Should pass as watch: 25% over
    { name: 'Watch Zone', price: 500000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/5', source: 'LandWatch' },
    // Should be rejected: not a target county
    { name: 'Wrong County', price: 100000, acres: 100, county: 'Boone', state: 'MO', url: 'https://lw.com/6', source: 'LandWatch' },
    // Should be rejected: below min acres
    { name: 'Too Small', price: 100000, acres: 10, county: 'Taney', state: 'MO', url: 'https://lw.com/7', source: 'LandWatch' },
  ];

  let rejected = 0;
  let duplicates = 0;

  for (const listing of listings) {
    const filterResult = filterListing(listing);
    if (!filterResult.passed) {
      rejected++;
      continue;
    }

    const fingerprint = generateFingerprint(listing);
    listing.fingerprint = fingerprint;
    listing.stage = filterResult.stage;

    // URL dedup
    const dupCheck = airtable.checkDuplicate(listing, dedupIndex);
    if (dupCheck.isDuplicate) {
      duplicates++;
      continue;
    }

    // Session fingerprint dedup
    if (fingerprint && sessionFingerprints.has(fingerprint)) {
      duplicates++;
      continue;
    }

    passed.push(listing);
    if (listing.url) dedupIndex.urlSet.add(listing.url);
    if (fingerprint) sessionFingerprints.set(fingerprint, { source: listing.source, name: listing.name });
  }

  assert.equal(passed.length, 3, `expected 3 passed, got ${passed.length}: ${passed.map(l => l.name).join(', ')}`);
  assert.equal(rejected, 3, 'expected 3 rejected (too expensive, wrong county, too small)');
  assert.equal(duplicates, 1, 'expected 1 duplicate (same URL)');

  assert.equal(passed[0].name, 'Good Deal');
  assert.equal(passed[0].stage, 'New Lead');

  assert.equal(passed[1].name, 'Dallas Tract');
  assert.equal(passed[1].stage, 'New Lead');

  assert.equal(passed[2].name, 'Watch Zone');
  assert.equal(passed[2].stage, 'Watch For Price Drop');
});

test('cross-site fingerprint dedup catches same property from different sources', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set() };
  const sessionFingerprints = new Map();

  // Same property, slightly different data, different URLs
  const fromLandWatch = {
    name: 'Taney Tract on LandWatch',
    price: 301000,
    acres: 151,
    county: 'Taney',
    state: 'MO',
    url: 'https://landwatch.com/property/abc',
    source: 'LandWatch',
  };
  const fromLandCom = {
    name: 'Taney County Tract on Land.com',
    price: 299000,
    acres: 149,
    county: 'Taney',
    state: 'MO',
    url: 'https://land.com/property/xyz',
    source: 'Land.com',
  };

  // Process first listing
  const f1 = filterListing(fromLandWatch);
  assert.ok(f1.passed);
  const fp1 = generateFingerprint(fromLandWatch);
  sessionFingerprints.set(fp1, { source: 'LandWatch', name: fromLandWatch.name });
  dedupIndex.urlSet.add(fromLandWatch.url);
  dedupIndex.fingerprintSet.add(fp1);

  // Process second listing — different URL but same fingerprint
  const f2 = filterListing(fromLandCom);
  assert.ok(f2.passed);
  const fp2 = generateFingerprint(fromLandCom);
  assert.equal(fp1, fp2, 'fingerprints should match');

  // URL check passes (different URL)
  const urlCheck = airtable.checkDuplicate(fromLandCom, dedupIndex);
  // But fingerprint catches it
  assert.equal(urlCheck.isDuplicate, true);
  assert.equal(urlCheck.matchType, 'fingerprint');
});

test('report.totals.parsed counts correctly without double-counting', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  // Simulate what scraper.js does for report counting
  const report = {
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0 },
  };

  const site1Listings = [
    { name: 'A', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://a.com/1' },
    { name: 'B', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://a.com/2' },
  ];
  const site2Listings = [
    { name: 'C', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://b.com/1' },
  ];

  // scraper.js line 111: report.totals.parsed += listings.length (once per site)
  report.totals.parsed += site1Listings.length;
  report.totals.parsed += site2Listings.length;

  assert.equal(report.totals.parsed, 3, 'parsed total should be 3, not 6 (no double count)');
});

test('selectTargetCounties keeps requested county order and rebuilds county map', () => {
  const selected = selectTargetCounties({
    counties: [
      { county: 'Shannon', state: 'MO', maxCPA: 2000 },
      { county: 'Wayne', state: 'KY', maxCPA: 2200 },
      { county: 'Pittsburg', state: 'OK', maxCPA: 2500 },
    ],
    countyMap: new Map(),
    source: 'airtable',
  }, [
    { county: 'Wayne', state: 'KY' },
    { county: 'Pittsburg', state: 'OK' },
    { county: 'Shannon', state: 'MO' },
  ]);

  assert.deepEqual(selected.counties.map(target => `${target.county}|${target.state}`), [
    'Wayne|KY',
    'Pittsburg|OK',
    'Shannon|MO',
  ]);
  assert.equal(selected.countyMap.get('wayne|KY'), 2200);
  assert.equal(selected.countyMap.get('pittsburg|OK'), 2500);
  assert.equal(selected.countyMap.get('shannon|MO'), 2000);
});

test('selectTargetCounties fails loudly when requested counties are missing', () => {
  assert.throws(() => selectTargetCounties({
    counties: [{ county: 'Shannon', state: 'MO', maxCPA: 2000 }],
    countyMap: new Map(),
  }, [
    { county: 'Wayne', state: 'KY' },
  ]), /Wayne, KY/);
});

// --- Bot-wall post-cooldown retry ---------------------------------------

const VALID_LISTING = {
  name: 'Retry Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://retry.example/1',
};

// A parser stub whose scrapeAll follows a scripted list of passes: each pass
// declares the listings it returns and whether it trips the circuit breaker.
// sleep() is a no-op so the cooldown never actually blocks the test.
class FakeBotWallParser extends BaseParser {
  constructor(passes) {
    super('FakeSite');
    this._passes = passes;
    this._passIndex = 0;
    this.scrapeCalls = 0;
  }
  sleep() { return Promise.resolve(); }
  async scrapeAll() {
    this.scrapeCalls++;
    const pass = this._passes[this._passIndex++] || { listings: [], abort: false };
    const listings = (pass.listings || []).map(l => ({ ...l, source: this.name }));
    this.stats.checked += listings.length;
    if (pass.abort) {
      this.stats.abortedByBotWall = true;
      this.stats.abortedAt = Date.now();
    }
    return listings;
  }
}

function makeCtx() {
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [], filterRejects: [], writeErrors: [], sourceIssues: [], warnings: [],
    dryRun: true,
  };
  const ctx = {
    dedupIndex: { urlSet: new Set(), fingerprintSet: new Set() },
    sessionFingerprints: new Map(),
    report,
    dryRun: true,
  };
  return { report, ctx };
}

// Mirror the orchestrator's first pass: scrape, process, detect a breaker abort.
async function runFirstPass(parser, ctx) {
  const listings = await parser.scrapeAll([]);
  const siteReport = await processScrapedListings(parser, listings, ctx);
  ctx.report.sites[parser.name] = siteReport;
  const abortedParsers = [];
  if (parser.stats.abortedByBotWall) {
    abortedParsers.push({ parser, abortedAt: parser.stats.abortedAt, firstPass: siteReport });
  }
  return abortedParsers;
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test('bot-wall retry: aborts on pass 1, succeeds on pass 2 — listings reach report', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new FakeBotWallParser([
    { listings: [], abort: true },
    { listings: [VALID_LISTING], abort: false },
  ]);
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_BOTWALL_COOLDOWN_MINUTES: '60' }, async () => {
    const aborted = await runFirstPass(parser, ctx);
    assert.equal(aborted.length, 1, 'first pass should register the breaker abort');
    await runBotWallRetries(aborted, ctx, []);
  });

  assert.equal(parser.scrapeCalls, 2, 'exactly one first pass and one retry');
  assert.equal(report.totals.passed, 1, 'retry listing should pass the pipeline into the report');
  assert.equal(report.totals.wouldWrite, 1, 'retry listing counted for the dry-run write');
  const site = report.sites.FakeSite;
  assert.equal(site.status, 'retried_after_cooldown');
  assert.equal(site.retryPass.blockedAgain, false);
  assert.ok(
    report.warnings.some(w => /retried after .* cooldown — succeeded/.test(w)),
    `expected a success retry warning, got: ${report.warnings.join(' | ')}`
  );
});

test('bot-wall retry: aborts on both passes — reported blocked, no third attempt', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new FakeBotWallParser([
    { listings: [], abort: true },
    { listings: [], abort: true },
  ]);
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_BOTWALL_COOLDOWN_MINUTES: '60' }, async () => {
    const aborted = await runFirstPass(parser, ctx);
    await runBotWallRetries(aborted, ctx, []);
  });

  assert.equal(parser.scrapeCalls, 2, 'no third attempt after the retry also aborts');
  const site = report.sites.FakeSite;
  assert.equal(site.status, 'retried_after_cooldown');
  assert.equal(site.retryPass.blockedAgain, true);
  assert.ok(
    report.warnings.some(w => /retried after .* cooldown — blocked again/.test(w)),
    `expected a blocked-again retry warning, got: ${report.warnings.join(' | ')}`
  );
});

test('bot-wall retry: SCRAPER_BOTWALL_COOLDOWN_MINUTES=0 disables the retry', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new FakeBotWallParser([
    { listings: [], abort: true },
    { listings: [VALID_LISTING], abort: false },
  ]);
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_BOTWALL_COOLDOWN_MINUTES: '0' }, async () => {
    assert.equal(resolveBotWallCooldownMinutes(), 0);
    const aborted = await runFirstPass(parser, ctx);
    await runBotWallRetries(aborted, ctx, []);
  });

  assert.equal(parser.scrapeCalls, 1, 'no retry attempted when cooldown is 0');
  assert.equal(report.totals.passed, 0);
  assert.equal(report.sites.FakeSite.status, 'ok', 'site keeps its first-pass status');
  assert.ok(
    report.warnings.some(w => /retry disabled \(SCRAPER_BOTWALL_COOLDOWN_MINUTES=0\)/.test(w)),
    `expected a disabled-retry warning, got: ${report.warnings.join(' | ')}`
  );
});

test('bot-wall retry: GITHUB_ACTIONS disables the retry (no hour-long sleep in CI)', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new FakeBotWallParser([
    { listings: [], abort: true },
    { listings: [VALID_LISTING], abort: false },
  ]);
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: '1', SCRAPER_BOTWALL_COOLDOWN_MINUTES: '60' }, async () => {
    assert.equal(resolveBotWallCooldownMinutes(), 0, 'CI forces cooldown to 0 regardless of the override');
    const aborted = await runFirstPass(parser, ctx);
    await runBotWallRetries(aborted, ctx, []);
  });

  assert.equal(parser.scrapeCalls, 1, 'no retry attempted under GITHUB_ACTIONS');
  assert.equal(report.sites.FakeSite.status, 'ok');
  assert.ok(
    report.warnings.some(w => /retry disabled in CI/.test(w)),
    `expected a CI-disabled retry warning, got: ${report.warnings.join(' | ')}`
  );
});

test('bot-wall retry: consolidated email surfaces the retried-after-cooldown outcome', () => {
  const report = {
    dryRun: false,
    sites: {
      FakeSite: {
        status: 'retried_after_cooldown', parsed: 12, passed: 3, written: 3, duplicates: 0,
        cooldownMinutes: 58, firstPass: { parsed: 0, passed: 0 },
        retryPass: { parsed: 12, passed: 3, blockedAgain: false },
      },
    },
    totals: { written: 3, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 120,
  };
  const body = buildScraperBody(report, null, 'Test Day', null, null);
  assert.match(body, /retried after 58 min cooldown — succeeded/);
});

// --- Cross-site source merging ------------------------------------------------
// A duplicate is no longer just dropped: its source+link is preserved on the
// lead it duplicates, so one Airtable record carries every site it appears on.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replayFailedWrites } = require('../lib/scraper');
const { FIELDS } = airtable;

// The same property, priced/sized within fingerprint tolerance on two sites.
const LANDWATCH_LISTING = {
  name: 'Taney Tract (LandWatch)', price: 301000, acres: 151, county: 'Taney', state: 'MO',
  url: 'https://landwatch.com/p/1', source: 'LandWatch',
};
const LANDANDFARM_LISTING = {
  name: 'Taney Tract (LandAndFarm)', price: 299000, acres: 149, county: 'Taney', state: 'MO',
  url: 'https://laf.com/p/1', source: 'LandAndFarm',
};

function fakeParser(name) {
  return { name, stats: { checked: 1, errors: 0 }, sourceIssues: [] };
}

/** A report shaped exactly like runScraper's literal. */
function makeMergeCtx({ dryRun = false, dedupIndex } = {}) {
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0, sourceMerges: 0 },
    duplicateDetails: [], mergeDetails: [], filterRejects: [], writeErrors: [], sourceIssues: [], warnings: [],
    dryRun,
  };
  const ctx = {
    dedupIndex: dedupIndex || { urlSet: new Set(), fingerprintSet: new Set(), locationMap: new Map() },
    sessionFingerprints: new Map(),
    report,
    dryRun,
  };
  return { report, ctx };
}

/** Dedup index holding one existing LandWatch record for the shared property. */
function indexWithExistingLandWatchRecord() {
  return airtable.buildDedupIndex([{
    id: 'recExisting1',
    fields: {
      [FIELDS.url]: LANDWATCH_LISTING.url,
      [FIELDS.source]: 'LandWatch',
      [FIELDS.fingerprint]: generateFingerprint(LANDWATCH_LISTING),
      [FIELDS.nameFormula]: 'Taney Tract',
    },
  }]);
}

function stubAirtableMerge(t, { merge, write } = {}) {
  const originals = {
    mergeSourceIntoRecord: airtable.mergeSourceIntoRecord,
    writeListings: airtable.writeListings,
  };
  const calls = { merges: [], writes: [] };
  airtable.mergeSourceIntoRecord = async (record, listing) => {
    calls.merges.push({ record, listing });
    if (merge) return merge(record, listing);
    return { merged: true };
  };
  airtable.writeListings = async (listings) => {
    calls.writes.push(listings);
    if (write) return write(listings);
    return {
      created: listings.length,
      errors: [],
      records: listings.map((l, i) => ({ id: `recNew${calls.writes.length}_${i}`, url: l.url })),
    };
  };
  t.after(() => Object.assign(airtable, originals));
  return calls;
}

// Detail enrichment must stay off: these tests never fetch a live page.
function withMergeEnv(fn) {
  return withEnv({ SCRAPER_DETAIL_ENRICHMENT: 'false', GITHUB_ACTIONS: undefined }, fn);
}

test('merge: a fingerprint duplicate of an existing record has its source+link merged in (live)', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const calls = stubAirtableMerge(t);
  const { report, ctx } = makeMergeCtx({ dedupIndex: indexWithExistingLandWatchRecord() });

  const siteReport = await withMergeEnv(() =>
    processScrapedListings(fakeParser('LandAndFarm'), [{ ...LANDANDFARM_LISTING }], ctx));

  assert.equal(calls.merges.length, 1, 'the duplicate merged into the existing record');
  assert.equal(calls.merges[0].record.id, 'recExisting1');
  assert.equal(calls.merges[0].listing.url, LANDANDFARM_LISTING.url);
  assert.equal(calls.writes.length, 0, 'a merged duplicate is never written as a new record');

  // Still counted as a caught duplicate — totals and subject lines keep meaning.
  assert.equal(report.totals.duplicates, 1);
  assert.equal(siteReport.duplicates, 1);
  assert.equal(report.totals.sourceMerges, 1);
  assert.equal(siteReport.sourceMerges, 1);
  assert.match(report.duplicateDetails[0].reason, /source\+link merged into the existing lead/);
  assert.equal(report.duplicateDetails[0].merged, true);

  assert.deepEqual(report.mergeDetails, [{
    source: 'LandAndFarm',
    name: LANDANDFARM_LISTING.name,
    url: LANDANDFARM_LISTING.url,
    matchType: 'fingerprint',
    target: 'existing-record',
    mergedInto: {
      recordId: 'recExisting1',
      url: LANDWATCH_LISTING.url,
      source: 'LandWatch',
      name: 'Taney Tract',
    },
    dryRun: false,
  }]);

  // A second identical card tonight now dedups on the URL instead of re-merging.
  assert.equal(ctx.dedupIndex.urlSet.has(LANDANDFARM_LISTING.url), true);
  await withMergeEnv(() => processScrapedListings(fakeParser('LandAndFarm'), [{ ...LANDANDFARM_LISTING }], ctx));
  assert.equal(calls.merges.length, 1, 'the same link is not merged twice');
  assert.equal(report.totals.duplicates, 2, 'it is still counted as a duplicate');
});

/**
 * The tests around this one stub airtable.mergeSourceIntoRecord wholesale, so
 * nothing exercises the real append. This one drives the REAL helper (only the
 * Airtable boundaries are stubbed, against a simulated record store) with two
 * sites merging into the SAME record — the shape that silently lost the first
 * site's link, because the dedup index hands every caller one shared snapshot.
 */
const WHITETAIL_LISTING = {
  name: 'Taney Tract (Whitetail)', price: 300500, acres: 150, county: 'Taney', state: 'MO',
  url: 'https://whitetail.com/p/1', source: 'WhitetailProperties',
};

function stubAirtableRecordStore(t, records) {
  const originals = {
    getRecordById: airtable.getRecordById,
    updateRecord: airtable.updateRecord,
    writeListings: airtable.writeListings,
  };
  const store = new Map(records.map(record => [record.id, { ...record.fields }]));
  airtable.getRecordById = async (recordId) => ({ id: recordId, fields: { ...(store.get(recordId) || {}) } });
  airtable.updateRecord = async (recordId, fields) => {
    store.set(recordId, { ...(store.get(recordId) || {}), ...fields });
    return { updated: true };
  };
  airtable.writeListings = async () => { throw new Error('a merged duplicate must never be written as a new record'); };
  t.after(() => Object.assign(airtable, originals));
  return store;
}

test('merge (real helper): two sites merging into one record keep BOTH source lines', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const dedupIndex = indexWithExistingLandWatchRecord();
  const store = stubAirtableRecordStore(t, [{
    id: 'recExisting1',
    fields: { [FIELDS.url]: LANDWATCH_LISTING.url, [FIELDS.source]: 'LandWatch' },
  }]);
  const { report, ctx } = makeMergeCtx({ dedupIndex });

  await withMergeEnv(() =>
    processScrapedListings(fakeParser('LandAndFarm'), [{ ...LANDANDFARM_LISTING }], ctx));
  await withMergeEnv(() =>
    processScrapedListings(fakeParser('WhitetailProperties'), [{ ...WHITETAIL_LISTING }], ctx));

  assert.equal(report.totals.sourceMerges, 2, 'both merges reported');
  assert.deepEqual(store.get('recExisting1')[FIELDS.source].split('\n'), [
    'LandWatch',
    `LandAndFarm — ${LANDANDFARM_LISTING.url}`,
    `WhitetailProperties — ${WHITETAIL_LISTING.url}`,
  ], 'the second merge appends instead of rebuilding from the stale shared snapshot');

  // Night 2: rebuilding the index from the written Source finds both links.
  const nightTwo = airtable.buildDedupIndex([{ id: 'recExisting1', fields: store.get('recExisting1') }]);
  assert.equal(nightTwo.urlSet.has(LANDANDFARM_LISTING.url), true);
  assert.equal(nightTwo.urlSet.has(WHITETAIL_LISTING.url), true);
});

test('merge: a dry run makes ZERO Airtable writes and reports what would be merged', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const calls = stubAirtableMerge(t, {
    merge: () => { throw new Error('dry run must not merge'); },
    write: () => { throw new Error('dry run must not write'); },
  });
  const { report, ctx } = makeMergeCtx({ dryRun: true, dedupIndex: indexWithExistingLandWatchRecord() });

  await withMergeEnv(() =>
    processScrapedListings(fakeParser('LandAndFarm'), [{ ...LANDANDFARM_LISTING }], ctx));

  assert.equal(calls.merges.length, 0, 'no merge write in a dry run');
  assert.equal(calls.writes.length, 0, 'no record write in a dry run');
  assert.equal(report.totals.sourceMerges, 1, 'the would-be merge is still reported');
  assert.equal(report.mergeDetails[0].dryRun, true);
  assert.match(report.duplicateDetails[0].reason, /would be merged/);
});

test('merge: a legacy report shell (no mergeDetails/sourceMerges) survives a merge', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  stubAirtableMerge(t);
  // makeCtx builds the pre-merge report shape, like index.js's fallback shells.
  const { report, ctx } = makeCtx();
  ctx.dedupIndex = indexWithExistingLandWatchRecord();

  await withMergeEnv(() =>
    processScrapedListings(fakeParser('LandAndFarm'), [{ ...LANDANDFARM_LISTING }], ctx));

  assert.equal(report.totals.sourceMerges, 1, 'the counter is created on demand');
  assert.equal(report.mergeDetails.length, 1, 'the detail array is created on demand');
});

test('merge: a failed merge write is non-fatal — warned, counted as a plain duplicate', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const calls = stubAirtableMerge(t, {
    merge: () => { throw new Error('Airtable 503'); },
  });
  const { report, ctx } = makeMergeCtx({ dedupIndex: indexWithExistingLandWatchRecord() });

  const siteReport = await withMergeEnv(() =>
    processScrapedListings(fakeParser('LandAndFarm'), [{ ...LANDANDFARM_LISTING }], ctx));

  assert.equal(calls.merges.length, 1);
  assert.equal(siteReport.status, 'ok', 'the site pass survives the merge failure');
  assert.equal(report.totals.duplicates, 1, 'still counted as a duplicate');
  assert.equal(report.totals.sourceMerges, 0, 'never counted as a merge that did not happen');
  assert.equal(report.mergeDetails.length, 0);
  assert.equal(report.duplicateDetails[0].merged, false);
  assert.ok(
    report.warnings.some(w => /Could not merge LandAndFarm source into existing lead recExisting1: Airtable 503/.test(w)),
    `expected a merge-failure warning, got: ${report.warnings.join(' | ')}`
  );
});

test('merge: an exact URL match is skipped as before — nothing new to preserve', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const calls = stubAirtableMerge(t);
  const { report, ctx } = makeMergeCtx({ dedupIndex: indexWithExistingLandWatchRecord() });

  await withMergeEnv(() =>
    processScrapedListings(fakeParser('LandWatch'), [{ ...LANDWATCH_LISTING }], ctx));

  assert.equal(calls.merges.length, 0, 'the link is already recorded — no write');
  assert.equal(report.totals.duplicates, 1);
  assert.equal(report.totals.sourceMerges, 0);
  assert.equal(report.duplicateDetails[0].matchType, 'url');
});

test('merge: a session duplicate of a not-yet-written lead rides along on the record being created', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const calls = stubAirtableMerge(t);
  const { report, ctx } = makeMergeCtx();

  // Same site pass, same fingerprint, two different links.
  const first = { ...LANDWATCH_LISTING };
  const second = { ...LANDANDFARM_LISTING, source: 'LandWatch' };
  await withMergeEnv(() => processScrapedListings(fakeParser('LandWatch'), [first, second], ctx));

  assert.equal(calls.merges.length, 0, 'nothing is in Airtable yet — no update call');
  assert.deepEqual(first.additionalSources, [{ source: 'LandWatch', url: LANDANDFARM_LISTING.url }]);
  assert.deepEqual(calls.writes[0], [first], 'only the first listing is written');
  assert.equal(report.totals.sourceMerges, 1);
  assert.equal(report.mergeDetails[0].target, 'session-listing');
  assert.equal(report.mergeDetails[0].matchType, 'session-fingerprint');
  assert.equal(ctx.dedupIndex.urlSet.has(LANDANDFARM_LISTING.url), true);

  // The rendered Airtable fields carry both sources on one record.
  assert.deepEqual(airtable.listingToFields(first)[FIELDS.source].split('\n'), [
    'LandWatch',
    `LandWatch — ${LANDANDFARM_LISTING.url}`,
  ]);
});

test('merge: a session duplicate of a lead written in an EARLIER site batch merges by record id', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const calls = stubAirtableMerge(t);
  const { report, ctx } = makeMergeCtx();

  const first = { ...LANDWATCH_LISTING };
  await withMergeEnv(() => processScrapedListings(fakeParser('LandWatch'), [first], ctx));
  assert.equal(calls.writes.length, 1);

  const second = { ...LANDANDFARM_LISTING };
  await withMergeEnv(() => processScrapedListings(fakeParser('LandAndFarm'), [second], ctx));

  assert.equal(calls.merges.length, 1, 'the already-written lead is updated in Airtable');
  assert.deepEqual(calls.merges[0].record, { id: 'recNew1_0', fields: {} },
    'only the id is known — the merge helper reads the record before appending');
  assert.equal(calls.merges[0].listing.url, LANDANDFARM_LISTING.url);
  assert.equal(first.additionalSources, undefined, 'an already-written listing is never mutated');
  assert.equal(calls.writes.length, 1, 'the duplicate is not written as its own record');
  assert.equal(report.totals.sourceMerges, 1);
  assert.equal(report.mergeDetails[0].target, 'existing-record');
  assert.equal(report.mergeDetails[0].matchType, 'session-fingerprint');
  assert.equal(report.mergeDetails[0].mergedInto.recordId, 'recNew1_0');
});

test('merge: a session duplicate whose first listing failed to write is an honest plain duplicate', async (t) => {
  initFilter(new Map([['taney|MO', 4000]]));
  const calls = stubAirtableMerge(t, {
    write: () => ({ created: 0, errors: [{ batch: 0, error: 'Airtable 503' }], records: [] }),
  });
  const { report, ctx } = makeMergeCtx();

  const first = { ...LANDWATCH_LISTING };
  await withMergeEnv(() => processScrapedListings(fakeParser('LandWatch'), [first], ctx));
  await withMergeEnv(() => processScrapedListings(fakeParser('LandAndFarm'), [{ ...LANDANDFARM_LISTING }], ctx));

  assert.equal(calls.merges.length, 0, 'there is no record to merge into');
  assert.equal(first.additionalSources, undefined, 'the queued listing is not silently mutated');
  assert.equal(report.totals.sourceMerges, 0, 'no merge is claimed that did not happen');
  assert.equal(report.totals.duplicates, 1);
});

test('merge: replayed queued leads that now duplicate an existing record merge their source in', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-replay-'));
  const queueDir = path.join(dataDir, 'failed-writes');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueDir, '2026-07-29.jsonl'),
    `${JSON.stringify({ savedAt: '2026-07-29T00:00:00Z', context: {}, listing: { ...LANDANDFARM_LISTING } })}\n`,
    'utf8'
  );

  const calls = stubAirtableMerge(t);
  const { report, ctx } = makeMergeCtx({ dedupIndex: indexWithExistingLandWatchRecord() });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  await withEnv({ SCRAPER_DATA_DIR: dataDir }, () =>
    replayFailedWrites(ctx.dedupIndex, false, report));

  assert.equal(calls.writes.length, 0, 'the queued lead is a duplicate — never re-created');
  assert.equal(calls.merges.length, 1, 'its source+link is preserved on the record that won');
  assert.equal(calls.merges[0].record.id, 'recExisting1');
  assert.equal(report.totals.sourceMerges, 1);
  assert.equal(report.mergeDetails[0].source, 'replay');
  assert.equal(report.mergeDetails[0].target, 'existing-record');
  // archiveFailedWrites timestamps the archived name, so match on the suffix.
  assert.ok(
    fs.readdirSync(path.join(queueDir, 'done')).some(f => f.endsWith('2026-07-29.jsonl')),
    'the queue file is archived'
  );
});

test('merge: a dry run replay makes no merge writes at all', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-replay-dry-'));
  const queueDir = path.join(dataDir, 'failed-writes');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueDir, '2026-07-29.jsonl'),
    `${JSON.stringify({ savedAt: '2026-07-29T00:00:00Z', context: {}, listing: { ...LANDANDFARM_LISTING } })}\n`,
    'utf8'
  );

  const calls = stubAirtableMerge(t, {
    merge: () => { throw new Error('dry run must not merge'); },
  });
  const { report, ctx } = makeMergeCtx({ dryRun: true, dedupIndex: indexWithExistingLandWatchRecord() });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  await withEnv({ SCRAPER_DATA_DIR: dataDir }, () =>
    replayFailedWrites(ctx.dedupIndex, true, report));

  assert.equal(calls.merges.length, 0);
  assert.equal(report.totals.sourceMerges, 0);
});

// --- Per-site county rotation -------------------------------------------------

// A spread of real-looking county targets so hash buckets aren't trivially even.
const ROTATION_COUNTIES = [
  ['Wayne', 'KY'], ['Pittsburg', 'OK'], ['Shannon', 'MO'], ['Taney', 'MO'],
  ['Dallas', 'TX'], ['Boone', 'MO'], ['St. Clair', 'MO'], ['Polk', 'AR'],
  ['Izard', 'AR'], ['Fannin', 'TX'], ['Coal', 'OK'], ['Ozark', 'MO'],
  ['Texas', 'MO'], ['Howell', 'MO'], ['Douglas', 'MO'], ['Wright', 'MO'],
  ['Laclede', 'MO'], ['Camden', 'MO'], ['Miller', 'MO'], ['Pulaski', 'MO'],
].map(([county, state]) => ({ county, state, maxCPA: 3000 }));

test('county rotation: partition is stable — same county+state maps to the same group across calls', () => {
  const n = 3;
  // The swept group depends on the run date, but a county's own group
  // (hash % n) is date-independent. Selecting on three unrelated dates whose
  // day indices all fall in the same residue class must yield identical subsets.
  const datesInGroup0 = [];
  for (let d = 0; datesInGroup0.length < 3 && d < 400; d++) {
    const candidate = new Date(2026, 0, 1 + d);
    if (dayIndex(candidate) % n === 0) datesInGroup0.push(candidate);
  }
  const subsets = datesInGroup0.map(date =>
    selectRotationCounties(ROTATION_COUNTIES, n, date).counties.map(c => `${c.county}|${c.state}`).sort()
  );
  assert.deepEqual(subsets[1], subsets[0], 'same swept group on a later date yields the same counties');
  assert.deepEqual(subsets[2], subsets[0], 'stable across all same-group dates');

  // stableHash itself is pure and deterministic.
  assert.equal(stableHash('Wayne|KY'), stableHash('Wayne|KY'));
});

test('county rotation: N consecutive nights cover every county exactly once, no overlap', () => {
  for (const n of [2, 3, 4]) {
    const seen = new Map(); // key -> times selected across the cycle
    for (let d = 0; d < n; d++) {
      const runDate = new Date(2026, 5, 10 + d); // consecutive calendar days
      const { counties, rotation } = selectRotationCounties(ROTATION_COUNTIES, n, runDate);
      assert.equal(rotation.groupsTotal, n);
      assert.equal(rotation.totalCount, ROTATION_COUNTIES.length);
      assert.equal(rotation.sweptCount, counties.length);
      for (const c of counties) {
        const key = `${c.county}|${c.state}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    assert.equal(seen.size, ROTATION_COUNTIES.length, `n=${n}: every county selected within the cycle`);
    for (const [key, count] of seen) {
      assert.equal(count, 1, `n=${n}: ${key} selected exactly once across ${n} nights`);
    }
  }
});

test('county rotation: absent or 1 → identity (all counties, no rotation metadata)', () => {
  const date = new Date(2026, 5, 10);
  for (const factor of [undefined, null, 1, 0, 'x']) {
    const { counties, rotation } = selectRotationCounties(ROTATION_COUNTIES, factor, date);
    assert.equal(counties.length, ROTATION_COUNTIES.length, `factor ${factor}: all counties swept`);
    assert.equal(rotation, null, `factor ${factor}: no rotation metadata`);
  }
});

test('county rotation: SCRAPER_TARGET_COUNTIES (targeted mode) bypasses rotation entirely', () => {
  const parser = { name: 'LandWatch', countyRotation: 3 };
  const report = { warnings: [] };
  const plan = resolveParserCounties(
    [parser], ROTATION_COUNTIES, /* bypassRotation */ true, new Date(2026, 5, 10), report
  );
  const resolved = plan.get(parser);
  assert.equal(resolved.counties.length, ROTATION_COUNTIES.length, 'targeted mode gets every requested county');
  assert.equal(resolved.rotation, null, 'no rotation applied in targeted mode');
  assert.equal(report.warnings.length, 0, 'no rotation warning emitted when bypassed');

  // Without bypass, the same rotating parser is filtered down and warned about.
  const report2 = { warnings: [] };
  const plan2 = resolveParserCounties(
    [parser], ROTATION_COUNTIES, /* bypassRotation */ false, new Date(2026, 5, 10), report2
  );
  const resolved2 = plan2.get(parser);
  assert.ok(resolved2.counties.length < ROTATION_COUNTIES.length, 'rotation applies when not bypassed');
  assert.ok(resolved2.rotation, 'rotation metadata present');
  assert.ok(
    report2.warnings.some(w => /county rotation 3 — swept \d+ of \d+ counties \(group \d of 3\)/.test(w)),
    `expected a rotation warning, got: ${report2.warnings.join(' | ')}`
  );
});

test('county rotation: a parser with usesCountyUrls === false is never rotated (full list, no warning)', () => {
  // MidwestLandGroup fetches ONE national index regardless of the county subset,
  // so rotation would only starve its downstream county filter for zero request
  // savings. resolveParserCounties must hand it the full list and emit no line.
  const parser = { name: 'MidwestLandGroup', countyRotation: 3, usesCountyUrls: false };
  const report = { warnings: [] };
  const plan = resolveParserCounties(
    [parser], ROTATION_COUNTIES, /* bypassRotation */ false, new Date(2026, 5, 10), report
  );
  const resolved = plan.get(parser);
  assert.equal(resolved.counties.length, ROTATION_COUNTIES.length, 'gets every county, unrotated');
  assert.equal(resolved.rotation, null, 'no rotation metadata for a no-county-URL parser');
  assert.equal(report.warnings.length, 0, 'no rotation warning emitted for a no-county-URL parser');
});

// --- isMissingFilterCriticalField boundary -----------------------------------

test('isMissingFilterCriticalField: exactly one missing field → true; none missing → false', () => {
  const complete = { price: 300000, acres: 100, county: 'Taney', state: 'MO' };
  assert.equal(isMissingFilterCriticalField(complete), false, 'a complete listing is not missing anything');

  for (const field of ['price', 'acres', 'county', 'state']) {
    const oneMissing = { ...complete, [field]: null };
    assert.equal(
      isMissingFilterCriticalField(oneMissing), true,
      `a listing missing only ${field} is flagged as missing a filter-critical field`,
    );
  }
});

// --- Incremental early-stop sweeps -------------------------------------------

// A parser that drives the REAL BaseParser.scrapeAll loop over a scripted set
// of pages, counting fetches. Each entry in `pages` is the list of listing
// URLs that page returns; page N's URL collapses to the same pagination series
// key so early-stop can skip deeper pages. sleep() is a no-op.
class IncrementalTestParser extends BaseParser {
  constructor({ sorted, pages }) {
    super('IncrementalTestSite');
    this.resultsSortedNewestFirst = sorted;
    this._pages = pages;
    this.fetchedPages = [];
  }
  sleep() { return Promise.resolve(); }
  buildSearchUrls() {
    return this._pages.map((_, i) => ({
      url: `https://test.example/taney-county/land?page=${i + 1}`,
      county: 'Taney', state: 'MO', page: i + 1,
    }));
  }
  async fetchPage(url) {
    this.fetchedPages.push(url);
    const pageNum = Number(url.match(/page=(\d+)/)[1]);
    return JSON.stringify(this._pages[pageNum - 1] || []);
  }
  parseSearchPage(html) {
    const urls = JSON.parse(html);
    this._lastCardCount = urls.length;
    return urls.map(u => ({ name: 'Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: u }));
  }
}

function knownUrlPredicate(...urls) {
  const known = new Set(urls);
  return url => known.has(url);
}

test('incremental early-stop: an all-known page 1 stops the series before fetching page 2', async () => {
  const parser = new IncrementalTestParser({
    sorted: true,
    pages: [
      ['https://test.example/l/1', 'https://test.example/l/2'], // all known
      ['https://test.example/l/3'],                              // would be fetched without early-stop
    ],
  });
  parser.setKnownUrlPredicate(knownUrlPredicate('https://test.example/l/1', 'https://test.example/l/2'));

  const listings = await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);

  assert.equal(parser.fetchedPages.length, 1, 'page 2 must not be fetched once page 1 is entirely known');
  assert.equal(parser.stats.earlyStoppedSeries, 1, 'the truncated series is counted');
  assert.equal(listings.length, 2, "page 1's listings are still returned (dupe accounting stays truthful)");
});

test('incremental early-stop: a page with an unknown URL continues to deeper pages', async () => {
  const parser = new IncrementalTestParser({
    sorted: true,
    pages: [
      ['https://test.example/l/1', 'https://test.example/l/new'],  // one unknown → don't truncate
      ['https://test.example/l/2', 'https://test.example/l/new2'], // also has an unknown
    ],
  });
  parser.setKnownUrlPredicate(knownUrlPredicate('https://test.example/l/1', 'https://test.example/l/2'));

  const listings = await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);

  assert.equal(parser.fetchedPages.length, 2, 'a page with any unknown URL must not truncate the series');
  assert.equal(parser.stats.earlyStoppedSeries, 0);
  assert.equal(listings.length, 4);
});

test('incremental early-stop: a non-date-sorted parser never early-stops', async () => {
  const parser = new IncrementalTestParser({
    sorted: false, // resultsSortedNewestFirst = false → deeper pages could hide a new listing
    pages: [
      ['https://test.example/l/1', 'https://test.example/l/2'], // all known
      ['https://test.example/l/3'],
    ],
  });
  parser.setKnownUrlPredicate(knownUrlPredicate('https://test.example/l/1', 'https://test.example/l/2'));

  const listings = await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);

  assert.equal(parser.fetchedPages.length, 2, 'unsorted results are never truncated even when a page is all-known');
  assert.equal(parser.stats.earlyStoppedSeries, 0);
  assert.equal(listings.length, 3);
});

test('incremental early-stop: SCRAPER_INCREMENTAL=false withholds the predicate (no early-stop)', async () => {
  const parser = new IncrementalTestParser({
    sorted: true,
    pages: [
      ['https://test.example/l/1', 'https://test.example/l/2'], // all known
      ['https://test.example/l/3'],
    ],
  });

  // Mirror the orchestrator's kill switch: it installs the predicate ONLY when
  // SCRAPER_INCREMENTAL !== 'false'. With it off, no predicate is installed.
  await withEnv({ SCRAPER_INCREMENTAL: 'false' }, async () => {
    const incrementalEnabled = process.env.SCRAPER_INCREMENTAL !== 'false';
    assert.equal(incrementalEnabled, false);
    if (incrementalEnabled) {
      parser.setKnownUrlPredicate(knownUrlPredicate('https://test.example/l/1', 'https://test.example/l/2'));
    }
    const listings = await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);
    assert.equal(parser.fetchedPages.length, 2, 'kill switch disables early-stop entirely');
    assert.equal(parser.stats.earlyStoppedSeries, 0);
    assert.equal(listings.length, 3);
  });
});

test('incremental early-stop: no predicate installed → no early-stop, no crash', async () => {
  const parser = new IncrementalTestParser({
    sorted: true,
    pages: [
      ['https://test.example/l/1', 'https://test.example/l/2'], // all known, but predicate absent
      ['https://test.example/l/3'],
    ],
  });
  // setKnownUrlPredicate is never called (this._isKnownUrl stays null).

  const listings = await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);

  assert.equal(parser.fetchedPages.length, 2, 'a parser with no predicate walks every page as before');
  assert.equal(parser.stats.earlyStoppedSeries, 0);
  assert.equal(listings.length, 3);
});

test('incremental early-stop: processScrapedListings surfaces earlyStoppedSeries in the site report', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new IncrementalTestParser({ sorted: true, pages: [[]] });
  parser.stats.earlyStoppedSeries = 4;
  const { ctx } = makeCtx();
  const siteReport = await processScrapedListings(parser, [], ctx);
  assert.equal(siteReport.earlyStoppedSeries, 4, 'the site report carries the early-stop count for the email');
});

// --- searchUrlsPlanned (zero-coverage false-alarm fix) ----------------------
// Regression coverage for the "TuttLand: 0 checked -> may be blocked or down"
// false alarm when a run's target counties fall entirely outside a source's
// coverage (buildSearchUrls() legitimately returns []).

test('searchUrlsPlanned: scrapeAll records 0 when buildSearchUrls returns no urls', async () => {
  const parser = new IncrementalTestParser({ sorted: true, pages: [] });

  const listings = await parser.scrapeAll([{ county: 'Texas', state: 'MO', maxCPA: 4000 }]);

  assert.equal(parser.stats.searchUrlsPlanned, 0);
  assert.equal(parser.fetchedPages.length, 0, 'a parser with no planned urls fetches nothing');
  assert.equal(listings.length, 0);
});

test('searchUrlsPlanned: scrapeAll records the planned count when buildSearchUrls returns urls', async () => {
  const parser = new IncrementalTestParser({
    sorted: true,
    pages: [
      ['https://test.example/l/1'],
      ['https://test.example/l/2'],
    ],
  });

  await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);

  assert.equal(parser.stats.searchUrlsPlanned, 2);
  assert.equal(parser.fetchedPages.length, 2);
});

test('searchUrlsPlanned: a retry pass (prepareForRetry) reflects its own coverage, not the first pass', async () => {
  const parser = new IncrementalTestParser({
    sorted: true,
    pages: [['https://test.example/l/1'], ['https://test.example/l/2']],
  });
  await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);
  assert.equal(parser.stats.searchUrlsPlanned, 2);

  parser.prepareForRetry();
  parser._pages = [];
  await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);

  assert.equal(parser.stats.searchUrlsPlanned, 0, 'reassigned fresh each scrapeAll call, not accumulated');
});

test('searchUrlsPlanned: processScrapedListings carries the field onto the site report', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new IncrementalTestParser({ sorted: true, pages: [] });
  await parser.scrapeAll([{ county: 'Taney', state: 'MO', maxCPA: 4000 }]);
  const { ctx } = makeCtx();

  const siteReport = await processScrapedListings(parser, [], ctx);

  assert.equal(siteReport.searchUrlsPlanned, 0);
});

test('incremental early-stop: consolidated email renders the incremental line', () => {
  const report = {
    dryRun: true,
    sites: {
      LandWatch: {
        status: 'ok', parsed: 12, passed: 2, wouldWrite: 2, duplicates: 5, earlyStoppedSeries: 7,
      },
    },
    totals: { written: 0, wouldWrite: 2, duplicates: 5, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 30,
  };
  const body = buildScraperBody(report, null, 'Test Day', null, null);
  assert.match(body, /incremental: stopped 7 county series early \(page of already-known listings\)/);
});

test('detail enrichment: consolidated email renders the detail-pages-fetched line', () => {
  const report = {
    dryRun: false,
    sites: {
      MossyOakProperties: {
        status: 'ok', parsed: 20, passed: 4, written: 4, duplicates: 0,
        enrichmentFetched: 4, enrichmentFailed: 1,
      },
    },
    totals: { written: 4, wouldWrite: 0, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 33,
  };
  const body = buildScraperBody(report, null, 'Test Day', null, null);
  assert.match(body, /detail pages fetched: 4 \(1 failed\)/);
});

test('county rotation: consolidated email renders the rotation line', () => {
  const report = {
    dryRun: true,
    sites: {
      landwatch: {
        status: 'ok', parsed: 40, passed: 5, wouldWrite: 5, duplicates: 0,
        rotation: { groupsTotal: 3, groupIndex: 1, sweptCount: 63, totalCount: 189 },
      },
    },
    totals: { written: 0, wouldWrite: 5, duplicates: 0, rejected: 0, errors: 0 },
    duplicateDetails: [], writeErrors: [], sourceIssues: [], warnings: [], elapsedMinutes: 42,
  };
  const body = buildScraperBody(report, null, 'Test Day', null, null);
  assert.match(body, /county rotation: swept 63 of 189 counties \(group 2 of 3\)/);
});
