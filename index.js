'use strict';

require('dotenv').config();

const airtable = require('./lib/airtable');
const { initFilter } = require('./lib/filter');
const { runScraper } = require('./lib/scraper');
const { runPriceCheck } = require('./lib/price-checker');
const { runReview } = require('./lib/review');
const { processIntakeQueue } = require('./lib/intake');
const { runLeadRecheck } = require('./lib/lead-recheck');
const { closeBrowser } = require('./lib/browser-fetch');
const { sendScraperEmail, pingHealthcheck } = require('./lib/notify');

/**
 * Main entry point — runs on Classic's iMac at 2:00 AM via launchd.
 * The full run does scrape + price check + lead review + lead recheck and
 * sends ONE consolidated email covering all four.
 *
 * Modes:
 *   node index.js              → Full scrape + price check + review + lead recheck
 *   node index.js --price-check-only → Price check only (for testing/manual runs)
 *   node index.js --skip-price-check → Skip watched-listing price checks
 *   node index.js --skip-review → Skip the lead review step
 *   node index.js --skip-lead-recheck → Skip the nightly New Lead/Emma Review recheck
 *   node index.js --dry-run    → Scrape and check without writing Airtable changes
 *                                (also skips lead recheck — it does live fetches
 *                                against production listing URLs, production-only
 *                                like the review's Airtable writes)
 *   SCRAPER_MIDDAY=1 node index.js → Midday mode (services/*.midday.plist, 12:30 PM):
 *                                scrape + intake only (price check, review, and lead
 *                                recheck stay nightly-only); the email is skipped
 *                                entirely when the run found nothing noteworthy (see
 *                                lib/notify.js isMiddayRunNoteworthy). Evidence
 *                                capture is skipped by scripts/run-scraper.sh, not here.
 */
async function main() {
  const priceCheckOnly = process.argv.includes('--price-check-only');
  // Midday mode (services/com.ccl.land-scraper.midday.plist, 12:30 PM): a
  // light second sweep so same-day listings surface within hours. Reuses the
  // existing skip flags rather than a parallel code path — a midday run IS a
  // scrape+intake-only run, nothing more. Checked here (not only in
  // scripts/run-scraper.sh) so `SCRAPER_MIDDAY=1 node index.js` alone is
  // correct even outside the launchd wrapper.
  const midday = process.env.SCRAPER_MIDDAY === '1' || process.env.SCRAPER_MIDDAY === 'true';
  const skipPriceCheck = process.argv.includes('--skip-price-check') || process.env.SKIP_PRICE_CHECK === 'true' || midday;
  const skipReview = process.argv.includes('--skip-review') || process.env.SKIP_REVIEW === 'true' || midday;
  // Lead recheck (lib/lead-recheck.js) re-fetches New Lead / Emma Review
  // listing URLs from the production Mac and is fetch-heavy like the
  // scrape/price-check — gated the same way review is: off on a light
  // midday sweep, and off in --dry-run below (it never writes, but the
  // fetches themselves are production-only work).
  const skipLeadRecheck = process.argv.includes('--skip-lead-recheck') || process.env.SKIP_LEAD_RECHECK === 'true' || midday;
  // CI runs are always dry-run, enforced here in code — the workflow files
  // also set it, but a workflow edit must not be able to write to production
  const inGithubActions = process.env.GITHUB_ACTIONS === 'true';
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true' || inGithubActions;
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log(`CCL Land Scraper v2.0 — ${new Date().toISOString()}`);
  console.log(`Mode: ${priceCheckOnly ? 'Price check only' : 'Full scrape + price check + review'}${midday ? ' (midday — scrape+intake only)' : ''}${dryRun ? ' (dry run)' : ''}`);
  if (inGithubActions) {
    console.log('[Main] GitHub Actions detected — dry run enforced');
  }
  console.log('='.repeat(60));

  // A live run without Airtable credentials would scrape for hours using the
  // local county fallback and queue every write. Fail fast and loud instead.
  if (!dryRun && (!process.env.AIRTABLE_LAND_TOKEN || !process.env.AIRTABLE_BASE_ID)) {
    console.error('[Main] FATAL: AIRTABLE_LAND_TOKEN / AIRTABLE_BASE_ID missing — refusing to run a live scrape. Use --dry-run to run without credentials.');
    await pingHealthcheck(false);
    process.exitCode = 1;
    return;
  }

  let scraperReport = null;
  let priceCheckReport = null;
  let reviewReport = null;
  let intakeReport = null;
  let leadRecheckReport = null;
  let fatalError = null;

  try {
    // Parse the county-selection options INSIDE the guarded region: a malformed
    // SCRAPER_TARGET_COUNTIES makes parseTargetCountiesOption throw, and doing it
    // here routes that throw into the catch below so it still produces the
    // failure email + healthcheck ping instead of a silent unhandled exit.
    const limitCounties = parseIntegerOption('--limit-counties', process.env.SCRAPER_LIMIT_COUNTIES);
    const targetCounties = parseTargetCountiesOption('--target-counties', process.env.SCRAPER_TARGET_COUNTIES);

    // Step 1: Scrape new listings (unless price-check-only mode)
    if (!priceCheckOnly) {
      // runScraper() loads county targets and inits the filter itself
      scraperReport = await runScraper({ dryRun, limitCounties, targetCounties });
    } else {
      // Price-check-only mode: still need county targets for CPA lookups
      const countyTargets = await airtable.loadCountyTargets();
      initFilter(countyTargets.countyMap);
    }

    // Step 2: Check for price drops on watched listings.
    // Isolated so a price-check crash after a successful scrape is reported
    // in the email instead of silently dropping the section.
    if (skipPriceCheck) {
      console.log('[Main] Skipping price check.');
    } else {
      try {
        priceCheckReport = await runPriceCheck({ dryRun });
      } catch (err) {
        fatalError = err;
        console.error(`[Main] Price check failed: ${err.message}`);
        console.error(err.stack);
        // In --price-check-only mode there is no scraper report, but the
        // failure email must still go out — build the minimal shell for it
        scraperReport = scraperReport || {
          sites: {},
          totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
          duplicateDetails: [],
          writeErrors: [],
          sourceIssues: [],
          warnings: [],
          dryRun,
          elapsedMinutes: 0,
        };
        scraperReport.priceCheckError = err.message;
        scraperReport.totals.errors++;
      }
    }

    // Step 3: Import team-submitted listing URLs from the Listing Intake
    // table (failures set Status 'Retry' and are re-attempted on the NEXT
    // nightly run — a day later; a second failure is final). Runs before
    // the review so intake leads get analyzed the same night. Isolated so
    // an intake crash is reported in the email instead of losing the run.
    if (!priceCheckOnly) {
      if (dryRun) {
        console.log('[Main] Dry run — skipping listing intake (it writes to Airtable).');
        if (scraperReport) {
          scraperReport.warnings.push('Dry run: listing intake processing skipped (it writes to Airtable)');
        }
      } else {
        try {
          intakeReport = await processIntakeQueue({ dryRun });
        } catch (err) {
          // Not fatal (unlike review): intake has its own per-item Retry/Failed
          // flow that re-attempts on the next nightly run.
          console.error(`[Main] Listing intake failed: ${err.message}`);
          console.error(err.stack);
          if (scraperReport) {
            scraperReport.intakeError = err.message;
            scraperReport.totals.errors++;
          }
        }
      }
    }

    // Step 4: Review new leads and price drops (previously a separate 6 AM
    // job with its own email — now part of the single nightly report).
    // Isolated like the price check so a review crash is reported in the
    // email instead of losing the whole run.
    if (priceCheckOnly || skipReview) {
      if (skipReview) console.log('[Main] Skipping lead review.');
    } else if (dryRun) {
      // The review writes analysis notes and stage changes to Airtable, so a
      // dry run (including the GitHub Actions monitor) must not run it
      console.log('[Main] Dry run — skipping lead review (it writes analysis to Airtable).');
      if (scraperReport) {
        scraperReport.warnings.push('Dry run: lead review skipped (it writes analysis notes to Airtable)');
      }
    } else {
      try {
        reviewReport = await runReview();
      } catch (err) {
        fatalError = err;
        console.error(`[Main] Lead review failed: ${err.message}`);
        console.error(err.stack);
        if (scraperReport) {
          scraperReport.reviewError = err.message;
          scraperReport.totals.errors++;
        }
      }
    }

    // Step 4.5: Nightly lead recheck — re-fetch each 'New Lead'/'Emma Review'
    // record's own listing URL (bot-blocked from the cloud, so this only
    // works on the production Mac) and report leads that have gone under
    // contract/sold/off-market since they were scraped, plus acreage
    // mismatches. REPORT ONLY — it never touches Stage or any Airtable field
    // (see lib/lead-recheck.js). Individual fetch failures are counted, not
    // fatal; a wholly failed recheck is a warning like a failed intake pass,
    // not a run-crashing error like a failed price check/review.
    if (priceCheckOnly || skipLeadRecheck) {
      if (skipLeadRecheck) console.log('[Main] Skipping lead recheck.');
    } else if (dryRun) {
      console.log('[Main] Dry run — skipping lead recheck (it does live fetches against production listing URLs).');
      if (scraperReport) {
        scraperReport.warnings.push('Dry run: nightly lead recheck skipped (live fetch step)');
      }
    } else {
      try {
        leadRecheckReport = await runLeadRecheck();
      } catch (err) {
        console.error(`[Main] Lead recheck failed: ${err.message}`);
        console.error(err.stack);
        if (scraperReport) {
          scraperReport.leadRecheckError = err.message;
          scraperReport.totals.errors++;
        }
      }
    }

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
      sourceIssues: [],
      warnings: dryRun ? ['Dry run enabled: Airtable writes were skipped'] : [],
      dryRun,
      elapsedMinutes: 0,
    };
  }

  // Step 5: Send the single consolidated email (always, even on failure).
  // Midday runs pass { midday: true }: notify.js marks the subject and, when
  // nothing noteworthy happened (no new leads/write errors/abandoned sites/
  // crashed sites), skips sending entirely — see isMiddayRunNoteworthy.
  let emailSent = true;
  try {
    if (scraperReport || priceCheckReport || reviewReport || intakeReport || leadRecheckReport) {
      const result = await sendScraperEmail(
        scraperReport || { sites: {}, totals: { written: 0, duplicates: 0, rejected: 0, errors: 0 }, duplicateDetails: [], writeErrors: [], sourceIssues: [], elapsedMinutes: 0 },
        priceCheckReport,
        reviewReport,
        intakeReport,
        { midday, leadRecheckReport }
      );
      emailSent = result.sent || result.skipped;
    }
  } catch (err) {
    emailSent = false;
    console.error(`[Main] Email failed: ${err.message}`);
  }

  // Safety net: a crash mid-scrape can leave the fallback browser running,
  // which would keep the process alive forever
  await closeBrowser();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n[Main] Total runtime: ${elapsed} minutes`);
  console.log('[Main] Done.');

  // Email delivery failure only fails a LIVE run — dry runs (including the
  // nightly GitHub Actions monitor, which has no mail binary and no SMTP
  // secrets) deliver their report via the report file / workflow summary,
  // and failing them produced a false "Run failed" alert every night.
  if (fatalError || (!emailSent && !dryRun)) {
    process.exitCode = 1;
  }
  await pingHealthcheck(!fatalError && (emailSent || dryRun));
}

function parseIntegerOption(flag, envValue) {
  const arg = process.argv.find(value => value.startsWith(`${flag}=`));
  const rawValue = arg ? arg.slice(flag.length + 1) : envValue;
  if (!rawValue) return null;

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseTargetCountiesOption(flag, envValue) {
  const arg = process.argv.find(value => value.startsWith(`${flag}=`));
  const rawValue = arg ? arg.slice(flag.length + 1) : envValue;
  if (!rawValue) return null;

  return rawValue
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      const [county, state] = value.split('|').map(part => part && part.trim());
      if (!county || !state) {
        throw new Error(`Invalid target county "${value}". Use County|ST, e.g. Wayne|KY`);
      }
      return { county, state: state.toUpperCase() };
    });
}

main().catch(err => {
  console.error(`[Main] Unhandled error: ${err.message}`);
  process.exit(1);
});
