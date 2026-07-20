#!/usr/bin/env node
'use strict';

// Capture rendered HTML evidence for parser work. Fetches each URL through
// the same browser fallback the scraper uses (headed Chrome when
// SCRAPER_BROWSER_HEADED=true), so what lands on disk is what the scraper
// actually sees — including challenge pages, which are themselves useful
// evidence. Files go to data/evidence/ for committing to an evidence branch.
//
// Usage: node scripts/capture-evidence.js <url> [<url> ...]

const fs = require('fs');
const path = require('path');
const browserFetch = require('../lib/browser-fetch');
const { slugForUrl } = require('../lib/evidence-capture');

const EVIDENCE_DIR = path.join(__dirname, '..', 'data', 'evidence');

// Manual captures keep a timestamp so repeated runs of the same URL don't
// clobber each other; the shared slug keeps naming consistent with the nightly
// pipeline (scripts/process-evidence-requests.js, which content-addresses by
// hash instead for idempotency).
function fileNameFor(url) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${slugForUrl(url)}-${stamp}.html`;
}

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('Usage: node scripts/capture-evidence.js <url> [<url> ...]');
    process.exit(1);
  }
  if (!browserFetch.isEnabled()) {
    console.error(`Browser fetch unavailable: ${browserFetch.reasonUnavailable()}`);
    process.exit(1);
  }

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  let failures = 0;
  for (const url of urls) {
    try {
      const html = await browserFetch.fetchPageWithBrowser(url);
      const file = path.join(EVIDENCE_DIR, fileNameFor(url));
      fs.writeFileSync(file, html);
      console.log(`Saved ${html.length} bytes → ${path.relative(process.cwd(), file)}`);
    } catch (err) {
      // A challenge page or HTTP error is still evidence worth having when
      // the fetch layer surfaces its HTML; a hard failure just gets logged.
      failures++;
      console.error(`FAILED ${url}: ${err.message.split('\n')[0]}`);
    }
  }

  await browserFetch.closeBrowser();
  process.exit(failures === urls.length ? 1 : 0);
}

main();
