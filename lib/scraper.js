'use strict';

const settings = require('../config/settings.json');
const countyData = require('../config/acquisition_counties.json');
const { getEnabledParsers } = require('./parsers');
const { filterListing } = require('./filter');
const { generateFingerprint } = require('./fingerprint');
const airtable = require('./airtable');

/**
 * Main scraper orchestrator.
 *
 * Runs all enabled site parsers with controlled concurrency, filters results,
 * deduplicates against Airtable in a single pass, and writes new leads.
 *
 * Key improvement over v1: dedup happens HERE at scrape time (2 AM), not
 * 4 hours later in the review script. Both URL and fingerprint dedup run
 * in the same pass, so cross-site duplicates never reach Airtable.
 */
async function runScraper() {
  const startTime = Date.now();
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, errors: 0 },
    duplicateDetails: [],
    filterRejects: [],
    writeErrors: [],
  };

  console.log(`[Scraper] Starting at ${new Date().toISOString()}`);
  console.log(`[Scraper] Target: ${countyData.counties.length} counties across ${getTargetStateCount()} states`);

  // Step 1: Load dedup index from Airtable (single fetch, ~2-5 seconds)
  console.log('[Scraper] Loading dedup index from Airtable...');
  let dedupIndex;
  try {
    dedupIndex = await airtable.loadDedupIndex();
    console.log(`[Scraper] Dedup index loaded: ${dedupIndex.urlSet.size} URLs, ${dedupIndex.fingerprintSet.size} fingerprints`);
  } catch (err) {
    console.error(`[Scraper] FATAL: Could not load dedup index: ${err.message}`);
    throw err;
  }

  // Track new fingerprints within this scrape session to catch cross-site dupes
  // found during THIS run (not yet in Airtable)
  const sessionFingerprints = new Map(); // fingerprint -> { source, name, url }

  // Step 2: Run parsers with controlled concurrency
  const parsers = getEnabledParsers(settings.sites);
  console.log(`[Scraper] Running ${parsers.length} site parsers...`);

  const { maxConcurrentSites } = settings.scraper;

  // Process parsers in groups of maxConcurrentSites
  for (let i = 0; i < parsers.length; i += maxConcurrentSites) {
    const batch = parsers.slice(i, i + maxConcurrentSites);
    const results = await Promise.allSettled(
      batch.map(parser => runParserSafe(parser, countyData.counties))
    );

    for (let j = 0; j < results.length; j++) {
      const parser = batch[j];
      const result = results[j];

      if (result.status === 'rejected') {
        console.error(`[Scraper] ${parser.name} CRASHED: ${result.reason?.message || result.reason}`);
        report.sites[parser.name] = { status: 'error', error: result.reason?.message, stats: parser.stats };
        report.totals.errors++;
        continue;
      }

      const listings = result.value;
      const siteReport = {
        status: 'ok',
        checked: parser.stats.checked,
        parsed: listings.length,
        passed: 0,
        duplicates: 0,
        rejected: 0,
        errors: parser.stats.errors,
      };

      // Step 3: Filter and deduplicate each listing
      const toWrite = [];

      for (const listing of listings) {
        report.totals.checked++;

        // 3a: Filter (price, acreage, county)
        const filterResult = filterListing(listing);
        if (!filterResult.passed) {
          siteReport.rejected++;
          report.totals.rejected++;
          continue;
        }

        // 3b: Generate fingerprint
        const fingerprint = generateFingerprint(listing);
        listing.fingerprint = fingerprint;
        listing.stage = filterResult.stage;
        listing.filterReason = filterResult.reason;
        listing.validationErrors = filterResult.validationErrors;
        listing.computedCPA = listing.price / listing.acres;
        listing.cpaTarget = filterResult.cpaTarget;

        // 3c: Check against Airtable dedup index
        const dupCheck = airtable.checkDuplicate(listing, dedupIndex);
        if (dupCheck.isDuplicate) {
          siteReport.duplicates++;
          report.totals.duplicates++;
          report.duplicateDetails.push({
            source: parser.name,
            name: listing.name,
            url: listing.url,
            reason: dupCheck.reason,
            matchType: dupCheck.matchType,
          });
          continue;
        }

        // 3d: Check against this session's fingerprints (cross-site dupes found tonight)
        if (fingerprint && sessionFingerprints.has(fingerprint)) {
          const existing = sessionFingerprints.get(fingerprint);
          siteReport.duplicates++;
          report.totals.duplicates++;
          report.duplicateDetails.push({
            source: parser.name,
            name: listing.name,
            url: listing.url,
            reason: `Cross-site dup found in this session (already from ${existing.source}: ${existing.name})`,
            matchType: 'session-fingerprint',
          });
          continue;
        }

        // Passed all checks
        siteReport.passed++;
        report.totals.passed++;
        toWrite.push(listing);

        // Register in session dedup index
        if (fingerprint) {
          sessionFingerprints.set(fingerprint, { source: parser.name, name: listing.name, url: listing.url });
        }
        // Also add URL/fingerprint to main index for subsequent parsers
        if (listing.url) dedupIndex.urlSet.add(listing.url);
        if (fingerprint) dedupIndex.fingerprintSet.add(fingerprint);
      }

      // Step 4: Write passing leads to Airtable
      if (toWrite.length > 0) {
        try {
          const writeResult = await airtable.writeListings(toWrite);
          siteReport.written = writeResult.created;
          report.totals.written += writeResult.created;
          if (writeResult.errors.length > 0) {
            report.writeErrors.push(...writeResult.errors.map(e => ({ site: parser.name, ...e })));
          }
        } catch (err) {
          console.error(`[Scraper] Failed to write ${toWrite.length} listings from ${parser.name}: ${err.message}`);
          report.writeErrors.push({ site: parser.name, error: err.message });
        }
      }

      report.sites[parser.name] = siteReport;
      console.log(`[Scraper] ${parser.name}: ${siteReport.parsed} found → ${siteReport.passed} passed → ${siteReport.written || 0} written (${siteReport.duplicates} dupes, ${siteReport.rejected} rejected)`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`[Scraper] Done in ${elapsed} minutes`);
  console.log(`[Scraper] Totals: ${report.totals.parsed} found → ${report.totals.passed} passed → ${report.totals.written} written`);
  console.log(`[Scraper] Dedup caught: ${report.totals.duplicates} duplicates`);

  report.elapsedMinutes = parseFloat(elapsed);
  return report;
}

/**
 * Run a single parser with error isolation.
 */
async function runParserSafe(parser, counties) {
  try {
    return await parser.scrapeAll(counties);
  } catch (err) {
    console.error(`[${parser.name}] Fatal error: ${err.message}`);
    throw err;
  }
}

function getTargetStateCount() {
  return new Set(countyData.counties.map(c => c.state)).size;
}

module.exports = { runScraper };
