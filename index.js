'use strict';

require('dotenv').config();

const airtable = require('./lib/airtable');
const { initFilter } = require('./lib/filter');
const { runScraper } = require('./lib/scraper');
const { runPriceCheck } = require('./lib/price-checker');
const { sendScraperEmail } = require('./lib/notify');

/**
 * Main entry point — runs on Classic's iMac at 2:00 AM via launchd.
 *
 * Two modes:
 *   node index.js              → Full scrape + price check
 *   node index.js --price-check-only → Price check only (for testing/manual runs)
 *   node index.js --dry-run    → Scrape and check without writing Airtable changes
 */
async function main() {
  const priceCheckOnly = process.argv.includes('--price-check-only');
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log(`CCL Land Scraper v2.0 — ${new Date().toISOString()}`);
  console.log(`Mode: ${priceCheckOnly ? 'Price check only' : 'Full scrape + price check'}${dryRun ? ' (dry run)' : ''}`);
  console.log('='.repeat(60));

  let scraperReport = null;
  let priceCheckReport = null;
  let fatalError = null;

  try {
    // Step 1: Scrape new listings (unless price-check-only mode)
    if (!priceCheckOnly) {
      // runScraper() loads county targets and inits the filter itself
      scraperReport = await runScraper({ dryRun });
    } else {
      // Price-check-only mode: still need county targets for CPA lookups
      const countyTargets = await airtable.loadCountyTargets();
      initFilter(countyTargets.countyMap);
    }

    // Step 2: Check for price drops on watched listings
    priceCheckReport = await runPriceCheck({ dryRun });

  } catch (err) {
    fatalError = err;
    console.error(`[Main] Fatal error: ${err.message}`);
    console.error(err.stack);

    // Still try to send email on failure
    scraperReport = scraperReport || {
      sites: {},
      totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, errors: 1 },
      duplicateDetails: [],
      writeErrors: [{ site: 'system', error: err.message }],
      warnings: dryRun ? ['Dry run enabled: Airtable writes were skipped'] : [],
      dryRun,
      elapsedMinutes: 0,
    };
  }

  // Step 3: Send email (always, even on failure)
  try {
    if (scraperReport || priceCheckReport) {
      await sendScraperEmail(
        scraperReport || { sites: {}, totals: { written: 0, duplicates: 0, rejected: 0, errors: 0 }, duplicateDetails: [], writeErrors: [], elapsedMinutes: 0 },
        priceCheckReport
      );
    }
  } catch (err) {
    console.error(`[Main] Email failed: ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n[Main] Total runtime: ${elapsed} minutes`);
  console.log('[Main] Done.');

  if (fatalError) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`[Main] Unhandled error: ${err.message}`);
  process.exit(1);
});
