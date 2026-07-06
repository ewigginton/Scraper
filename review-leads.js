'use strict';

require('dotenv').config();

const airtable = require('./lib/airtable');
const { initFilter } = require('./lib/filter');
const { runReview } = require('./lib/review');
const { runPriceCheck } = require('./lib/price-checker');
const { sendReviewEmail } = require('./lib/notify');

/**
 * Review entry point — runs on Nora's Mac at 6:00 AM via launchd.
 *
 * Modes:
 *   node review-leads.js           → Review only (default)
 *   node review-leads.js run-all   → Review + price check (legacy compat)
 */
async function main() {
  const runAll = process.argv.includes('run-all');
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log(`CCL Lead Review v2.0 — ${new Date().toISOString()}`);
  console.log(`Mode: ${runAll ? 'Review + price check' : 'Review only'}`);
  console.log('='.repeat(60));

  let reviewReport = null;
  let fatalError = null;

  try {
    // Step 0: Load county targets from Airtable (needed for CPA lookups in review + price check)
    const countyTargets = await airtable.loadCountyTargets();
    initFilter(countyTargets.countyMap);

    // Step 1: Review and analyze new leads
    reviewReport = await runReview();

    // Step 2: Optionally run price check (for run-all mode)
    if (runAll) {
      await runPriceCheck();
    }
  } catch (err) {
    fatalError = err;
    console.error(`[ReviewMain] Fatal error: ${err.message}`);
    console.error(err.stack);

    reviewReport = reviewReport || {
      reviewed: 0,
      standouts: [],
      flagged: [],
      autoRejected: [],
      errors: 1,
      elapsedMinutes: 0,
    };
  }

  // Step 3: Send email (always)
  let emailSent = true;
  try {
    if (reviewReport) {
      const result = await sendReviewEmail(reviewReport);
      emailSent = result.sent || result.skipped;
    }
  } catch (err) {
    emailSent = false;
    console.error(`[ReviewMain] Email failed: ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n[ReviewMain] Total runtime: ${elapsed} minutes`);
  console.log('[ReviewMain] Done.');

  if (fatalError || !emailSent) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`[ReviewMain] Unhandled error: ${err.message}`);
  process.exit(1);
});
