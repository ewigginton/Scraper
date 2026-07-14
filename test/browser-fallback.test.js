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

test('fetchPageSmart rethrows non-403 errors without touching the browser', async (t) => {
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

test('scrapeAll still records a block when the browser also gets a challenge page', async (t) => {
  withStubbedBrowser(t, { enabled: true, html: '<html>Just a moment... px-captcha</html>' });
  const parser = makeParser();
  parser.sleep = async () => {};
  parser.fetchPage = async () => '<html>Just a moment... px-captcha</html>';

  const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
  assert.equal(listings.length, 0);
  assert.equal(parser.stats.blockedPages, 1);
});
