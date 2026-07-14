'use strict';

/**
 * End-to-end tests for the browser fallback using a REAL Chromium against a
 * local server that behaves like a CoStar bot wall:
 *   - plain HTTP clients (node-fetch never advertises brotli) get HTTP 403
 *     or a JS challenge page
 *   - a real browser passes the header check / executes the challenge JS
 *     and sees the listings
 *
 * Skipped automatically when no Chrome/Chromium can be launched on this
 * machine (the wiring itself is covered by browser-fallback.test.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// npm test disables the fallback globally so unit tests that simulate 403s
// never launch a real browser — this file is the exception and opts back in
delete process.env.SCRAPER_BROWSER_FALLBACK;

const browserFetch = require('../lib/browser-fetch');
const BaseParser = require('../lib/parsers/base-parser');

const LISTING_CARD = '<div class="card"><a href="/pid/123">Wayne Tract</a><span>160 acres</span><span>$400,000</span></div>';

// A request from a real browser advertises brotli ("br") in Accept-Encoding;
// node-fetch v2 sends "gzip,deflate". This is a genuine client difference,
// not a test backdoor.
function isBrowserRequest(req) {
  return (req.headers['accept-encoding'] || '').includes('br');
}

function makeParser() {
  const parser = new BaseParser('E2ESite');
  parser.sleep = async () => {};
  parser.buildSearchUrls = counties => counties.map(c => ({
    url: `${parser._baseUrl}/search?county=${c.county}`,
    county: c.county,
    state: c.state,
    page: 1,
  }));
  parser.parseSearchPage = html => {
    const cards = html.match(/class="card"/g) || [];
    parser._lastCardCount = cards.length;
    if (cards.length === 0) return [];
    return [{ name: 'Wayne Tract', price: 400000, acres: 160, county: 'Wayne', state: 'KY', url: `${parser._baseUrl}/pid/123` }];
  };
  return parser;
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function browserIsLaunchable() {
  if (!browserFetch.isEnabled()) return false;
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>probe</body></html>');
  });
  try {
    await browserFetch.fetchPageWithBrowser(`${baseUrl}/probe`, { timeoutMs: 30000 });
    return true;
  } catch (_) {
    return false;
  } finally {
    server.close();
  }
}

test('e2e: browser fallback', { timeout: 120000 }, async (t) => {
  if (!(await browserIsLaunchable())) {
    await browserFetch.closeBrowser();
    t.skip(`no launchable browser here (${browserFetch.reasonUnavailable() || 'launch failed'})`);
    return;
  }
  t.after(async () => { await browserFetch.closeBrowser(); });

  await t.test('hard 403 for plain clients is rescued by the real browser', async () => {
    const { server, baseUrl } = await startServer((req, res) => {
      if (!isBrowserRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('Forbidden');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>${LISTING_CARD}</body></html>`);
    });

    try {
      const parser = makeParser();
      parser._baseUrl = baseUrl;
      const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);

      assert.equal(listings.length, 1, 'listing must be recovered through the browser');
      assert.equal(listings[0].name, 'Wayne Tract');
      assert.equal(parser.stats.browserFetches, 1);
      assert.equal(parser.stats.blockedPages, 0, 'a rescued 403 must not count as blocked');
    } finally {
      server.close();
    }
  });

  await t.test('HTTP-200 JS challenge page is rescued by the real browser', async () => {
    // The listing markup must NOT appear in the raw page source (a real
    // challenge page doesn't contain the content) — ship it base64-encoded
    // so only a JS-executing client materializes it in the DOM
    const encodedCard = Buffer.from(LISTING_CARD).toString('base64');
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Just a moment...</title></head><body>
        <div id="c">Verify you are a human</div>
        <script>document.getElementById('c').innerHTML = atob('${encodedCard}');</script>
      </body></html>`);
    });

    try {
      const parser = makeParser();
      parser._baseUrl = baseUrl;
      const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);

      assert.equal(listings.length, 1, 'listing must be recovered through the browser');
      assert.equal(parser.stats.browserFetches, 1);
      assert.equal(parser.stats.blockedPages, 0);
    } finally {
      server.close();
    }
  });
});
