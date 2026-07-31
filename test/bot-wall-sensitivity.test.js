'use strict';

// Bot-wall SENSITIVITY profile (config `sites.<key>.botWallSensitive`).
// The CoStar-network sources are Emma's biggest lead sources AND the most
// aggressive bot-managers, scraped from a residential IP whose reputation must
// never be degraded. One bad response is the entire budget: abort the site
// immediately, crawl at half speed, and never come back the same night.

const test = require('node:test');
const assert = require('node:assert/strict');

const browserFetch = require('../lib/browser-fetch');
const BaseParser = require('../lib/parsers/base-parser');
const settings = require('../config/settings.json');
const { getEnabledParsers } = require('../lib/parsers');
const { initFilter } = require('../lib/filter');
const { processScrapedListings, runBotWallRetries } = require('../lib/scraper');

const CHALLENGE_HTML = '<html><body>Just a moment... px-captcha</body></html>';

// Every test here must stay offline — no land-listing domain is ever contacted.
// Parsers get a stubbed fetchPage; the browser fallback is stubbed off so a
// challenge page is never "rescued" and the blocked-page accounting is exact.
function withBrowserDisabled(t) {
  const original = {
    isEnabled: browserFetch.isEnabled,
    fetchPageWithBrowser: browserFetch.fetchPageWithBrowser,
  };
  browserFetch.isEnabled = () => false;
  browserFetch.fetchPageWithBrowser = async () => {
    throw new Error('browser must not be used in these tests');
  };
  t.after(() => Object.assign(browserFetch, original));
}

// N distinct county series, each one page-1 URL, so every county contributes
// exactly one fetch to the blocked-page accounting.
function makeMultiCountyParser(counties, { sensitive } = {}) {
  const parser = new BaseParser('TestSite');
  parser.botWallSensitive = Boolean(sensitive);
  parser.sleep = async () => {};
  parser.buildSearchUrls = () => counties.map(county => ({
    url: `https://example.com/${county}/search?page=1`, county, state: 'MO', page: 1,
  }));
  parser.parseSearchPage = () => [];
  return parser;
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

// --- 1. Config flag plumbing ---------------------------------------------

test('the four CoStar-network sites carry botWallSensitive and stay disabled', () => {
  for (const key of ['landwatch', 'landcom', 'landfarm', 'landsofamerica']) {
    assert.equal(settings.sites[key].botWallSensitive, true, `${key} must be bot-wall sensitive`);
    assert.equal(settings.sites[key].enabled, false, `${key} must stay disabled pending the selector rebuild`);
  }
});

test('getEnabledParsers puts botWallSensitive on the parser instance', () => {
  // Synthetic site settings: the real CoStar entries are disabled, so enable
  // one here to prove the flag travels from config to the instance.
  const parsers = getEnabledParsers({
    landwatch: { enabled: true, countyRotation: 3, botWallSensitive: true },
    tuttland: { enabled: true },
  });

  const byKey = new Map(parsers.map(p => [p.siteKey, p]));
  assert.equal(byKey.size, 2);
  assert.equal(byKey.get('landwatch').botWallSensitive, true);
  assert.equal(byKey.get('landwatch').countyRotation, 3, 'existing per-site plumbing still works');
  assert.equal(byKey.get('tuttland').botWallSensitive, false,
    'a site with no flag must read false, not undefined');
});

test('a directly constructed parser defaults to not sensitive', () => {
  assert.equal(new BaseParser('Plain').botWallSensitive, false);
  assert.equal(new BaseParser('Plain').blockedPagesAbortThreshold(), 5);
  assert.equal(new BaseParser('Plain').requestDelayMultiplier(), 1);
});

// --- 2. Circuit breaker: threshold 1 for sensitive sources ----------------

test('a bot-sensitive site abandons the run after exactly ONE blocked page', async (t) => {
  withBrowserDisabled(t);
  const counties = ['Wayne', 'Pike', 'Shannon', 'Taney', 'Butler', 'Ripley'];
  const parser = makeMultiCountyParser(counties, { sensitive: true });
  const fetched = [];
  parser.fetchPage = async (url) => { fetched.push(url); return CHALLENGE_HTML; };

  const listings = await parser.scrapeAll(counties.map(county => ({ county, state: 'MO' })));

  assert.equal(listings.length, 0);
  assert.equal(fetched.length, 1, 'exactly one request is made — the 2nd county is never fetched');
  assert.equal(parser.stats.blockedPages, 1);
  const abandoned = parser.sourceIssues.find(issue => issue.type === 'site_abandoned');
  assert.ok(abandoned, 'the run must abandon the site with a site_abandoned source issue');
  assert.match(abandoned.error, /[Bb]ot-sensitive source/);
  assert.match(abandoned.error, /IP reputation/);
  assert.match(abandoned.error, /remaining counties skipped/);
  assert.equal(parser.stats.abortedByBotWall, true, 'still reported as a bot-wall abort');
  assert.ok(typeof parser.stats.abortedAt === 'number');
});

test('a normal site still tolerates up to the old threshold (5 blocked pages)', async (t) => {
  withBrowserDisabled(t);
  const counties = ['Wayne', 'Pike', 'Shannon', 'Taney', 'Butler', 'Ripley'];
  const parser = makeMultiCountyParser(counties, { sensitive: false });
  const fetched = [];
  parser.fetchPage = async (url) => { fetched.push(url); return CHALLENGE_HTML; };

  await parser.scrapeAll(counties.map(county => ({ county, state: 'MO' })));

  assert.equal(parser.stats.blockedPages, 5, 'non-sensitive behavior unchanged');
  assert.equal(fetched.length, 5, 'the 6th county is skipped by the breaker');
  const abandoned = parser.sourceIssues.find(issue => issue.type === 'site_abandoned');
  assert.ok(abandoned);
  assert.match(abandoned.error, /Aborted after 5 blocked pages/);
  assert.doesNotMatch(abandoned.error, /bot-sensitive/i,
    'the sensitivity wording must not leak into normal sources');
});

test('a bot-sensitive site is NOT abandoned early on non-bot-wall errors', async (t) => {
  // The tightened threshold applies to BLOCKED pages only — a 404 is not
  // evidence of a bot wall and must not change the error-storm accounting.
  withBrowserDisabled(t);
  const counties = ['A', 'B', 'C', 'D', 'E'];
  const parser = makeMultiCountyParser(counties, { sensitive: true });
  parser.fetchPage = async (url) => {
    const err = new Error(`HTTP 404 for ${url}`);
    err.status = 404;
    throw err;
  };

  await parser.scrapeAll(counties.map(county => ({ county, state: 'MO' })));

  assert.equal(parser.stats.blockedPages, 0);
  assert.equal(parser.stats.errorPages, 5, 'all 5 counties are walked — the error breaker is still 10');
  assert.equal(parser.stats.abortedByBotWall, false);
});

// --- 3. Request-delay multiplier (asserted via the sleep seam) ------------

// Drive one clean page fetch and return the delays scrapeAll asked for.
// Math.random is pinned so the jitter factor is identical across both runs —
// the assertion is on the sleep ARGUMENT, never on wall-clock time.
async function recordScrapeDelays(t, { sensitive, requestDelayMs }) {
  withBrowserDisabled(t);
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => { Math.random = originalRandom; });

  const parser = new BaseParser('TestSite');
  parser.botWallSensitive = sensitive;
  parser.buildSearchUrls = () => [{ url: 'https://example.com/wayne/search?page=1', county: 'Wayne', state: 'KY', page: 1 }];
  // Return a real listing so no drift/blocked bookkeeping runs.
  parser.parseSearchPage = () => [{
    name: 'Tract', price: 100000, acres: 50, county: 'Wayne', state: 'KY', url: 'https://example.com/l/1',
  }];
  parser.fetchPage = async () => '<html>REAL LISTING</html>';

  const delays = [];
  parser.sleep = async (ms) => { delays.push(ms); };

  await withEnv({ SCRAPER_REQUEST_DELAY_MS: String(requestDelayMs) }, () =>
    parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]));

  return delays;
}

test('a bot-sensitive parser sleeps 2x the configured request delay (jitter preserved)', async (t) => {
  const requestDelayMs = 1000;
  const jitterFactor = 0.75 + 0.5 * 1.25; // Math.random pinned to 0.5

  const normal = await recordScrapeDelays(t, { sensitive: false, requestDelayMs });
  const sensitive = await recordScrapeDelays(t, { sensitive: true, requestDelayMs });

  assert.equal(normal.length, 1);
  assert.equal(sensitive.length, 1);
  assert.equal(normal[0], requestDelayMs * jitterFactor,
    'non-sensitive delay is the configured delay with jitter — unchanged');
  assert.equal(sensitive[0], requestDelayMs * 2 * jitterFactor,
    'sensitive delay doubles the base BEFORE jitter, so jitter is preserved');
  assert.equal(sensitive[0] / normal[0], 2);
  // Jitter is still applied (not flattened to the bare multiplied base).
  assert.notEqual(sensitive[0], requestDelayMs * 2);
});

// --- 4. No same-night post-cooldown retry for sensitive sources ----------

const VALID_LISTING = {
  name: 'Retry Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://retry.example/1',
};

// Scripted parser stub: each scrapeAll call consumes one pass. sleep() is a
// no-op so no cooldown ever actually blocks the test.
class FakeBotWallParser extends BaseParser {
  constructor(name, passes, { sensitive } = {}) {
    super(name);
    this.botWallSensitive = Boolean(sensitive);
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
  if (!parser.stats.abortedByBotWall) return null;
  return { parser, abortedAt: parser.stats.abortedAt, firstPass: siteReport };
}

test('bot-sensitive site gets NO post-cooldown retry, with an explanatory warning', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new FakeBotWallParser('SensitiveSite', [
    { listings: [], abort: true },
    { listings: [VALID_LISTING], abort: false }, // must never be consumed
  ], { sensitive: true });
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_BOTWALL_COOLDOWN_MINUTES: '60' }, async () => {
    const aborted = await runFirstPass(parser, ctx);
    assert.ok(aborted, 'first pass should register the breaker abort');
    await runBotWallRetries([aborted], ctx, []);
  });

  assert.equal(parser.scrapeCalls, 1, 'the sensitive site is never hit a second time tonight');
  assert.equal(report.sites.SensitiveSite.status, 'ok', 'site keeps its first-pass status');
  const warning = report.warnings.find(w => w.startsWith('SensitiveSite:'));
  assert.ok(warning, `expected a warning for the sensitive site, got: ${report.warnings.join(' | ')}`);
  assert.match(warning, /bot-sensitive source: no same-night retry, protecting IP reputation/);
  assert.match(warning, /by design/);
});

test('a sensitive site skipping its retry does not suppress a non-sensitive site\'s retry', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const sensitive = new FakeBotWallParser('SensitiveSite', [{ listings: [], abort: true }], { sensitive: true });
  const normal = new FakeBotWallParser('NormalSite', [
    { listings: [], abort: true },
    { listings: [VALID_LISTING], abort: false },
  ]);
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_BOTWALL_COOLDOWN_MINUTES: '60' }, async () => {
    const abortedSensitive = await runFirstPass(sensitive, ctx);
    const abortedNormal = await runFirstPass(normal, ctx);
    await runBotWallRetries([abortedSensitive, abortedNormal], ctx, []);
  });

  assert.equal(sensitive.scrapeCalls, 1, 'sensitive site: no retry');
  assert.equal(normal.scrapeCalls, 2, 'non-sensitive behavior unchanged — still gets its one retry');
  assert.equal(report.sites.NormalSite.status, 'retried_after_cooldown');
  assert.equal(report.totals.passed, 1, 'the non-sensitive retry listing still reaches the report');
  assert.ok(
    report.warnings.some(w => /^NormalSite:.*retried after .* cooldown — succeeded/.test(w)),
    `expected a success retry warning for NormalSite, got: ${report.warnings.join(' | ')}`
  );
});

test('an all-sensitive abort list never reaches the cooldown path', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const parser = new FakeBotWallParser('SensitiveSite', [{ listings: [], abort: true }], { sensitive: true });
  const { report, ctx } = makeCtx();

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_BOTWALL_COOLDOWN_MINUTES: '60' }, async () => {
    const aborted = await runFirstPass(parser, ctx);
    await runBotWallRetries([aborted], ctx, []);
  });

  // Exactly one warning, and it is the sensitivity one — no cooldown-disabled
  // or retried-after-cooldown noise for this site.
  const siteWarnings = report.warnings.filter(w => w.startsWith('SensitiveSite:'));
  assert.equal(siteWarnings.length, 1, `expected one warning, got: ${siteWarnings.join(' | ')}`);
  assert.doesNotMatch(siteWarnings[0], /retried after/);
});
