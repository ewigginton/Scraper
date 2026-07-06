'use strict';

const settings = require('../config/settings.json');
const { getEnabledParsers } = require('./parsers');
const { initFilter, filterListing } = require('./filter');
const { generateFingerprint } = require('./fingerprint');
const airtable = require('./airtable');
const { loadPendingFailedWrites, archiveFailedWrites } = require('./local-store');

/**
 * Main scraper orchestrator.
 *
 * 1. Loads county CPA targets from Airtable "county" table (only counties with "CPA Target" filled)
 * 2. Loads dedup index from Airtable "Leads" table
 * 3. Runs site parsers for target counties only
 * 4. Filters, deduplicates, and writes new leads
 */
async function runScraper(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const startTime = Date.now();
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0 },
    duplicateDetails: [],
    filterRejects: [],
    writeErrors: [],
    sourceIssues: [],
    warnings: [],
    dryRun,
  };

  console.log(`[Scraper] Starting at ${new Date().toISOString()}`);
  if (dryRun) {
    report.warnings.push('Dry run enabled: Airtable lead writes will be skipped');
    console.log('[Scraper] Dry run enabled: Airtable lead writes will be skipped');
  }

  // Step 1: Load county targets from Airtable
  console.log('[Scraper] Loading county targets from Airtable...');
  let countyTargets;
  try {
    countyTargets = await airtable.loadCountyTargets();
  } catch (err) {
    console.error(`[Scraper] FATAL: Could not load county targets: ${err.message}`);
    throw err;
  }

  if (countyTargets.counties.length === 0) {
    console.error('[Scraper] FATAL: No counties found with CPA Target set in Airtable');
    throw new Error('No county targets configured');
  }
  if (countyTargets.warning) {
    report.warnings.push(countyTargets.warning);
  }
  if (options.targetCounties && options.targetCounties.length > 0) {
    countyTargets = selectTargetCounties(countyTargets, options.targetCounties);
    const warning = `Validation targets enabled: scraping ${countyTargets.counties.map(target => `${target.county}, ${target.state}`).join('; ')}`;
    report.warnings.push(warning);
    console.log(`[Scraper] ${warning}`);
  }
  if (options.limitCounties) {
    countyTargets.counties = countyTargets.counties.slice(0, options.limitCounties);
    countyTargets.countyMap = new Map(
      countyTargets.counties.map(target => [`${target.county.toLowerCase()}|${target.state.toUpperCase()}`, target.maxCPA])
    );
    const warning = `Validation limit enabled: scraping first ${countyTargets.counties.length} county targets only`;
    report.warnings.push(warning);
    console.log(`[Scraper] ${warning}`);
  }

  // Initialize the filter with the Airtable county map
  initFilter(countyTargets.countyMap);

  const states = new Set(countyTargets.counties.map(c => c.state));
  console.log(`[Scraper] Target: ${countyTargets.counties.length} counties across ${states.size} states`);

  // Step 2: Load dedup index from Airtable (single fetch)
  console.log('[Scraper] Loading dedup index from Airtable...');
  let dedupIndex;
  try {
    dedupIndex = await airtable.loadDedupIndex();
    console.log(`[Scraper] Dedup index loaded: ${dedupIndex.urlSet.size} URLs, ${dedupIndex.fingerprintSet.size} fingerprints`);
  } catch (err) {
    // Writing with an empty dedup index would re-create every live listing
    // already in the Leads table. Only a dry run may continue without one.
    if (!dryRun) {
      console.error(`[Scraper] FATAL: Could not load dedup index; aborting to avoid mass duplicates: ${err.message}`);
      throw new Error(`Dedup index load failed — scrape aborted to avoid duplicate writes: ${err.message}`);
    }
    const warning = `Could not load Airtable dedup index; dry run continuing with session-only dedup: ${err.message}`;
    console.error(`[Scraper] WARNING: ${warning}`);
    report.warnings.push(warning);
    report.totals.errors++;
    dedupIndex = { urlSet: new Set(), fingerprintSet: new Set(), locationMap: new Map(), records: [] };
  }

  // Step 2.5: Replay any leads whose Airtable writes failed on a previous run
  await replayFailedWrites(dedupIndex, dryRun, report);

  // Track new fingerprints within this scrape session to catch cross-site dupes
  const sessionFingerprints = new Map(); // fingerprint -> { source, name, url }

  // Step 3: Run parsers with controlled concurrency
  const parsers = getEnabledParsers(settings.sites);
  console.log(`[Scraper] Running ${parsers.length} site parsers...`);

  const { maxConcurrentSites } = settings.scraper;

  // Process parsers in groups of maxConcurrentSites
  for (let i = 0; i < parsers.length; i += maxConcurrentSites) {
    const batch = parsers.slice(i, i + maxConcurrentSites);
    const results = await Promise.allSettled(
      batch.map(parser => runParserSafe(parser, countyTargets.counties))
    );

    for (let j = 0; j < results.length; j++) {
      const parser = batch[j];
      const result = results[j];

      if (result.status === 'rejected') {
        console.error(`[Scraper] ${parser.name} CRASHED: ${result.reason?.message || result.reason}`);
        const sourceIssues = parser.sourceIssues || [];
        report.sourceIssues.push(...sourceIssues);
        report.sites[parser.name] = { status: 'error', error: result.reason?.message, stats: parser.stats, sourceIssues };
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
        sourceIssues: parser.sourceIssues || [],
      };
      if (siteReport.sourceIssues.length > 0) {
        report.sourceIssues.push(...siteReport.sourceIssues);
      }
      report.totals.parsed += listings.length;

      // Step 4: Filter and deduplicate each listing
      const toWrite = [];

      for (const listing of listings) {
        report.totals.checked++;

        // 4a: Filter (price, acreage, county)
        const filterResult = filterListing(listing);
        if (!filterResult.passed) {
          siteReport.rejected++;
          report.totals.rejected++;
          continue;
        }

        // 4b: Generate fingerprint
        const fingerprint = generateFingerprint(listing);
        listing.fingerprint = fingerprint;
        listing.stage = filterResult.stage;
        listing.filterReason = filterResult.reason;
        listing.validationErrors = filterResult.validationErrors;
        listing.cpaTarget = filterResult.cpaTarget;

        // 4c: Check against Airtable dedup index
        const dupCheck = airtable.checkDuplicate(listing, dedupIndex);
        if (dupCheck.suspectedCrossSite) {
          // Written anyway — sibling tracts of identical size/price are
          // common, so this is a warning on the record, not a silent skip
          listing.validationErrors = [...(listing.validationErrors || []), dupCheck.suspectedCrossSite];
        }
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

        // 4d: Check against this session's fingerprints (cross-site dupes found tonight)
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

        // Register in the session dedup index (kept separate from the main
        // fingerprint set so cross-site dupes found tonight report which
        // site they were first seen on via step 4d)
        if (fingerprint) {
          sessionFingerprints.set(fingerprint, { source: parser.name, name: listing.name, url: listing.url });
        }
        if (listing.url) dedupIndex.urlSet.add(listing.url);
        if (dedupIndex.locationMap) airtable.addToLocationMap(dedupIndex.locationMap, listing);
      }

      // Step 5: Write passing leads to Airtable
      if (toWrite.length > 0) {
        if (dryRun) {
          siteReport.wouldWrite = toWrite.length;
          report.totals.wouldWrite += toWrite.length;
        } else {
          try {
            const writeResult = await airtable.writeListings(toWrite);
            siteReport.written = writeResult.created;
            report.totals.written += writeResult.created;
            if (writeResult.errors.length > 0) {
              report.writeErrors.push(...writeResult.errors.map(e => ({ site: parser.name, ...e })));
              report.totals.errors += writeResult.errors.length;
            }
          } catch (err) {
            console.error(`[Scraper] Failed to write ${toWrite.length} listings from ${parser.name}: ${err.message}`);
            report.writeErrors.push({ site: parser.name, error: err.message });
            report.totals.errors++;
          }
        }
      }

      report.sites[parser.name] = siteReport;
      const writeText = dryRun ? `${siteReport.wouldWrite || 0} would write` : `${siteReport.written || 0} written`;
      const issueText = siteReport.sourceIssues.length > 0 ? `, ${siteReport.sourceIssues.length} source issues` : '';
      console.log(`[Scraper] ${parser.name}: ${siteReport.parsed} found → ${siteReport.passed} passed → ${writeText} (${siteReport.duplicates} dupes, ${siteReport.rejected} rejected${issueText})`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`[Scraper] Done in ${elapsed} minutes`);
  console.log(`[Scraper] Totals: ${report.totals.parsed} found → ${report.totals.passed} passed → ${dryRun ? `${report.totals.wouldWrite} would write` : `${report.totals.written} written`}`);
  console.log(`[Scraper] Dedup caught: ${report.totals.duplicates} duplicates`);

  report.elapsedMinutes = parseFloat(elapsed);
  return report;
}

/**
 * Replay leads queued in data/failed-writes/ by earlier runs.
 *
 * Each queued listing is re-checked against the current dedup index (it may
 * have been written successfully by a later scrape) before re-creating.
 * Processed files move to failed-writes/done/; listings that fail again are
 * re-persisted to today's queue file by writeListings, so a replayed file is
 * never processed twice.
 */
async function replayFailedWrites(dedupIndex, dryRun, report) {
  let pending;
  try {
    pending = loadPendingFailedWrites();
  } catch (err) {
    report.warnings.push(`Could not read failed-write queue: ${err.message}`);
    return;
  }
  if (pending.length === 0) return;

  const totalQueued = pending.reduce((sum, f) => sum + f.listings.length, 0);
  console.log(`[Scraper] Replaying ${totalQueued} queued leads from ${pending.length} failed-write file(s)...`);

  if (dryRun) {
    report.warnings.push(`Dry run: ${totalQueued} queued leads in ${pending.length} failed-write file(s) awaiting replay`);
    return;
  }

  let replayed = 0;
  let skippedDupes = 0;

  for (const { filePath, listings } of pending) {
    const toWrite = [];
    for (const listing of listings) {
      const dupCheck = airtable.checkDuplicate(listing, dedupIndex);
      if (dupCheck.isDuplicate) {
        skippedDupes++;
        continue;
      }
      toWrite.push(listing);
      if (listing.url) dedupIndex.urlSet.add(listing.url);
      if (listing.fingerprint) dedupIndex.fingerprintSet.add(listing.fingerprint);
      if (dedupIndex.locationMap) airtable.addToLocationMap(dedupIndex.locationMap, listing);
    }

    try {
      if (toWrite.length > 0) {
        // Re-failures must land in their own queue file — appending them to
        // a file that is itself being replayed would archive them with it
        const writeResult = await airtable.writeListings(toWrite, { fileTag: `replay-${Date.now()}` });
        replayed += writeResult.created;
        report.totals.written += writeResult.created;
        if (writeResult.errors.length > 0) {
          report.writeErrors.push(...writeResult.errors.map(e => ({ site: 'replay', ...e })));
          report.totals.errors += writeResult.errors.length;
        }
      }
      archiveFailedWrites(filePath);
    } catch (err) {
      console.error(`[Scraper] Replay failed for ${filePath}: ${err.message}`);
      report.writeErrors.push({ site: 'replay', error: `${filePath}: ${err.message}` });
      report.totals.errors++;
    }
  }

  const summary = `Replayed ${replayed} previously failed leads (${skippedDupes} already in Airtable)`;
  console.log(`[Scraper] ${summary}`);
  report.warnings.push(summary);
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

function selectTargetCounties(countyTargets, requestedTargets) {
  const targetLookup = new Map(
    countyTargets.counties.map(target => [targetKey(target.county, target.state), target])
  );
  const selected = [];
  const missing = [];

  for (const requested of requestedTargets) {
    const found = targetLookup.get(targetKey(requested.county, requested.state));
    if (found) selected.push(found);
    else missing.push(`${requested.county}, ${requested.state}`);
  }

  if (missing.length > 0) {
    throw new Error(`Requested validation target counties were not found: ${missing.join('; ')}`);
  }

  return {
    ...countyTargets,
    counties: selected,
    countyMap: new Map(
      selected.map(target => [targetKey(target.county, target.state), target.maxCPA])
    ),
  };
}

function targetKey(county, state) {
  return `${String(county).toLowerCase()}|${String(state).toUpperCase()}`;
}

module.exports = { runScraper, selectTargetCounties, replayFailedWrites };
