'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const browserFetch = require('../lib/browser-fetch');
const BaseParser = require('../lib/parsers/base-parser');

function makeParser() {
  const parser = new BaseParser('TestSite');
  parser.buildSearchUrls = () => [{ url: 'https://example.com/search?page=1', county: 'Wayne', state: 'KY', page: 1 }];
  parser.parseSearchPage = html => (html.includes('REAL LISTING')
    ? [{ name: 'Tract', price: 100000, acres: 50, county: 'Wayne', state: 'KY', url: 'https://example.com/l/1' }]
    : []);
  return parser;
}

function withStubbedBrowser(t, { enabled, html, error } = {}) {
  const original = {
    isEnabled: browserFetch.isEnabled,
    fetchPageWithBrowser: browserFetch.fetchPageWithBrowser,
  };
  browserFetch.isEnabled = () => enabled;
  browserFetch.fetchPageWithBrowser = async () => {
    if (error) throw error;
    return html;
  };
  t.after(() => Object.assign(browserFetch, original));
}

test('SCRAPER_BROWSER_FALLBACK=false disables the browser fallback', () => {
  const original = process.env.SCRAPER_BROWSER_FALLBACK;
  process.env.SCRAPER_BROWSER_FALLBACK = 'false';
  try {
    assert.equal(browserFetch.isEnabled(), false);
  } finally {
    if (original === undefined) delete process.env.SCRAPER_BROWSER_FALLBACK;
    else process.env.SCRAPER_BROWSER_FALLBACK = original;
  }
});

test('fetchPageSmart falls back to the browser on HTTP 403', async (t) => {
  withStubbedBrowser(t, { enabled: true, html: '<html>REAL LISTING</html>' });
  const parser = makeParser();
  parser.fetchPage = async () => {
    const err = new Error('HTTP 403 for url');
    err.status = 403;
    throw err;
  };

  const html = await parser.fetchPageSmart('https://example.com/search?page=1');
  assert.match(html, /REAL LISTING/);
});

test('fetchPageSmart does NOT browser-retry an HTTP 400 when the caller built the URL', async (t) => {
  // LandWatch 400s an unsupported URL SHAPE (production Aug 6 + Aug 9:
  // /oklahoma-land-for-sale/leflore-county and an acres-over segment). For
  // search URLs WE construct, the rejection is on the URL, not the client, so
  // a browser attempt burns ~30s on a guaranteed identical failure — scrapeAll
  // passes browserRetryOn400:false for exactly this case.
  let browserCalled = false;
  withStubbedBrowser(t, { enabled: true, html: '<html>REAL LISTING</html>' });
  const parser = makeParser();
  parser.browserFetch = async () => { browserCalled = true; return '<html>REAL LISTING</html>'; };
  parser.fetchPage = async () => {
    const err = new Error('HTTP 400 for url');
    err.status = 400;
    throw err;
  };

  await assert.rejects(
    () => parser.fetchPageSmart('https://example.com/search?page=1', { browserRetryOn400: false }),
    /HTTP 400/
  );
  assert.equal(browserCalled, false);
});

test('fetchPageSmart DOES browser-retry an HTTP 400 by default (third-party listing URLs)', async (t) => {
  // Intake and lead-recheck fetch listing URLs submitted by people or already
  // stored on records — third-party URLs where some bot managers answer a bad
  // TLS/HTTP2 fingerprint with 400 rather than 403 (the wall commit 6875f3b
  // was written to get past). Those callers must keep their browser retry, so
  // the default stays "retry"; only self-built search URLs opt out.
  let browserCalled = false;
  withStubbedBrowser(t, { enabled: true, html: '<html>REAL LISTING</html>' });
  const parser = makeParser();
  parser.browserFetch = async () => { browserCalled = true; return '<html>REAL LISTING</html>'; };
  parser.fetchPage = async () => {
    const err = new Error('HTTP 400 for url');
    err.status = 400;
    throw err;
  };

  const html = await parser.fetchPageSmart('https://third-party.example/listing/1');
  assert.match(html, /REAL LISTING/);
  assert.equal(browserCalled, true);
});

test('fetchPageSmart falls back to the browser on HTTP 429 once plain retries are exhausted', async (t) => {
  // fetchPage already retries 429 with backoff and rethrows when the budget
  // runs out; fetchPageSmart then gets its one browser attempt.
  withStubbedBrowser(t, { enabled: true, html: '<html>REAL LISTING</html>' });
  const parser = makeParser();
  parser.fetchPage = async () => {
    const err = new Error('HTTP 429 for url');
    err.status = 429;
    throw err;
  };

  const html = await parser.fetchPageSmart('https://example.com/search?page=1');
  assert.match(html, /REAL LISTING/);
});

test('fetchPageSmart rethrows non-bot-wall errors without touching the browser', async (t) => {
  let browserCalled = false;
  withStubbedBrowser(t, { enabled: true, html: '<html></html>' });
  const parser = makeParser();
  parser.browserFetch = async () => { browserCalled = true; return '<html></html>'; };
  parser.fetchPage = async () => {
    const err = new Error('HTTP 500 for url');
    err.status = 500;
    throw err;
  };

  await assert.rejects(() => parser.fetchPageSmart('https://example.com/x'), /HTTP 500/);
  assert.equal(browserCalled, false);
});

test('fetchPageSmart does NOT fall back on HTTP 404 (genuine removed listing)', async (t) => {
  let browserCalled = false;
  withStubbedBrowser(t, { enabled: true, html: '<html></html>' });
  const parser = makeParser();
  parser.browserFetch = async () => { browserCalled = true; return '<html></html>'; };
  parser.fetchPage = async () => {
    const err = new Error('HTTP 404 for url');
    err.status = 404;
    throw err;
  };

  await assert.rejects(() => parser.fetchPageSmart('https://example.com/x'), /HTTP 404/);
  assert.equal(browserCalled, false);
});

test('fetchPageSmart reports the original 403 when no browser is available', async (t) => {
  withStubbedBrowser(t, { enabled: true, error: Object.assign(new Error('no chrome'), { browserUnavailable: true }) });
  const parser = makeParser();
  parser.fetchPage = async () => {
    const err = new Error('HTTP 403 for url');
    err.status = 403;
    throw err;
  };

  await assert.rejects(() => parser.fetchPageSmart('https://example.com/x'), /HTTP 403/);
});

test('scrapeAll rescues an HTTP-200 challenge page through the browser', async (t) => {
  withStubbedBrowser(t, { enabled: true, html: '<html>REAL LISTING</html>' });
  const parser = makeParser();
  parser.sleep = async () => {};
  parser.fetchPage = async () => '<html><body>Just a moment... verify you are a human</body></html>';

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.equal(listings.length, 1);
  assert.equal(parser.stats.blockedPages, 0, 'rescued page must not count as blocked');
  assert.equal(parser.stats.browserFetches, 1);
});

test('scrapeAll rescues a hard HTTP 403 (plain fetch refused outright) through the browser', async (t) => {
  withStubbedBrowser(t, { enabled: true, html: '<html>REAL LISTING</html>' });
  const parser = makeParser();
  parser.sleep = async () => {};
  parser.fetchPage = async () => {
    const err = new Error('HTTP 403 for url');
    err.status = 403;
    throw err;
  };

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.equal(listings.length, 1);
  assert.equal(parser.stats.checked, 1, 'the rescued fetch still counts as a checked page');
  assert.equal(parser.stats.browserFetches, 1);
  assert.equal(parser.stats.blockedPages, 0, 'a rescued 403 must not count as blocked — fetchPageSmart never lets the error reach scrapeAll\'s catch block');
  assert.equal(parser.stats.errors, 0);
});

test('scrapeAll still records a block when the browser also gets a challenge page', async (t) => {
  withStubbedBrowser(t, { enabled: true, html: '<html>Just a moment... px-captcha</html>' });
  const parser = makeParser();
  parser.sleep = async () => {};
  parser.fetchPage = async () => '<html>Just a moment... px-captcha</html>';

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.equal(listings.length, 0);
  assert.equal(parser.stats.blockedPages, 1);
});

test('scrapeAll records a hard 400 as unsupported_url — never blocked, and the run continues', async (t) => {
  // The kill-switch regression this guards: LandWatch answers an unsupported
  // URL shape with 400, and counting those as bot-wall blocks tripped
  // BLOCKED_PAGES_ABORT_THRESHOLD, abandoning every remaining county for the
  // night (Aug 6 + Aug 9 nightlies).
  withStubbedBrowser(t, { enabled: false });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  // Eight distinct county series — more than both circuit-breaker thresholds
  // could tolerate if 400s counted toward either one.
  const counties = ['Wayne', 'Pike', 'Shannon', 'Taney', 'Butler', 'Ripley', 'Carter', 'Dent'];
  parser.buildSearchUrls = () => counties.map(county => ({
    url: `https://example.com/${county}/search?page=1`, county, state: 'MO', page: 1,
  }));
  parser.parseSearchPage = () => [];
  const fetched = [];
  parser.fetchPage = async (url) => {
    fetched.push(url);
    const err = new Error(`HTTP 400 for ${url}`);
    err.status = 400;
    throw err;
  };

  const listings = await parser.scrapeAll(counties.map(county => ({ county, state: 'MO' })));
  assert.equal(listings.length, 0);
  assert.equal(parser.stats.blockedPages, 0, 'a 400 is not a bot-wall block');
  assert.equal(parser.stats.errorPages, 0, 'nor a generic error page — it must not feed that breaker either');
  assert.equal(parser.stats.unsupportedUrlPages, 8);
  assert.equal(fetched.length, 8, 'a handful of bad URL shapes must not abandon the site');
  assert.ok(!parser.sourceIssues.some(issue => issue.type === 'site_abandoned'),
    'isolated unsupported URL shapes must never abandon the site');
  assert.equal(parser.sourceIssues.filter(issue => issue.type === 'unsupported_url').length, 8);
  assert.equal(parser.stats.abortedByBotWall, false);
});

test('scrapeAll DOES abandon the site once unsupported-URL 400s look sitewide', async (t) => {
  // The flip side of the test above. Tolerating isolated 400s must not mean
  // tolerating unlimited ones: when every county 400s, the site's URL scheme
  // changed and the run should stop rather than walk all 189 counties through
  // a headed browser. Commit 6875f3b logged 2,525 failed LandWatch fetches
  // over ~6h the last time this was unbounded.
  withStubbedBrowser(t, { enabled: false });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  const counties = Array.from({ length: 30 }, (_, i) => `County${i}`);
  parser.buildSearchUrls = () => counties.map(county => ({
    url: `https://example.com/${county}/search?page=1`, county, state: 'MO', page: 1,
  }));
  parser.parseSearchPage = () => [];
  const fetched = [];
  parser.fetchPage = async (url) => {
    fetched.push(url);
    const err = new Error(`HTTP 400 for ${url}`);
    err.status = 400;
    throw err;
  };

  await parser.scrapeAll(counties.map(county => ({ county, state: 'MO' })));
  assert.equal(parser.stats.unsupportedUrlPages, 12, 'stops at the unsupported-URL threshold');
  assert.equal(fetched.length, 12, 'the remaining 18 counties are never requested');
  const abandoned = parser.sourceIssues.filter(issue => issue.type === 'site_abandoned');
  assert.equal(abandoned.length, 1);
  assert.match(abandoned[0].error, /URL scheme looks broken/);
  assert.equal(parser.stats.blockedPages, 0, 'still not counted as a bot wall');
  assert.equal(parser.stats.abortedByBotWall, false,
    'no post-cooldown retry — a cooldown cannot make a wrong URL right');
});

test('scrapeAll exhausts a 400 series so its deeper pages are never requested', async (t) => {
  withStubbedBrowser(t, { enabled: false });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  // One county, pages 1-3 in the LandWatch /page-N shape: page 1 400s, so the
  // series is exhausted and pages 2-3 must not be fetched.
  parser.buildSearchUrls = () => [1, 2, 3].map(page => ({
    url: page === 1
      ? 'https://example.com/wayne-county/acres-over-150'
      : `https://example.com/wayne-county/acres-over-150/page-${page}`,
    county: 'Wayne',
    state: 'KY',
    page,
  }));
  parser.parseSearchPage = () => [];
  const fetched = [];
  parser.fetchPage = async (url) => {
    fetched.push(url);
    const err = new Error(`HTTP 400 for ${url}`);
    err.status = 400;
    throw err;
  };

  await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.deepEqual(fetched, ['https://example.com/wayne-county/acres-over-150']);
  assert.equal(parser.stats.unsupportedUrlPages, 1);
  assert.equal(parser.stats.blockedPages, 0);
});

test('scrapeAll still counts a hard 403 as blocked and aborts the site after 5', async (t) => {
  // The browser attempt fails, so fetchPageSmart rethrows the original 403
  // into scrapeAll's catch block, where isBotWallStatus(403) marks it blocked.
  withStubbedBrowser(t, { enabled: true, error: new Error('browser navigation failed') });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  // Six distinct county series so each contributes one blocked page — a single
  // county series collapses to one seriesKey and would only block once.
  const counties = ['Wayne', 'Pike', 'Shannon', 'Taney', 'Butler', 'Ripley'];
  parser.buildSearchUrls = () => counties.map(county => ({
    url: `https://example.com/${county}/search?page=1`, county, state: 'MO', page: 1,
  }));
  parser.parseSearchPage = () => [];
  parser.fetchPage = async () => {
    const err = new Error('HTTP 403 for url');
    err.status = 403;
    throw err;
  };

  const listings = await parser.scrapeAll(counties.map(county => ({ county, state: 'MO' })));
  assert.equal(listings.length, 0);
  // Circuit breaker trips at BLOCKED_PAGES_ABORT_THRESHOLD (5); the 6th county
  // is skipped, so exactly 5 pages count as blocked.
  assert.equal(parser.stats.blockedPages, 5);
  assert.ok(parser.sourceIssues.some(issue => issue.type === 'site_abandoned'),
    'the run must abandon the site with a site_abandoned source issue');
  assert.equal(parser.stats.abortedByBotWall, true, 'a real bot wall still arms the cooldown retry');
});

test('a 400 storm does not stop a later blocked page from tripping the bot-wall breaker', async (t) => {
  // Mixed run: the unsupported-URL pass must neither trip the breaker itself
  // nor mask a genuine wall that starts partway through the run.
  withStubbedBrowser(t, { enabled: false });
  const counties = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  parser.buildSearchUrls = () => counties.map(county => ({
    url: `https://example.com/${county}/search?page=1`, county, state: 'OK', page: 1,
  }));
  parser.parseSearchPage = () => [];
  parser.fetchPage = async (url) => {
    const county = url.match(/example\.com\/([A-Z])\//)[1];
    const status = ['A', 'B', 'C', 'D', 'E', 'F'].includes(county) ? 400 : 403;
    const err = new Error(`HTTP ${status} for ${url}`);
    err.status = status;
    throw err;
  };

  await parser.scrapeAll(counties.map(county => ({ county, state: 'OK' })));
  assert.equal(parser.stats.unsupportedUrlPages, 6);
  assert.equal(parser.stats.blockedPages, 5, 'the 5 403s trip the breaker; the 12th county is skipped');
  assert.ok(parser.sourceIssues.some(issue => issue.type === 'site_abandoned'));
});

// Build a parser with N distinct county series, each a single page-1 URL, so
// every county contributes exactly one fetch to the error accounting.
function makeMultiCountyParser(counties, state = 'OK') {
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  parser.buildSearchUrls = () => counties.map(county => ({
    url: `https://example.com/${county}/search?page=1`, county, state, page: 1,
  }));
  parser.parseSearchPage = () => [];
  return parser;
}

test('scrapeAll exhausts a county series on a page-1 fetch error (deeper pages never fetched)', async (t) => {
  withStubbedBrowser(t, { enabled: false });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  // A single county with pages 1-3; page 1 404s, so 2 and 3 must be skipped.
  parser.buildSearchUrls = () => [1, 2, 3].map(page => ({
    url: `https://example.com/wayne/search?page=${page}`, county: 'Wayne', state: 'KY', page,
  }));
  parser.parseSearchPage = () => [];
  const fetched = [];
  parser.fetchPage = async (url) => {
    fetched.push(url);
    const err = new Error(`HTTP 404 for ${url}`);
    err.status = 404;
    throw err;
  };

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.equal(listings.length, 0);
  assert.equal(fetched.length, 1, 'only page 1 is fetched — the 404 exhausts the series');
  assert.match(fetched[0], /page=1/);
  assert.equal(parser.stats.errorPages, 1);
  assert.equal(parser.stats.blockedPages, 0, 'a 404 is not a bot-wall block');
});

test('scrapeAll aborts the site after ERROR_PAGES_ABORT_THRESHOLD (10) 404 pages, skipping the rest', async (t) => {
  withStubbedBrowser(t, { enabled: false });
  // 12 distinct counties; the breaker should trip on the 11th iteration after
  // 10 error pages, leaving counties 11 and 12 unfetched.
  const counties = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  const parser = makeMultiCountyParser(counties);
  const fetched = [];
  parser.fetchPage = async (url) => {
    fetched.push(url);
    const err = new Error(`HTTP 404 for ${url}`);
    err.status = 404;
    throw err;
  };

  const listings = await parser.scrapeAll(counties.map(county => ({ county, state: 'OK' })));
  assert.equal(listings.length, 0);
  assert.equal(parser.stats.errorPages, 10, 'exactly 10 error pages before the breaker trips');
  assert.equal(fetched.length, 10, 'the remaining 2 counties are skipped');
  const abandoned = parser.sourceIssues.find(issue => issue.type === 'site_abandoned');
  assert.ok(abandoned, 'the run must abandon the site with a site_abandoned source issue');
  assert.match(abandoned.error, /Aborted after 10 error pages \(mostly HTTP 404\)/);
  assert.match(abandoned.error, /remaining counties skipped/);
});

test('a non-bot-wall abort does NOT set abortedByBotWall (no cooldown retry queued)', async (t) => {
  withStubbedBrowser(t, { enabled: false });
  const counties = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
  const parser = makeMultiCountyParser(counties);
  parser.fetchPage = async (url) => {
    const err = new Error(`HTTP 404 for ${url}`);
    err.status = 404;
    throw err;
  };

  await parser.scrapeAll(counties.map(county => ({ county, state: 'OK' })));
  assert.equal(parser.stats.errorPages, 10);
  // The cooldown retry in lib/scraper.js is gated on this flag — a 404 storm
  // must NOT queue a retry (it won't heal in an hour).
  assert.equal(parser.stats.abortedByBotWall, false, 'error-storm abort must not arm the bot-wall retry');
  assert.equal(parser.stats.abortedAt, null);
});

test('site_abandoned error text reflects the dominant error status among mixed errors', async (t) => {
  withStubbedBrowser(t, { enabled: false });
  const counties = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
  const parser = makeMultiCountyParser(counties);
  // 7 counties 404, 3 return 500 — 404 is the dominant error.
  const status = { A: 404, B: 404, C: 500, D: 404, E: 500, F: 404, G: 404, H: 500, I: 404, J: 404 };
  parser.fetchPage = async (url) => {
    const county = url.match(/example\.com\/([A-Z])\//)[1];
    const code = status[county] || 404;
    const err = new Error(`HTTP ${code} for ${url}`);
    err.status = code;
    throw err;
  };

  await parser.scrapeAll(counties.map(county => ({ county, state: 'OK' })));
  assert.equal(parser.stats.errorPages, 10);
  const abandoned = parser.sourceIssues.find(issue => issue.type === 'site_abandoned');
  assert.ok(abandoned);
  assert.match(abandoned.error, /mostly HTTP 404/, 'the more common status (404, 7x) wins over 500 (3x)');
});

test('an unrendered JS shell is recovered by a browser render, not written off as drift', async (t) => {
  // The Whitetail failure signature: HTTP 200, zero cards, four nights
  // running, reported as markup drift with no way to tell whether the fix was
  // new selectors or browser rendering. If the page is an empty SPA shell,
  // one real render answers it.
  withStubbedBrowser(t, { enabled: true, html: '<html><body>REAL</body></html>' });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  parser.buildSearchUrls = () => ([{ url: 'https://example.com/wayne', county: 'Wayne', state: 'KY', page: 1 }]);
  parser.fetchPage = async () => '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  parser.browserFetch = async () => '<html><body><div class="card">Rendered Tract 80 acres $200,000</div></body></html>';
  parser.parseSearchPage = (html) => {
    parser._lastCardCount = html.includes('card') ? 1 : 0;
    return html.includes('card') ? [{ url: 'https://example.com/1', acres: 80, price: 200000 }] : [];
  };

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.equal(listings.length, 1, 'the browser render recovered the listing');
  assert.equal(parser.stats.shellRetries, 1);
  assert.equal(parser.stats.shellRecoveries, 1);
  assert.equal(parser.stats.driftPages, 0, 'a recovered page is not drift');
});

test('an unrendered shell with no browser is reported as needing rendering, not stale selectors', async (t) => {
  withStubbedBrowser(t, { enabled: false });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  parser.buildSearchUrls = () => ([{ url: 'https://example.com/wayne', county: 'Wayne', state: 'KY', page: 1 }]);
  parser.fetchPage = async () => '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  parser.parseSearchPage = () => { parser._lastCardCount = 0; return []; };

  await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  const issues = parser.sourceIssues.filter(i => i.type === 'unrendered_shell');
  assert.equal(issues.length, 1, 'classified as a shell, not markup_drift');
  assert.match(issues[0].error, /needs browser rendering/);
  assert.equal(parser.sourceIssues.filter(i => i.type === 'markup_drift').length, 0);
});

test('a genuinely redesigned page is still reported as markup drift', async (t) => {
  // The detector must not steal real drift cases: a redesigned page still has
  // nav/body/footer copy, so it fails the "no visible text" half of the test.
  withStubbedBrowser(t, { enabled: false });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  parser.buildSearchUrls = () => ([{ url: 'https://example.com/wayne', county: 'Wayne', state: 'KY', page: 1 }]);
  parser.fetchPage = async () => `<html><body><div id="root"><nav>Home About Listings</nav>
    <main><h1>Wayne County Land For Sale</h1><p>${'Browse rural property and hunting land in Wayne County Kentucky. '.repeat(20)}</p></main>
    <footer>Copyright 2026 Example Realty</footer></div></body></html>`;
  parser.parseSearchPage = () => { parser._lastCardCount = 0; return []; };

  await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.equal(parser.sourceIssues.filter(i => i.type === 'markup_drift').length, 1);
  assert.equal(parser.sourceIssues.filter(i => i.type === 'unrendered_shell').length, 0);
});

test('shell browser-retries stop after the budget when they never recover', async (t) => {
  withStubbedBrowser(t, { enabled: true, html: '<html><body><div id="root"></div></body></html>' });
  const parser = new BaseParser('TestSite');
  parser.sleep = async () => {};
  const counties = Array.from({ length: 20 }, (_, i) => `County${i}`);
  parser.buildSearchUrls = () => counties.map(county => ({
    url: `https://example.com/${county}`, county, state: 'KY', page: 1,
  }));
  const shell = '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  parser.fetchPage = async () => shell;
  parser.browserFetch = async () => shell; // render never helps
  parser.parseSearchPage = () => { parser._lastCardCount = 0; return []; };

  await parser.scrapeAll(counties.map(county => ({ county, state: 'KY' })));
  assert.equal(parser.stats.shellRecoveries, 0);
  assert.equal(parser.stats.shellRetries, 5, 'budget caps wasted browser renders');
});
