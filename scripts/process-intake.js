'use strict';

require('dotenv').config();

/**
 * Process the Listing Intake queue immediately (instead of waiting for the
 * 2 AM nightly run):  npm run intake
 *
 * Uses the same import pipeline as the nightly job, including the
 * real-browser fallback for bot-blocked sites. Results are written to each
 * intake row's Status/Result; failures are retried on the next nightly run.
 */
const airtable = require('../lib/airtable');
const { processIntakeQueue } = require('../lib/intake');
const { closeBrowser } = require('../lib/browser-fetch');

async function main() {
  // County index is needed for county matching + linked-record writes
  await airtable.loadCountyTargets();

  const report = await processIntakeQueue({ dryRun: false });
  await closeBrowser();

  console.log('');
  console.log(`Processed: ${report.processed}`);
  console.log(`Added:     ${report.created}`);
  console.log(`Duplicate: ${report.duplicates}`);
  console.log(`Retrying:  ${report.retryQueued} (next nightly run)`);
  console.log(`Failed:    ${report.failedFinal} (set Status to 'New' to re-try)`);
  if (report.loadError) {
    console.error(`Queue not processed: ${report.loadError}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
