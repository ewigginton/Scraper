'use strict';

require('dotenv').config();

/**
 * Capture a real LandWatch county search page as a test fixture.
 *
 * MUST run on the production Mac (residential IP). LandWatch is behind
 * Imperva: a datacenter/cloud IP is 403'd or served a challenge, so a capture
 * from anywhere else is worthless. On the Mac a headed Chrome clears the wall
 * and renders the real listing grid.
 *
 *   SCRAPER_BROWSER_HEADED=true node scripts/capture-landwatch-fixture.js
 *   SCRAPER_BROWSER_HEADED=true node scripts/capture-landwatch-fixture.js "Wayne" "KY"
 *   node scripts/capture-landwatch-fixture.js "https://www.landwatch.com/....?..."
 *
 * It writes test/fixtures/landwatch-search.html (with a metadata comment the
 * fixture test reads for county/state) and immediately runs the real parser
 * against the capture so you can see how many listings it extracts. If that
 * count is 0 on a page that clearly has listings, the detail-link hrefPattern
 * or the card structure has changed — inspect the saved HTML and adjust
 * lib/parsers/landwatch.js before committing the fixture.
 */

const fs = require('fs');
const path = require('path');
const browserFetch = require('../lib/browser-fetch');
const { isBlockedHtml } = require('../lib/block-markers');
const LandWatchParser = require('../lib/parsers/landwatch');

function buildUrl(parser, county, state) {
  // Reuse the parser's own URL builder so the fixture matches what the nightly
  // run actually fetches (page 1, 40+ acres, newest first).
  const [first] = parser.buildSearchUrls([{ county, state, maxCPA: 3000 }]);
  return first.url;
}

async function main() {
  const args = process.argv.slice(2);
  const parser = new LandWatchParser();

  const urlArg = args.find(a => a.startsWith('http'));
  const county = args.find(a => !a.startsWith('http')) || 'Wayne';
  const state = (args.filter(a => !a.startsWith('http'))[1] || 'KY').toUpperCase();
  const url = urlArg || buildUrl(parser, county, state);

  if (!browserFetch.isEnabled()) {
    console.log(`Browser fallback unavailable: ${browserFetch.reasonUnavailable() || 'SCRAPER_BROWSER_FALLBACK=false'}`);
    console.log('This capture needs the real browser. On the Mac, run "npm run test-browser" first to diagnose.');
    process.exitCode = 1;
    return;
  }

  console.log(`Fetching (browser): ${url}`);
  let html;
  try {
    html = await browserFetch.fetchPageWithBrowser(url, { timeoutMs: 60000, challengeWaitMs: 25000 });
  } catch (err) {
    console.log(`❌ Fetch failed: ${err.message.split('\n')[0]}`);
    console.log('   If this is HTTP 403 / a challenge, the wall did not open from this IP.');
    console.log('   Try SCRAPER_BROWSER_HEADED=true, and confirm you are on the production Mac.');
    process.exitCode = 1;
    await browserFetch.closeBrowser();
    return;
  } finally {
    // closeBrowser is idempotent; the success path closes below too.
  }

  if (isBlockedHtml(html)) {
    console.log('🚫 Got a challenge/block page, not real content — not saving.');
    console.log('   Run SCRAPER_BROWSER_HEADED=true on the production Mac and retry.');
    process.exitCode = 1;
    await browserFetch.closeBrowser();
    return;
  }

  const pidLinks = (html.match(/\/pid\/\d+/g) || []).length;
  console.log(`✅ Real page: ${html.length.toLocaleString()} bytes, ${pidLinks} "/pid/" links found`);

  // Prepend a metadata comment the fixture test parses for county/state.
  const stamped = `<!-- landwatch-fixture county=${county.replace(/\s+/g, '_')} state=${state} -->\n${html}`;
  const outPath = path.join(__dirname, '..', 'test', 'fixtures', 'landwatch-search.html');
  fs.writeFileSync(outPath, stamped, 'utf8');
  console.log(`Saved fixture → ${path.relative(path.join(__dirname, '..'), outPath)}`);

  // Prove the parser against the real capture.
  const listings = parser.parseSearchPage(stamped, county, state);
  console.log(`Parser extracted ${listings.length} listing(s) (cards seen: ${parser._lastCardCount}).`);
  for (const l of listings.slice(0, 5)) {
    console.log(`  • ${l.acres} ac  $${l.price.toLocaleString()}  ${l.url}`);
  }
  if (listings.length === 0 && pidLinks > 0) {
    console.log('\n⚠️  The page has /pid/ links but the parser extracted 0 — the card structure');
    console.log('   (price/acreage text near the detail link) likely changed. Inspect the saved');
    console.log('   HTML and adjust lib/parsers/landwatch.js, then re-run this script.');
    process.exitCode = 1;
  }

  await browserFetch.closeBrowser();
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
