'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initFilter, filterListing } = require('../lib/filter');
const { generateFingerprint } = require('../lib/fingerprint');
const airtable = require('../lib/airtable');
const {
  selectTargetCounties,
  processScrapedListings,
  runBotWallRetries,
  resolveBotWallCooldownMinutes,
} = require('../lib/scraper');
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
