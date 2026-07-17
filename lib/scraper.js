'use strict';

const settings = require('../config/settings.json');
const { getEnabledParsers } = require('./parsers');
const { closeBrowser } = require('./browser-fetch');
const { initFilter, filterListing } = require('./filter');
const { generateFingerprint } = require('./fingerprint');
const { selectRotationCounties } = require('./county-rotation');
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
  // Set by scripts/run-scraper.sh when the pre-run self-update could not
  // bring the checkout up to date with GitHub
  if (process.env.SCRAPER_UPDATE_WARNING) {
    report.warnings.push(`⚠️ ${process.env.SCRAPER_UPDATE_WARNING}`);
    console.warn(`[Scraper] ${process.env.SCRAPER_UPDATE_WARNING}`);
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
      const status = err.statusCode || err.status;
      const hint = (status === 401 || status === 403)
        ? ' — the Airtable token was rejected; run `npm run check-airtable` on this machine to diagnose'
        : '';
      throw new Error(`Dedup index load failed — scrape aborted to avoid duplicate writes: ${err.message}${hint}`);
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

  // Incremental early-stop predicate: a URL is "known" when it is already in
  // the dedup index (existing Airtable inventory) OR was added earlier this
  // run (dedupIndex.urlSet is mutated live in processScrapedListings/replay).
  // Newest-first parsers use it to truncate a county series once a whole page
  // is already-known — see BaseParser.scrapeAll. Comparison is exact-match
  // against urlSet, the SAME form checkDuplicate uses and writeListings
  // stores, so both sides canonicalize identically. Kill switch:
  // SCRAPER_INCREMENTAL=false withholds the predicate entirely (default on).
  const incrementalEnabled = process.env.SCRAPER_INCREMENTAL !== 'false';
  const isKnownUrl = incrementalEnabled
    ? (url => dedupIndex.urlSet.has(url))
    : null;
  if (!incrementalEnabled) {
    console.log('[Scraper] Incremental early-stop disabled (SCRAPER_INCREMENTAL=false)');
  }

  const ctx = { dedupIndex, sessionFingerprints, report, dryRun, isKnownUrl };

  // Per-site county subset for tonight. A site with countyRotation N sweeps
  // 1/Nth of the counties per night; the same subset feeds both the first pass
  // and any bot-wall retry. Validation/targeted mode always gets every
  // requested county (see resolveParserCounties).
  const bypassRotation = Boolean(options.targetCounties && options.targetCounties.length > 0);
  const parserCounties = resolveParserCounties(
    parsers, countyTargets.counties, bypassRotation, new Date(startTime), report
  );

  // Sites whose first pass ended in a bot-wall circuit-breaker abort — each
  // gets ONE post-cooldown retry after all first passes finish (see below)
  const abortedParsers = [];

  // Process parsers in groups of maxConcurrentSites
  for (let i = 0; i < parsers.length; i += maxConcurrentSites) {
    const batch = parsers.slice(i, i + maxConcurrentSites);
    const results = await Promise.allSettled(
      batch.map(parser => {
        // Install the known-URL predicate before scrapeAll so newest-first
        // parsers can early-stop exhausted county series (no-op when the
        // kill switch left isKnownUrl null).
        if (isKnownUrl) parser.setKnownUrlPredicate(isKnownUrl);
        return runParserSafe(parser, parserCounties.get(parser).counties);
      })
    );

    for (let j = 0; j < results.length; j++) {
      const parser = batch[j];
      const result = results[j];
      const { rotation } = parserCounties.get(parser);

      if (result.status === 'rejected') {
        console.error(`[Scraper] ${parser.name} CRASHED: ${result.reason?.message || result.reason}`);
        const sourceIssues = parser.sourceIssues || [];
        report.sourceIssues.push(...sourceIssues);
        report.sites[parser.name] = { status: 'error', error: result.reason?.message, stats: parser.stats, sourceIssues, rotation };
        report.totals.errors++;
        continue;
      }

      const siteReport = await processScrapedListings(parser, result.value, ctx);
      siteReport.rotation = rotation;
      report.sites[parser.name] = siteReport;

      // Circuit breaker tripped this run — queue the site for one retry once
      // the other sites have finished their own first passes. The retry reuses
      // this parser's rotation subset so both passes cover the same counties.
      if (parser.stats.abortedByBotWall) {
        abortedParsers.push({
          parser,
          abortedAt: parser.stats.abortedAt,
          firstPass: siteReport,
          counties: parserCounties.get(parser).counties,
          rotation,
        });
      }
    }
  }

  // Give each bot-walled site one second chance after a cooldown — bot walls
  // (Akamai on the CoStar sites) are often transient rate-penalties that clear
  // within the run's own multi-hour window
  await runBotWallRetries(abortedParsers, ctx, countyTargets.counties);

  // The browser-fallback Chromium is a child process — close it or the node
  // process never exits (index.js also closes it as a crash safety net)
  await closeBrowser();

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

/**
 * Filter, deduplicate, and write one parser's scraped listings, mutating the
 * shared report/dedup context. Returns the per-site report. Used identically
 * for a parser's first pass and its post-cooldown bot-wall retry — retry
 * listings flow into the report exactly like first-pass ones (dedup downstream
 * already handles the overlap between the two passes).
 */
async function processScrapedListings(parser, listings, ctx) {
  const { dedupIndex, sessionFingerprints, report, dryRun } = ctx;

  const siteReport = {
    status: 'ok',
    checked: parser.stats.checked,
    parsed: listings.length,
    passed: 0,
    duplicates: 0,
    rejected: 0,
    errors: parser.stats.errors,
    sourceIssues: parser.sourceIssues || [],
    // Count of county series this parser truncated early because a whole page
    // was already-known inventory (0 for parsers not eligible / kill switch).
    earlyStoppedSeries: parser.stats.earlyStoppedSeries || 0,
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
      // common, so this is a warning on the record, not a silent skip.
      // Lands in the base's 'Possible Duplicate Reason' field.
      listing.validationErrors = [...(listing.validationErrors || []), dupCheck.suspectedCrossSite];
      listing.possibleDuplicateReason = dupCheck.suspectedCrossSite;
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

  const writeText = dryRun ? `${siteReport.wouldWrite || 0} would write` : `${siteReport.written || 0} written`;
  const issueText = siteReport.sourceIssues.length > 0 ? `, ${siteReport.sourceIssues.length} source issues` : '';
  console.log(`[Scraper] ${parser.name}: ${siteReport.parsed} found → ${siteReport.passed} passed → ${writeText} (${siteReport.duplicates} dupes, ${siteReport.rejected} rejected${issueText})`);

  return siteReport;
}

/**
 * Resolve the bot-wall retry cooldown in minutes. 0 disables the retry
 * entirely. CI dry-runs must never sleep an hour, so GITHUB_ACTIONS forces 0
 * regardless of config or the env override.
 */
function resolveBotWallCooldownMinutes() {
  if (process.env.GITHUB_ACTIONS) return 0;
  const override = process.env.SCRAPER_BOTWALL_COOLDOWN_MINUTES;
  if (override !== undefined && override !== '') {
    const parsed = Number.parseInt(override, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return settings.scraper.botWallCooldownMinutes || 0;
}

/**
 * Give each site whose first pass tripped the bot-wall circuit breaker ONE
 * more scrape after a cooldown. Retries run inline in the orchestrator (never
 * delegated). Disabled when the cooldown resolves to 0 (env override or CI);
 * in that case each aborted site gets an honest warning explaining the skip.
 */
async function runBotWallRetries(abortedParsers, ctx, counties) {
  if (abortedParsers.length === 0) return;

  const cooldownMinutes = resolveBotWallCooldownMinutes();
  if (cooldownMinutes <= 0) {
    const reason = process.env.GITHUB_ACTIONS
      ? 'post-cooldown retry disabled in CI'
      : 'post-cooldown retry disabled (SCRAPER_BOTWALL_COOLDOWN_MINUTES=0)';
    for (const { parser } of abortedParsers) {
      const note = `${parser.name}: bot-wall breaker tripped — ${reason}`;
      ctx.report.warnings.push(note);
      console.log(`[Scraper] ${note}`);
    }
    return;
  }

  await retryAbortedSites(abortedParsers, cooldownMinutes, ctx, counties);
}

/**
 * Retry each bot-walled site once. Other sites' scraping time counts toward the
 * cooldown: if the cooldown already elapsed during it, retry immediately;
 * otherwise sleep only the remaining difference. A retry that trips the breaker
 * again is done for the night — no third attempt.
 */
async function retryAbortedSites(abortedParsers, cooldownMinutes, ctx, counties) {
  const { report } = ctx;
  const cooldownMs = cooldownMinutes * 60 * 1000;

  for (const { parser, abortedAt, firstPass, counties: entryCounties, rotation } of abortedParsers) {
    // Reuse the exact county subset the first pass swept (rotation-filtered);
    // fall back to the shared list only when the entry carries none.
    const retryCounties = entryCounties || counties;
    const remainingMs = cooldownMs - (Date.now() - abortedAt);
    if (remainingMs > 0) {
      const waitMinutes = (remainingMs / 60000).toFixed(1);
      console.log(`[Scraper] ${parser.name}: bot-wall breaker tripped; sleeping ${waitMinutes} min to complete the ${cooldownMinutes} min cooldown before one retry...`);
      await parser.sleep(remainingMs);
    } else {
      console.log(`[Scraper] ${parser.name}: bot-wall breaker tripped; ${cooldownMinutes} min cooldown already elapsed during other sites — retrying now`);
    }

    parser.prepareForRetry();
    // The post-cooldown retry gets the same early-stop predicate as the first
    // pass (no-op when the kill switch left ctx.isKnownUrl null).
    if (ctx.isKnownUrl) parser.setKnownUrlPredicate(ctx.isKnownUrl);

    let retryListings;
    try {
      retryListings = await parser.scrapeAll(retryCounties);
    } catch (err) {
      console.error(`[Scraper] ${parser.name} retry CRASHED: ${err.message}`);
      report.sourceIssues.push(...(parser.sourceIssues || []));
      report.warnings.push(`${parser.name}: bot-wall breaker tripped, post-cooldown retry crashed — ${err.message}`);
      continue;
    }

    const retryReport = await processScrapedListings(parser, retryListings, ctx);
    const blockedAgain = Boolean(parser.stats.abortedByBotWall);
    const cooldownActualMinutes = Math.round((Date.now() - abortedAt) / 60000);

    report.sites[parser.name] = {
      ...retryReport,
      status: 'retried_after_cooldown',
      rotation,
      cooldownMinutes: cooldownActualMinutes,
      firstPass: { parsed: firstPass.parsed, passed: firstPass.passed },
      retryPass: { parsed: retryReport.parsed, passed: retryReport.passed, blockedAgain },
    };

    const outcome = blockedAgain
      ? 'blocked again, done for the night'
      : `succeeded (${retryReport.parsed} found, ${retryReport.passed} passed)`;
    report.warnings.push(`${parser.name}: bot-wall breaker tripped, retried after ${cooldownActualMinutes} min cooldown — ${outcome}`);
  }
}

/**
 * Resolve each parser's county subset for this run, keyed by parser instance.
 * A site with countyRotation N sweeps 1/Nth of the counties tonight (see
 * lib/county-rotation.js). Validation/targeted mode bypasses rotation entirely
 * — an operator who named specific counties must always get exactly those.
 * A warning per rotating site records the subset in the report.
 */
function resolveParserCounties(parsers, counties, bypassRotation, runDate, report) {
  const map = new Map();
  for (const parser of parsers) {
    if (bypassRotation) {
      map.set(parser, { counties, rotation: null });
      continue;
    }
    const plan = selectRotationCounties(counties, parser.countyRotation, runDate);
    map.set(parser, plan);
    if (plan.rotation) {
      const r = plan.rotation;
      report.warnings.push(
        `${parser.name}: county rotation ${r.groupsTotal} — swept ${r.sweptCount} of ${r.totalCount} counties (group ${r.groupIndex + 1} of ${r.groupsTotal})`
      );
    }
  }
  return map;
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

module.exports = {
  runScraper,
  selectTargetCounties,
  resolveParserCounties,
  replayFailedWrites,
  processScrapedListings,
  runBotWallRetries,
  resolveBotWallCooldownMinutes,
};
