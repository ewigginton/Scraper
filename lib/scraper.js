'use strict';

const settings = require('../config/settings.json');
const { getEnabledParsers } = require('./parsers');
const { closeBrowser } = require('./browser-fetch');
const { initFilter, filterListing, isTargetCounty } = require('./filter');
const { generateFingerprint } = require('./fingerprint');
const { selectRotationCounties } = require('./county-rotation');
const airtable = require('./airtable');
const { loadPendingFailedWrites, archiveFailedWrites, appendCoverageSighting } = require('./local-store');

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
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, wouldWrite: 0, errors: 0, sourceMerges: 0 },
    duplicateDetails: [],
    // Cross-site duplicates whose source+link was preserved on the lead they
    // duplicate instead of being discarded with the listing.
    mergeDetails: [],
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

  // Weekly coverage audit (lib/notify.js COVERAGE AUDIT section) needs the
  // canonical target-county list (proper-case names) to compare against the
  // sighting log written at the end of this run.
  report.targetCounties = countyTargets.counties.map(target => ({ county: target.county, state: target.state }));

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

  // Track new fingerprints within this scrape session to catch cross-site dupes.
  // Each entry keeps a reference to the listing that claimed the fingerprint —
  // and, once its batch has been written, that record's id — so a later
  // cross-site duplicate can have its source merged into the same lead.
  // fingerprint -> { source, name, url, listing, written, recordId }
  const sessionFingerprints = new Map();

  // Coverage audit: every target 'county|ST' key (lib/filter.js's key shape)
  // seen anywhere this run, across every site/pass — written once at the end
  // via lib/local-store.js's appendCoverageSighting (see processScrapedListings).
  const sightedCounties = new Set();

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

  const ctx = { dedupIndex, sessionFingerprints, report, dryRun, isKnownUrl, sightedCounties };

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

  // Coverage audit: record which target counties were sighted this run
  // (across every site, dry run or live). A write failure here must never
  // fail the run — it only means Sunday's audit email runs on a slightly
  // stale log, same tolerance the reader (lib/notify.js) already has.
  try {
    appendCoverageSighting(Array.from(sightedCounties), new Date(startTime));
  } catch (err) {
    console.warn(`[Scraper] Could not append coverage-audit log: ${err.message}`);
    report.warnings.push(`Coverage audit log not updated: ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`[Scraper] Done in ${elapsed} minutes`);
  console.log(`[Scraper] Totals: ${report.totals.parsed} found → ${report.totals.passed} passed → ${dryRun ? `${report.totals.wouldWrite} would write` : `${report.totals.written} written`}`);
  console.log(`[Scraper] Dedup caught: ${report.totals.duplicates} duplicates (${report.totals.sourceMerges} had their source+link merged into the existing lead)`);

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
  // Merges from the replay queue report under the 'replay' source (there is no
  // site pass to attribute them to). Dry runs returned above, so these are live.
  const mergeCtx = { dedupIndex, report, dryRun };

  for (const { filePath, listings } of pending) {
    const toWrite = [];
    for (const listing of listings) {
      const dupCheck = airtable.checkDuplicate(listing, dedupIndex);
      if (dupCheck.isDuplicate) {
        skippedDupes++;
        // The queued lead lost its race to a live scrape — keep its source+link
        // on whichever record won instead of dropping it with the queue file.
        await mergeDuplicateIntoExistingRecord(listing, dupCheck, 'replay', mergeCtx, null);
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
 * Count a preserved source on the run report (and the site report, when the
 * merge came from a site pass). Every field is written defensively: index.js
 * builds fallback report shells, and stale queued reports predate these fields.
 * The duplicate's URL joins the dedup index so a second identical card tonight
 * dedups on the URL instead of merging again.
 */
function recordSourceMerge(ctx, siteReport, detail) {
  const { report, dedupIndex, dryRun } = ctx;
  report.totals.sourceMerges = (report.totals.sourceMerges || 0) + 1;
  if (siteReport) siteReport.sourceMerges = (siteReport.sourceMerges || 0) + 1;
  if (!report.mergeDetails) report.mergeDetails = [];
  report.mergeDetails.push({ ...detail, dryRun: Boolean(dryRun) });
  if (detail.url && dedupIndex && dedupIndex.urlSet) dedupIndex.urlSet.add(detail.url);
}

/** Duplicate-reason suffix for a dup whose source was (or would be) preserved. */
function mergedSuffix(dryRun) {
  return dryRun
    ? 'source+link would be merged into the existing lead'
    : 'source+link merged into the existing lead';
}

/** How an existing Airtable record is described in the merge report/email. */
function describeExistingRecord(record) {
  const fields = (record && record.fields) || {};
  const sourceText = fields[airtable.FIELDS.source];
  return {
    recordId: record && record.id,
    url: fields[airtable.FIELDS.url],
    // The primary source is the Source field's first line; later lines are
    // sources merged in by earlier runs.
    source: sourceText ? String(sourceText).split('\n')[0].trim() : undefined,
    name: fields[airtable.FIELDS.propertyName] || fields[airtable.FIELDS.nameFormula],
  };
}

/**
 * A cross-site duplicate of an EXISTING Airtable lead carries a link that lead
 * does not have. Append its source+link to that record's Source field rather
 * than discarding it with the listing.
 *
 * Only fingerprint matches merge: a URL match means this exact link is already
 * recorded, so there is nothing to preserve. Dry runs make no write at all —
 * they only report what would be merged. A merge failure is non-fatal: it warns
 * and the listing is counted as a plain duplicate, exactly as before.
 */
async function mergeDuplicateIntoExistingRecord(listing, dupCheck, sourceName, ctx, siteReport) {
  if (dupCheck.matchType !== 'fingerprint') return { merged: false };
  if (!listing.url || !dupCheck.existingRecord) return { merged: false };

  const detail = {
    source: sourceName,
    name: listing.name,
    url: listing.url,
    matchType: dupCheck.matchType,
    target: 'existing-record',
    mergedInto: describeExistingRecord(dupCheck.existingRecord),
  };

  if (ctx.dryRun) {
    recordSourceMerge(ctx, siteReport, detail);
    return { merged: true };
  }

  try {
    const result = await airtable.mergeSourceIntoRecord(dupCheck.existingRecord, listing);
    if (!result || !result.merged) return { merged: false };
    recordSourceMerge(ctx, siteReport, detail);
    return { merged: true };
  } catch (err) {
    const warning = `Could not merge ${sourceName} source into existing lead ${dupCheck.existingRecord.id}: ${err.message}`;
    console.warn(`[Scraper] ${warning}`);
    ctx.report.warnings.push(warning);
    return { merged: false };
  }
}

/** Add a merged source to a listing that has not been written yet. */
function addAdditionalSource(listing, source, url) {
  if (!url || url === listing.url) return false;
  if (!Array.isArray(listing.additionalSources)) listing.additionalSources = [];
  if (listing.additionalSources.some(entry => entry.url === url)) return false;
  listing.additionalSources.push({ source, url });
  return true;
}

/**
 * Same property, two sites, same night. Where the extra source goes depends on
 * whether the first listing has reached Airtable yet:
 *   - not written (same site pass, or any dry run) → ride along on the record
 *     about to be created (listing.additionalSources)
 *   - already written (an earlier site's batch) → merge into that record by id
 *   - written but with no id (its batch failed and was queued) → no merge;
 *     counted as a plain duplicate rather than pretending the link was kept
 */
async function mergeDuplicateIntoSessionListing(listing, existing, sourceName, ctx, siteReport) {
  if (!listing.url) return { merged: false };

  const detail = {
    source: sourceName,
    name: listing.name,
    url: listing.url,
    matchType: 'session-fingerprint',
  };

  if (!existing.written) {
    if (!existing.listing) return { merged: false };
    if (!addAdditionalSource(existing.listing, listing.source || sourceName, listing.url)) {
      return { merged: false };
    }
    recordSourceMerge(ctx, siteReport, {
      ...detail,
      target: 'session-listing',
      mergedInto: { url: existing.url, source: existing.source, name: existing.name },
    });
    return { merged: true };
  }

  if (!existing.recordId || ctx.dryRun) return { merged: false };

  try {
    // fields are unknown here (the record was created minutes ago), so the
    // merge helper reads its current Source before appending.
    const result = await airtable.mergeSourceIntoRecord({ id: existing.recordId, fields: {} }, listing);
    if (!result || !result.merged) return { merged: false };
    recordSourceMerge(ctx, siteReport, {
      ...detail,
      target: 'existing-record',
      mergedInto: { recordId: existing.recordId, url: existing.url, source: existing.source, name: existing.name },
    });
    return { merged: true };
  } catch (err) {
    const warning = `Could not merge ${sourceName} source into lead ${existing.recordId} written earlier this run: ${err.message}`;
    console.warn(`[Scraper] ${warning}`);
    ctx.report.warnings.push(warning);
    return { merged: false };
  }
}

/**
 * Mark this batch's session-fingerprint entries as written and attach the record
 * ids Airtable returned, so a duplicate found by a LATER site merges into the
 * record instead of mutating a listing that has already been sent. Entries whose
 * write failed keep recordId null — an honest "no merge target".
 */
function markSessionListingsWritten(sessionFingerprints, writtenListings, records) {
  const idByUrl = new Map((records || []).map(record => [record.url, record.id]));
  const batch = new Set(writtenListings);
  for (const entry of sessionFingerprints.values()) {
    if (entry.written || !entry.listing || !batch.has(entry.listing)) continue;
    entry.written = true;
    entry.recordId = idByUrl.get(entry.listing.url) || null;
  }
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
  const { dedupIndex, sessionFingerprints, report, dryRun, sightedCounties } = ctx;

  const siteReport = {
    status: 'ok',
    checked: parser.stats.checked,
    parsed: listings.length,
    passed: 0,
    duplicates: 0,
    rejected: 0,
    // Duplicates whose source+link was preserved on the lead they duplicate
    // (a subset of `duplicates` — a merged dup is still a caught dup).
    sourceMerges: 0,
    errors: parser.stats.errors,
    // Undefined when the parser predates this field (e.g. a stale queued
    // report replayed after an upgrade) — callers must treat undefined as
    // "unknown" and never let it suppress a real alarm. 0 means this run's
    // target counties fell entirely outside the site's coverage, so it was
    // never asked to fetch anything.
    searchUrlsPlanned: parser.stats.searchUrlsPlanned,
    sourceIssues: parser.sourceIssues || [],
    // Count of county series this parser truncated early because a whole page
    // was already-known inventory (0 for parsers not eligible / kill switch).
    earlyStoppedSeries: parser.stats.earlyStoppedSeries || 0,
    // Detail-page enrichment tallies (set by enrichListingsWithDetail); stay 0
    // when enrichment is gated off (dry run / CI / kill switch) or nothing is
    // written.
    enrichmentFetched: 0,
    enrichmentFailed: 0,
  };
  if (siteReport.sourceIssues.length > 0) {
    report.sourceIssues.push(...siteReport.sourceIssues);
  }
  report.totals.parsed += listings.length;

  // Coverage audit sightings: every parsed listing counts (pre-filter — a
  // rejected-on-price or duplicate listing still proves the site has live
  // inventory in that county), as long as its county+state resolves against
  // the target list. Key shape matches lib/filter.js's countyMap exactly so
  // lib/notify.js's audit compares apples to apples.
  if (sightedCounties) {
    for (const listing of listings) {
      if (listing.county && listing.state && isTargetCounty(listing.county, listing.state)) {
        sightedCounties.add(`${String(listing.county).toLowerCase()}|${String(listing.state).toUpperCase()}`);
      }
    }
  }

  // Step 3.5: Pre-filter detail enrichment for card-sparse listings. A listing
  // that arrived with only a URL (no price/acres/county/state — some
  // LANDFLIP/MidwestLandGroup cards omit a filter-critical field) would be
  // REJECTED by the data-validation gate in filterListing BEFORE the post-filter
  // enrichment (Step 4.5) ever runs, so its detail-page price/acres/county could
  // never rescue it. Fill those fields from the detail page FIRST — but only for
  // listings that are (a) missing a filter-critical field, (b) have a URL, and
  // (c) are not already a known-duplicate URL (a cheap gate that avoids spending
  // a detail fetch on inventory we already hold; a full fingerprint dedup can't
  // run yet because the fields it needs are the very ones still missing). Gated
  // by the same detailEnrichmentEnabled switch as Step 4.5 (OFF for dry run / CI
  // / kill switch), so dry runs — which never write — still perform zero fetches.
  if (detailEnrichmentEnabled(dryRun)) {
    await enrichSparseListingsBeforeFilter(parser, listings, dedupIndex, siteReport);
  }

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
      // A duplicate from a site we don't have a link for still carries something
      // worth keeping — merge its source+link onto the lead it duplicates.
      const merge = await mergeDuplicateIntoExistingRecord(listing, dupCheck, parser.name, ctx, siteReport);
      siteReport.duplicates++;
      report.totals.duplicates++;
      report.duplicateDetails.push({
        source: parser.name,
        name: listing.name,
        url: listing.url,
        reason: merge.merged ? `${dupCheck.reason} — ${mergedSuffix(dryRun)}` : dupCheck.reason,
        matchType: dupCheck.matchType,
        merged: merge.merged,
      });
      continue;
    }

    // 4d: Check against this session's fingerprints (cross-site dupes found tonight)
    if (fingerprint && sessionFingerprints.has(fingerprint)) {
      const existing = sessionFingerprints.get(fingerprint);
      const merge = await mergeDuplicateIntoSessionListing(listing, existing, parser.name, ctx, siteReport);
      siteReport.duplicates++;
      report.totals.duplicates++;
      const baseReason = `Cross-site dup found in this session (already from ${existing.source}: ${existing.name})`;
      report.duplicateDetails.push({
        source: parser.name,
        name: listing.name,
        url: listing.url,
        reason: merge.merged ? `${baseReason} — ${mergedSuffix(dryRun)}` : baseReason,
        matchType: 'session-fingerprint',
        merged: merge.merged,
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
      sessionFingerprints.set(fingerprint, {
        source: parser.name,
        name: listing.name,
        url: listing.url,
        listing,
        written: false,
        recordId: null,
      });
    }
    if (listing.url) dedupIndex.urlSet.add(listing.url);
    if (dedupIndex.locationMap) airtable.addToLocationMap(dedupIndex.locationMap, listing);
  }

  // Step 4.5: Enrich the leads we're about to write with their detail page's
  // fuller description (and any still-missing structured field). ONLY the
  // to-be-written leads get a detail fetch here (0-20/night) — dupes and rejects
  // never do. The full description is where DEALBREAKER language (e.g.
  // 'conservation easement') lives; the ~400-char search-card blurb rarely
  // carries it, so review scanning only the blurb misses those. A lead already
  // fetched in the Step 3.5 pre-filter pass is skipped here (no double fetch).
  // Failures are non-fatal — the lead is still written with the card blurb (see
  // enrichListingsWithDetail).
  if (toWrite.length > 0 && detailEnrichmentEnabled(dryRun)) {
    await enrichListingsWithDetail(parser, toWrite, siteReport);
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
        // These listings can no longer gain an additionalSources entry — a
        // later site's duplicate has to merge into the created record instead.
        markSessionListingsWritten(sessionFingerprints, toWrite, writeResult.records);
        if (writeResult.errors.length > 0) {
          report.writeErrors.push(...writeResult.errors.map(e => ({ site: parser.name, ...e })));
          report.totals.errors += writeResult.errors.length;
        }
      } catch (err) {
        console.error(`[Scraper] Failed to write ${toWrite.length} listings from ${parser.name}: ${err.message}`);
        report.writeErrors.push({ site: parser.name, error: err.message });
        report.totals.errors++;
        markSessionListingsWritten(sessionFingerprints, toWrite, []);
      }
    }
  }

  const writeText = dryRun ? `${siteReport.wouldWrite || 0} would write` : `${siteReport.written || 0} written`;
  const issueText = siteReport.sourceIssues.length > 0 ? `, ${siteReport.sourceIssues.length} source issues` : '';
  const mergeText = siteReport.sourceMerges > 0 ? `, ${siteReport.sourceMerges} sources merged` : '';
  console.log(`[Scraper] ${parser.name}: ${siteReport.parsed} found → ${siteReport.passed} passed → ${writeText} (${siteReport.duplicates} dupes${mergeText}, ${siteReport.rejected} rejected${issueText})`);

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
 * delegated). Disabled when the cooldown resolves to 0 (env override or CI), and
 * never offered at all to bot-wall-sensitive sources; in every skip case the
 * aborted site gets an honest warning explaining why.
 */
async function runBotWallRetries(abortedParsers, ctx, counties) {
  if (abortedParsers.length === 0) return;

  // Bot-wall-sensitive sources (the CoStar network, config
  // `sites.<key>.botWallSensitive`) get NO same-night second attempt, whatever
  // the cooldown is set to. They already refused us once tonight from this
  // residential IP; coming back an hour later is exactly the pattern that turns
  // a transient challenge into a lasting reputation penalty. Done for the night
  // by design — and said so in the report so it never reads as a silent skip.
  const retryable = [];
  for (const entry of abortedParsers) {
    if (entry.parser.botWallSensitive) {
      const note = `${entry.parser.name}: bot-wall breaker tripped — bot-sensitive source: no same-night retry, protecting IP reputation (done for the night by design)`;
      ctx.report.warnings.push(note);
      console.log(`[Scraper] ${note}`);
      continue;
    }
    retryable.push(entry);
  }
  if (retryable.length === 0) return;

  const cooldownMinutes = resolveBotWallCooldownMinutes();
  if (cooldownMinutes <= 0) {
    const reason = process.env.GITHUB_ACTIONS
      ? 'post-cooldown retry disabled in CI'
      : 'post-cooldown retry disabled (SCRAPER_BOTWALL_COOLDOWN_MINUTES=0)';
    for (const { parser } of retryable) {
      const note = `${parser.name}: bot-wall breaker tripped — ${reason}`;
      ctx.report.warnings.push(note);
      console.log(`[Scraper] ${note}`);
    }
    return;
  }

  await retryAbortedSites(retryable, cooldownMinutes, ctx, counties);
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
    // Parsers with no per-county URL (MidwestLandGroup: one national index)
    // fetch the SAME page regardless of the county subset, so rotating their
    // counties only starves the downstream county filter without cutting any
    // requests. Hand them the full list, unrotated, and emit no rotation line.
    if (parser.usesCountyUrls === false) {
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

// Combined card-blurb + detail-text description is capped here — a touch above
// the 2000-char detail cap so a short card blurb can ride along with a full
// detail description without truncating the dealbreaker prose.
const MAX_ENRICHED_DESCRIPTION_CHARS = 2400;

/**
 * Whether NEW-lead detail-page enrichment runs this pass. OFF for dry runs
 * (nothing is written, so spending detail requests is pure waste), in CI
 * (GITHUB_ACTIONS — dry-run only, and never hit live detail pages from CI),
 * and via the SCRAPER_DETAIL_ENRICHMENT=false kill switch. Default ON.
 */
function detailEnrichmentEnabled(dryRun) {
  if (dryRun) return false;
  if (process.env.SCRAPER_DETAIL_ENRICHMENT === 'false') return false;
  if (process.env.GITHUB_ACTIONS) return false;
  return true;
}

// The four fields lib/filter.js requires on every listing (its data-validation
// gate rejects a listing missing any of them). A listing lacking one of these
// is "card-sparse" and can only pass the filter if the detail page fills it in.
const FILTER_CRITICAL_FIELDS = ['price', 'acres', 'county', 'state'];

/** True when a listing is missing at least one filter-critical field. */
function isMissingFilterCriticalField(listing) {
  return FILTER_CRITICAL_FIELDS.some(field => !listing[field]);
}

/**
 * Fold a fetched detail page into a listing IN PLACE: fill ONLY missing/null
 * filter-critical fields from the parser's structured parseDetailPage read
 * (never overwriting a non-null value scraped from the card), then merge the
 * detail description into listing.description. parseDetailPage returns {} for
 * parsers without a structured detail read, so those keep description-only
 * enrichment exactly as before. Marks the listing enriched so a later pass
 * skips a redundant fetch.
 */
function applyDetailToListing(parser, listing, html) {
  let detail = {};
  try {
    detail = parser.parseDetailPage(html) || {};
  } catch (err) {
    // parseDetailPage is contracted failure-safe, but never let a rogue
    // implementation break enrichment — treat a throw as "no structured data".
    detail = {};
  }

  for (const field of FILTER_CRITICAL_FIELDS) {
    if (!listing[field] && detail[field] != null && detail[field] !== '') {
      listing[field] = detail[field];
    }
  }

  // Prefer the detail parser's own description (parseDetailPage sets it when it
  // has a precise block); fall back to the generic largest-prose extractor.
  const detailText = detail.description || parser.extractDetailDescription(html);
  listing.description = combineDescriptions(listing.description, detailText);

  // Coordinates from the detail page close the flood-screening gap: scraped
  // search cards almost never carry them, so the review-night FEMA flood check
  // (lib/review.js, which only fires on records with coordinates) had no input.
  // Fill ONLY when the listing has none — never overwrite a coordinate the
  // parser already scraped — mirroring the filter-critical fill above. The
  // value flows to Airtable's Coordinate field via lib/airtable.js
  // listingToFields, so review night picks it up on the written record.
  if (!listing.coordinates) {
    const coords = detail.coordinates || parser.extractDetailCoordinates(html);
    if (coords) listing.coordinates = coords;
  }
  listing._detailEnriched = true;
}

/**
 * Fetch each to-be-written lead's detail page and fold its fuller description
 * (and any still-missing structured field) into the listing. listing.description
 * lands in the Land table's 'Scraper Notes' field — the exact text
 * lib/review.js scans for DEALBREAKER/flag keywords. Uses the same jittered
 * request cadence as scrapeAll so enrichment fetches don't form a metronomic
 * bot signature. A lead already enriched in the pre-filter pass is skipped (no
 * double fetch). Every failure is non-fatal: it's logged, counted
 * (siteReport.enrichmentFailed), and the lead is written with its card blurb.
 */
async function enrichListingsWithDetail(parser, listings, siteReport) {
  const requestDelayMs = settings.scraper.requestDelayMs;

  for (const listing of listings) {
    if (!listing.url || listing._detailEnriched) continue;
    try {
      // Jittered delay — mirrors scrapeAll's cadence between fetches.
      await parser.sleep(requestDelayMs * (0.75 + Math.random() * 1.25));
      const html = await parser.fetchPageSmart(listing.url);
      applyDetailToListing(parser, listing, html);
      siteReport.enrichmentFetched++;
    } catch (err) {
      siteReport.enrichmentFailed++;
      console.warn(`[Scraper] ${parser.name}: detail enrichment failed for ${listing.url}: ${err.message}`);
    }
  }
}

/**
 * Pre-filter enrichment: fetch the detail page for each card-sparse listing
 * (missing a filter-critical field) so its structured price/acres/county/state
 * can rescue it BEFORE lib/filter.js's data-validation gate would reject it.
 * Skips listings that already carry every field (nothing to rescue), have no
 * URL to fetch, or whose URL is already in the dedup index (they'd be dropped
 * as duplicates in Step 4 regardless, so a detail fetch would be wasted). Same
 * jittered cadence and non-fatal failure handling as enrichListingsWithDetail.
 */
async function enrichSparseListingsBeforeFilter(parser, listings, dedupIndex, siteReport) {
  const requestDelayMs = settings.scraper.requestDelayMs;

  for (const listing of listings) {
    if (!listing.url) continue;
    if (!isMissingFilterCriticalField(listing)) continue;
    if (dedupIndex.urlSet && dedupIndex.urlSet.has(listing.url)) continue;
    try {
      await parser.sleep(requestDelayMs * (0.75 + Math.random() * 1.25));
      const html = await parser.fetchPageSmart(listing.url);
      applyDetailToListing(parser, listing, html);
      siteReport.enrichmentFetched++;
    } catch (err) {
      siteReport.enrichmentFailed++;
      console.warn(`[Scraper] ${parser.name}: pre-filter detail enrichment failed for ${listing.url}: ${err.message}`);
    }
  }
}

/**
 * Merge the search-card blurb with the detail-page description, deduped and
 * capped. The detail text often restates the blurb verbatim, so when it
 * already contains the blurb we keep only the (fuller) detail text.
 */
function combineDescriptions(cardBlurb, detailText) {
  const blurb = String(cardBlurb || '').trim();
  const detail = String(detailText || '').trim();
  if (!detail) return blurb;
  if (!blurb || detail.includes(blurb)) {
    return detail.slice(0, MAX_ENRICHED_DESCRIPTION_CHARS);
  }
  return `${blurb}\n\n${detail}`.slice(0, MAX_ENRICHED_DESCRIPTION_CHARS);
}

module.exports = {
  runScraper,
  selectTargetCounties,
  resolveParserCounties,
  replayFailedWrites,
  processScrapedListings,
  mergeDuplicateIntoExistingRecord,
  mergeDuplicateIntoSessionListing,
  markSessionListingsWritten,
  addAdditionalSource,
  runBotWallRetries,
  resolveBotWallCooldownMinutes,
  detailEnrichmentEnabled,
  enrichListingsWithDetail,
  enrichSparseListingsBeforeFilter,
  applyDetailToListing,
  isMissingFilterCriticalField,
  combineDescriptions,
};
