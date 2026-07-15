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

  await t.test('HTTP-200 JS challenge page is rescued by the real browser and exits the poll loop early once solved', async () => {
    // The listing markup must NOT appear in the raw page source (a real
    // challenge page doesn't contain the content) — ship it base64-encoded
    // so only a JS-executing client materializes it in the DOM. The script
    // also swaps document.title: a real challenge wall replaces its own
    // "Just a moment..." title once it solves, and isBlockedHtml scans the
    // whole page (title included) — leaving the old title in place would
    // make every poll still look blocked and burn the full challenge
    // budget (~25s) even though the real content already loaded.
    const encodedCard = Buffer.from(LISTING_CARD).toString('base64');
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Just a moment...</title></head><body>
        <div id="c">Verify you are a human</div>
        <script>
          document.getElementById('c').innerHTML = atob('${encodedCard}');
          document.title = 'Search Results';
        </script>
      </body></html>`);
    });

    try {
      const parser = makeParser();
      parser._baseUrl = baseUrl;
      const start = Date.now();
      const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
      const elapsed = Date.now() - start;

      assert.equal(listings.length, 1, 'listing must be recovered through the browser');
      assert.equal(parser.stats.browserFetches, 1);
      assert.equal(parser.stats.blockedPages, 0);
      // Default challenge budget is 25s; solving on effectively the first
      // poll (after the fixed 2.5s settle pause) should finish in a few
      // seconds, not burn the whole budget.
      assert.ok(elapsed < 15000, `challenge should resolve quickly once the title updates (took ${elapsed}ms)`);
    } finally {
      server.close();
    }
  });

  await t.test('a challenge that never solves waits out the full challenge budget, then reports blocked', async () => {
    // Same fixture shape but the title/markers never change — nothing ever
    // clears isBlockedHtml, so the poll loop must run for the whole
    // configured budget before giving up. Shrink the budget via env var so
    // this still runs fast; this is the timeout counterpart to the
    // early-exit test above and keeps that code path covered.
    const originalBudget = process.env.SCRAPER_BROWSER_CHALLENGE_WAIT_MS;
    process.env.SCRAPER_BROWSER_CHALLENGE_WAIT_MS = '3000';
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Just a moment...</title></head><body>
        <div id="c">Verify you are a human</div>
      </body></html>`);
    });

    try {
      const parser = makeParser();
      parser._baseUrl = baseUrl;
      const start = Date.now();
      const listings = await parser.scrapeAll([{ county: 'Wayne', state: 'KY' }]);
      const elapsed = Date.now() - start;

      assert.equal(listings.length, 0, 'an unsolved challenge yields no listings');
      assert.equal(parser.stats.browserFetches, 1);
      assert.equal(parser.stats.blockedPages, 1, 'an unsolved challenge must still count as blocked');
      assert.ok(elapsed >= 3000, `must wait out the full challenge budget before giving up (took ${elapsed}ms)`);
    } finally {
      server.close();
      if (originalBudget === undefined) delete process.env.SCRAPER_BROWSER_CHALLENGE_WAIT_MS;
      else process.env.SCRAPER_BROWSER_CHALLENGE_WAIT_MS = originalBudget;
    }
  });
});
