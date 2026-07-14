'use strict';

require('dotenv').config();

/**
 * Validate the browser fallback on THIS machine.
 *
 *   node scripts/test-browser-fallback.js          → local self-test (no network)
 *   node scripts/test-browser-fallback.js --live   → also probe the real
 *     LandWatch / Land.com / LandAndFarm search pages, comparing what a
 *     plain fetch gets vs what the browser gets from this machine's IP
 *   node scripts/test-browser-fallback.js <url>    → probe one specific URL
 *
 * Run this on the production Mac after setup: the bot walls score the
 * network's IP, so only a probe from that machine tells the truth.
 */

const http = require('http');
const fetch = require('node-fetch');
const browserFetch = require('../lib/browser-fetch');

const LIVE_URLS = [
  'https://www.landwatch.com/kentucky/johnson-county/land-for-sale?minAcreage=40&sortBy=date_desc&page=1',
  'https://www.land.com/Kentucky/johnson-county/land-over-40-acres/all-land/date-posted/page-1',
  'https://www.landandfarm.com/search/kentucky/johnson-county/land-for-sale?minAcres=40&sort=newest&page=1',
];

const BLOCK_RE = /just a moment|incapsula|access denied|px-captcha|verify you are a human|attention required|enable javascript and cookies/i;

function verdict(html, status) {
  if (status && status >= 400) return `❌ HTTP ${status}`;
  if (BLOCK_RE.test((html || '').slice(0, 20000))) return '🚫 challenge page';
  const detailLinks = ((html || '').match(/\/pid\/|\/property\/|land-for-sale\/|\/farms-ranches\//g) || []).length;
  return `✅ real page (${(html || '').length.toLocaleString()} bytes, ~${detailLinks} listing-ish links)`;
}

async function plainFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36' },
      timeout: 30000,
    });
    return verdict(await res.text(), res.status);
  } catch (err) {
    return `❌ ${err.message}`;
  }
}

async function browserProbe(url) {
  try {
    const html = await browserFetch.fetchPageWithBrowser(url);
    return verdict(html, 200);
  } catch (err) {
    return `❌ ${err.message.split('\n')[0]}`;
  }
}

async function localSelfTest() {
  console.log('1. Local self-test (does a real browser launch and execute JS?)');
  const payload = Buffer.from('<div id="ok">BROWSER-RENDERED</div>').toString('base64');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><div>Verify you are a human</div><script>document.body.innerHTML = atob('${payload}');</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  try {
    const html = await browserFetch.fetchPageWithBrowser(url);
    if (html.includes('BROWSER-RENDERED')) {
      console.log('   ✅ Browser launched and rendered JS — fallback is functional on this machine.\n');
      return true;
    }
    console.log('   ❌ Browser launched but did not render JS.\n');
    return false;
  } catch (err) {
    console.log(`   ❌ ${err.message.split('\n')[0]}`);
    console.log(`      ${browserFetch.reasonUnavailable() || 'Install Google Chrome, or set SCRAPER_BROWSER_PATH in .env'}\n`);
    return false;
  } finally {
    server.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const customUrls = args.filter(a => a.startsWith('http'));

  if (!browserFetch.isEnabled()) {
    console.log(`Browser fallback is disabled or unavailable: ${browserFetch.reasonUnavailable() || 'SCRAPER_BROWSER_FALLBACK=false'}`);
    process.exitCode = 1;
    return;
  }

  const ok = await localSelfTest();
  if (!ok) process.exitCode = 1;

  const urls = customUrls.length > 0 ? customUrls : (live ? LIVE_URLS : []);
  if (ok && urls.length > 0) {
    console.log('2. Live probes from this machine\'s IP (plain fetch vs browser):');
    for (const url of urls) {
      console.log(`   ${url}`);
      console.log(`     plain fetch: ${await plainFetch(url)}`);
      console.log(`     browser:     ${await browserProbe(url)}`);
      // Pause between sites — this is a diagnostic, not a scrape
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    console.log('\nIf "browser" shows a real page where "plain fetch" shows 403/challenge,');
    console.log('the nightly scrape will recover those sites automatically.');
  } else if (ok && !live) {
    console.log('Run with --live on the production Mac to probe the real sites from its IP.');
  }

  await browserFetch.closeBrowser();
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
