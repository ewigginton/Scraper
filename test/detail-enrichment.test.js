'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { initFilter } = require('../lib/filter');
const airtable = require('../lib/airtable');
const {
  processScrapedListings,
  detailEnrichmentEnabled,
  combineDescriptions,
  resolveMinAcres,
  DEFAULT_MIN_ACRES,
} = require('../lib/scraper');
const { analyzeLead, matchesKeyword } = require('../lib/review');
const BaseParser = require('../lib/parsers/base-parser');

// A parser whose detail fetch is scripted per URL and counted, so tests can
// assert exactly which listings triggered a detail-page fetch. scrapeAll is
// never driven here — processScrapedListings is called directly. sleep() is a
// no-op so the jittered enrichment delay never actually blocks.
class FakeEnrichParser extends BaseParser {
  constructor(detailHtmlByUrl = {}) {
    super('FakeEnrichSite');
    this._detailHtmlByUrl = detailHtmlByUrl;
    this.detailFetches = [];
    this._throwUrls = new Set();
  }
  sleep() { return Promise.resolve(); }
  throwFor(url) { this._throwUrls.add(url); }
  async fetchPageSmart(url) {
    this.detailFetches.push(url);
    if (this._throwUrls.has(url)) {
      const err = new Error(`HTTP 403 for ${url}`);
      err.status = 403;
      throw err;
    }
    return this._detailHtmlByUrl[url] || '<html><body><main><p>generic body prose here</p></main></body></html>';
  }
}

function makeCtx({ dryRun = false } = {}) {
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [], filterRejects: [], writeErrors: [], sourceIssues: [], warnings: [],
    dryRun,
  };
  const ctx = {
    dedupIndex: { urlSet: new Set(), fingerprintSet: new Set(), locationMap: new Map() },
    sessionFingerprints: new Map(),
    report,
    dryRun,
  };
  return { report, ctx };
}

// Stub airtable.writeListings (patched on the module object scraper.js calls
// through) so a non-dry-run pass never touches the live base. Captures the
// listings handed to the write so tests can inspect the persisted description.
function withStubbedWrite(fn) {
  const original = airtable.writeListings;
  const captured = [];
  airtable.writeListings = async (listings) => {
    captured.push(...listings);
    return { created: listings.length, errors: [] };
  };
  return Promise.resolve()
    .then(() => fn(captured))
    .finally(() => { airtable.writeListings = original; });
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

const detailPage = (bodyProse) => `
  <html><head>
    <meta property="og:description" content="OG summary line for this tract.">
    <meta name="description" content="Meta summary line for this tract.">
  </head><body>
    <nav>Home Listings Contact About</nav>
    <main>
      <h1>160 Acre Farm</h1>
      <div class="listing-body">
        <p>${bodyProse}</p>
      </div>
    </main>
    <footer>Copyright junk footer text that should be stripped</footer>
  </body></html>`;

test('enrichment: only to-be-written leads get a detail fetch; dupes and rejects do not', async () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const good = { name: 'Good Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://fake.example/good' };
  const dupe = { name: 'Dup Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://fake.example/dupe' };
  const reject = { name: 'Too Pricey', price: 900000, acres: 100, county: 'Taney', state: 'MO', url: 'https://fake.example/reject' };

  const parser = new FakeEnrichParser({
    'https://fake.example/good': detailPage('Rolling pasture with a live creek and mature timber.'),
  });
  const { report, ctx } = makeCtx({ dryRun: false });
  // Pre-seed the dedup index so `dupe` is caught as an existing URL.
  ctx.dedupIndex.urlSet.add(dupe.url);

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      const siteReport = await processScrapedListings(parser, [good, dupe, reject], ctx);

      assert.deepEqual(parser.detailFetches, [good.url], 'only the written lead is detail-fetched');
      assert.equal(siteReport.enrichmentFetched, 1);
      assert.equal(siteReport.enrichmentFailed, 0);
      assert.equal(siteReport.duplicates, 1);
      assert.equal(siteReport.rejected, 1);

      const written = captured.find(l => l.url === good.url);
      assert.ok(written, 'good lead was written');
      assert.match(written.description, /Rolling pasture with a live creek/, 'description extended with detail prose');
    })
  );
  assert.equal(report.totals.written, 1);
});

test('enrichment: a detail-fetch failure still writes the lead with the card blurb, and is counted', async () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const good = {
    name: 'Blurb Only', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://fake.example/fails', description: 'ORIGINAL CARD BLURB about the tract',
  };
  const parser = new FakeEnrichParser();
  parser.throwFor(good.url);

  const { ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      const siteReport = await processScrapedListings(parser, [good], ctx);

      assert.equal(parser.detailFetches.length, 1, 'the fetch was attempted');
      assert.equal(siteReport.enrichmentFetched, 0);
      assert.equal(siteReport.enrichmentFailed, 1, 'the failure is counted');

      const written = captured.find(l => l.url === good.url);
      assert.ok(written, 'lead still written despite enrichment failure');
      assert.equal(written.description, 'ORIGINAL CARD BLURB about the tract', 'blurb preserved unchanged');
    })
  );
});

test('enrichment: dry run / kill switch / CI all skip detail fetches entirely', async () => {
  initFilter(new Map([['taney|MO', 4000]]));

  // detailEnrichmentEnabled gate is the single source of truth.
  assert.equal(detailEnrichmentEnabled(true), false, 'dry run disables enrichment');
  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: 'false' }, () =>
    assert.equal(detailEnrichmentEnabled(false), false, 'kill switch disables enrichment'));
  await withEnv({ GITHUB_ACTIONS: '1', SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    assert.equal(detailEnrichmentEnabled(false), false, 'CI disables enrichment'));
  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    assert.equal(detailEnrichmentEnabled(false), true, 'default ON in a normal production run'));

  const good = { name: 'Good Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://fake.example/dry' };

  // Dry run: processScrapedListings must not fetch any detail page.
  const dryParser = new FakeEnrichParser();
  const { ctx: dryCtx } = makeCtx({ dryRun: true });
  const drySite = await processScrapedListings(dryParser, [{ ...good }], dryCtx);
  assert.equal(dryParser.detailFetches.length, 0, 'dry run performs zero detail fetches');
  assert.equal(drySite.enrichmentFetched, 0);

  // Kill switch: env=false, non-dry-run.
  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: 'false' }, () =>
    withStubbedWrite(async () => {
      const parser = new FakeEnrichParser();
      const { ctx } = makeCtx({ dryRun: false });
      await processScrapedListings(parser, [{ ...good }], ctx);
      assert.equal(parser.detailFetches.length, 0, 'kill switch performs zero detail fetches');
    }));

  // CI: GITHUB_ACTIONS set, non-dry-run.
  await withEnv({ GITHUB_ACTIONS: '1', SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async () => {
      const parser = new FakeEnrichParser();
      const { ctx } = makeCtx({ dryRun: false });
      await processScrapedListings(parser, [{ ...good }], ctx);
      assert.equal(parser.detailFetches.length, 0, 'CI performs zero detail fetches');
    }));
});

test('extractDetailDescription: pulls og:description + largest text block, and survives garbage HTML', () => {
  const parser = new FakeEnrichParser();

  const html = detailPage('This wooded tract sits under a conservation easement recorded in 2009.');
  const text = parser.extractDetailDescription(html);
  assert.match(text, /OG summary line/, 'includes og:description');
  assert.match(text, /conservation easement recorded in 2009/, 'includes the largest body prose block');
  assert.doesNotMatch(text, /Copyright junk footer/, 'stripped footer text excluded');
  assert.doesNotMatch(text, /Home Listings Contact About/, 'stripped nav text excluded');
  assert.ok(text.length <= 2000, 'capped at 2000 chars');

  // Garbage / weird HTML must never throw — best-effort returns a string.
  for (const junk of ['', null, undefined, '<<<>>> not html', '<html><body>', 42, {}]) {
    assert.doesNotThrow(() => parser.extractDetailDescription(junk));
    assert.equal(typeof parser.extractDetailDescription(junk), 'string');
  }
});

test('combineDescriptions: dedupes when detail already contains the blurb, else joins, always capped', () => {
  // Detail contains the blurb verbatim → keep only the fuller detail text.
  const merged = combineDescriptions('160 acres in Taney', 'Full listing: 160 acres in Taney with a creek and barn.');
  assert.equal(merged, 'Full listing: 160 acres in Taney with a creek and barn.');

  // Disjoint blurb + detail → both retained.
  const joined = combineDescriptions('CARD BLURB', 'DETAIL PROSE');
  assert.match(joined, /CARD BLURB/);
  assert.match(joined, /DETAIL PROSE/);

  // Cap enforced.
  const capped = combineDescriptions('x'.repeat(1000), 'y'.repeat(3000));
  assert.ok(capped.length <= 2400, 'combined description capped at ~2400 chars');
});

test('end-to-end: a detail page saying "under contract" is caught by Step 4.6 and never written (superseded write-then-flag behavior)', async () => {
  // Historically a fresh scrape whose DETAIL page (not the card) revealed
  // "under contract" was still written and only flagged on review night —
  // exactly the bug Emma reported (two LandWatch listings became New Leads
  // while already under contract). lib/scraper.js's Step 4.6 now skips it
  // before the write ever happens; see the "Step 4.6" tests below for the
  // full skip/reject pipeline coverage. analyzeLead's own under-contract
  // handling for EXISTING Airtable records (never auto-rejected, Emma
  // decides) is unchanged and covered separately in test/fixes.test.js.
  initFilter(new Map([['taney|MO', 4000]]));

  const listing = {
    name: 'Ridge Line Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://fake.example/ridge-line',
    description: '100 acres in Taney County — great hunting.', // card blurb never mentions status
  };
  const parser = new FakeEnrichParser({
    [listing.url]: detailPage('This property is under contract with a closing expected next month.'),
  });
  const { report, ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      await processScrapedListings(parser, [listing], ctx);
      assert.equal(captured.find(l => l.url === listing.url), undefined, 'must never reach the Airtable write');
      assert.equal(report.skippedUnavailable.length, 1);
      assert.match(report.skippedUnavailable[0].phrase, /under contract/);
    })
  );
});

test('end-to-end: a detail page conservation easement reaches the text analyzeLead scans', async () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const listing = {
    name: 'Drip Spring Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://fake.example/drip-spring',
    description: '100 acres in Taney County — great hunting.', // truncated card blurb, no easement mention
  };
  const parser = new FakeEnrichParser({
    [listing.url]: detailPage('The property is encumbered by a conservation easement held by a land trust.'),
  });
  const { ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      await processScrapedListings(parser, [listing], ctx);
      const written = captured.find(l => l.url === listing.url);
      assert.match(written.description, /conservation easement/, 'enriched description carries the easement language');

      // The enriched description lands in Scraper Notes (FIELDS.notes) — the
      // exact field analyzeLead keyword-scans (above the AUTO ANALYSIS marker).
      assert.ok(matchesKeyword(written.description, 'conservation easement'));
      const record = { fields: { [airtable.FIELDS.notes]: written.description } };
      const analysis = analyzeLead(record, { county: 'Taney', state: 'MO' });
      assert.ok(
        analysis.dealbreakers.includes('conservation easement'),
        `expected a conservation-easement dealbreaker, got: ${analysis.dealbreakers.join(', ')}`
      );
    })
  );
});

test('extractDetailDescription: hostile deeply-nested HTML is bounded — regex meta fallback, no DOM parse', () => {
  const parser = new FakeEnrichParser();
  // 60k nested divs would stall cheerio for ~30s+; the tag-count guard must
  // route this to the regex meta fallback and return quickly.
  const hostile = '<html><head>'
    + '<meta property="og:description" content="Beautiful 120 acre tract with a conservation easement in place.">'
    + '</head><body>' + '<div>'.repeat(60000) + 'x' + '</div>'.repeat(60000) + '</body></html>';
  const started = Date.now();
  const text = parser.extractDetailDescription(hostile);
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 2000, `guarded parse took ${elapsedMs}ms — DOM parse was not skipped`);
  assert.match(text, /conservation easement/i);
});

test('extractDetailDescription: oversized HTML is bounded — regex meta fallback', () => {
  const parser = new FakeEnrichParser();
  const oversized = '<html><head>'
    + '<meta name="description" content="Quiet 80 acres, sale pending.">'
    + '</head><body>' + '<p>filler</p>'.repeat(1) + 'a'.repeat(1200000) + '</body></html>';
  const started = Date.now();
  const text = parser.extractDetailDescription(oversized);
  assert.ok(Date.now() - started < 2000);
  assert.match(text, /sale pending/i);
});

// ---------- Step 4.6: post-enrichment availability skip + hard acreage floor ----------
// Regression coverage for Emma's three reported failures: two under-contract
// LandWatch listings that still became New Leads, and a 0.24ac listing
// recorded as 24ac with nothing enforcing the 40ac minimum in code.

test('resolveMinAcres: defaults to 40, honors SCRAPER_MIN_ACRES, falls back on junk', async () => {
  assert.equal(DEFAULT_MIN_ACRES, 40);
  await withEnv({ SCRAPER_MIN_ACRES: undefined }, () => assert.equal(resolveMinAcres(), 40));
  await withEnv({ SCRAPER_MIN_ACRES: '100' }, () => assert.equal(resolveMinAcres(), 100));
  await withEnv({ SCRAPER_MIN_ACRES: '0' }, () => assert.equal(resolveMinAcres(), 0));
  await withEnv({ SCRAPER_MIN_ACRES: 'not a number' }, () => assert.equal(resolveMinAcres(), 40));
});

test('Step 4.6: a listing whose card text matches an availability phrase is skipped, never written', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const listing = {
    name: 'Pending Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://fake.example/pending',
    description: 'Great pasture. This property is under contract as of last week.',
  };
  const parser = new FakeEnrichParser();
  const { report, ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      const siteReport = await processScrapedListings(parser, [listing], ctx);
      assert.equal(siteReport.skippedUnavailable, 1);
      assert.equal(report.totals.skippedUnavailable, 1);
      assert.equal(report.skippedUnavailable.length, 1);
      assert.equal(report.skippedUnavailable[0].phrase, 'under contract');
      assert.equal(report.skippedUnavailable[0].url, listing.url);
      assert.equal(captured.length, 0, 'skipped listing must never reach the Airtable write');
      assert.equal(siteReport.passed, 0, 'the earlier pass-count is backed out once skipped');
    })
  );
});

test('Step 4.6: end-to-end — a detail page revealing "under contract" AFTER card scraping still skips the write (Emma\'s LandWatch bug)', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const listing = {
    name: 'Ridge Line Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://fake.example/ridge-line-under-contract',
    description: '100 acres in Taney County — great hunting.', // card blurb never mentions status
  };
  const parser = new FakeEnrichParser({
    [listing.url]: detailPage('This property is under contract with a closing expected next month.'),
  });
  const { report, ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      await processScrapedListings(parser, [listing], ctx);
      assert.equal(captured.length, 0, 'must never reach Airtable once the detail page reveals under contract');
      assert.equal(report.skippedUnavailable.length, 1);
      assert.match(report.skippedUnavailable[0].phrase, /under contract/);
    })
  );
});

test('Step 4.6: "no restrictions" card text must never be mistaken for "under contract" (word-boundary match)', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const listing = {
    name: 'Open Tract', price: 300000, acres: 100, county: 'Taney', state: 'MO',
    url: 'https://fake.example/no-restrictions',
    description: 'Open pasture with no restrictions and paved road frontage.',
  };
  const parser = new FakeEnrichParser();
  const { report, ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined }, () =>
    withStubbedWrite(async (captured) => {
      const siteReport = await processScrapedListings(parser, [listing], ctx);
      assert.equal(siteReport.skippedUnavailable, 0);
      assert.equal(captured.length, 1, 'a normal listing must still be written');
    })
  );
});

test('Step 4.6: SCRAPER_MIN_ACRES overrides the default floor and rejects post-enrichment', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  // 50ac clears the existing filter.js check (fixed at 40) but must still be
  // rejected by the scraper.js floor once SCRAPER_MIN_ACRES=100 is set — this
  // is the "regardless of what the source URL's filter params claim" floor.
  const listing = {
    name: 'Fifty Acre Tract', price: 200000, acres: 50, county: 'Taney', state: 'MO', // $4000/ac = at target
    url: 'https://fake.example/fifty',
  };
  const parser = new FakeEnrichParser();
  const { report, ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined, SCRAPER_MIN_ACRES: '100' }, () =>
    withStubbedWrite(async (captured) => {
      const siteReport = await processScrapedListings(parser, [listing], ctx);
      assert.equal(siteReport.rejectedBelowMinAcres, 1);
      assert.equal(report.totals.rejectedBelowMinAcres, 1);
      assert.equal(report.totals.rejected, 1, 'folds into the generic rejected total too');
      assert.equal(captured.length, 0, 'below the overridden floor must never be written');
      assert.equal(siteReport.passed, 0, 'the earlier pass-count is backed out once rejected');
    })
  );
});

test('Step 4.6: a listing at/above the default 40ac floor is written normally (no false rejection)', async () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const listing = {
    name: 'Forty Acre Tract', price: 160000, acres: 40, county: 'Taney', state: 'MO', // $4000/ac = at target
    url: 'https://fake.example/forty',
  };
  const parser = new FakeEnrichParser();
  const { ctx } = makeCtx({ dryRun: false });

  await withEnv({ GITHUB_ACTIONS: undefined, SCRAPER_DETAIL_ENRICHMENT: undefined, SCRAPER_MIN_ACRES: undefined }, () =>
    withStubbedWrite(async (captured) => {
      const siteReport = await processScrapedListings(parser, [listing], ctx);
      assert.equal(siteReport.rejectedBelowMinAcres, 0);
      assert.equal(captured.length, 1, 'exactly-at-the-floor listing is written, not rejected');
    })
  );
});
