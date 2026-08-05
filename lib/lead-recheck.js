'use strict';

const airtable = require('./airtable');
const BaseParser = require('./parsers/base-parser');
const browserFetch = require('./browser-fetch');
// Reuses intake's page-extraction — the same availability-phrase detection
// (via lib/availability.js) and acreage extraction that Listing Intake
// already relies on, so a "the page now says under contract" or "the page's
// acreage disagrees" finding is detected identically everywhere it matters.
const { extractListingDetails } = require('./intake');
const { assertPublicUrl } = require('./url-guard');
const { isEmptyAppShellHtml } = require('./block-markers');
const { resolveMinAcres } = require('./scraper');
const { loadLeadRecheckState, saveLeadRecheckState } = require('./local-store');

/**
 * Stages Emma actively triages ('New Lead' — fresh arrivals she hasn't rated
 * yet, 'Emma Review' — leads she flagged for a closer look) — the ONLY
 * stages the nightly recheck reads. Anything else (Watch For Price Drop,
 * Price Drop, Not Interested, Off Market, HOLD, Make Offer?, CCL
 * Negotiation, ...) already carries a human decision and is out of scope.
 */
const RECHECK_STAGES = [airtable.STAGES.newLead, airtable.STAGES.emmaReview];

// A fetch-per-lead recheck through the browser fallback can take 10-30s per
// URL; an unbounded backlog would run for hours inside the nightly job.
// 100/night with oldest-unchecked-first (see orderByOldestUnchecked) drains a
// large backlog steadily across several nights instead of stalling on one.
const MAX_RECHECKS_PER_NIGHT = 100;

// Recorded-vs-live acreage disagreement at/above this relative difference is
// a mismatch worth Emma's attention, independent of the 40-acre-floor
// crossing check below (isAcreageMismatch) — a 200ac record now showing
// 180ac live is a 10% swing that the floor-crossing check alone would miss.
const ACREAGE_MISMATCH_RELATIVE_THRESHOLD = 0.10;

// Politeness gap between fetches (mirrors intake.js's one-off detail-page
// delay) — these hit many different production listing sites one at a time,
// not a single endpoint, but a metronomic zero-delay loop is still an easy
// bot signature. SCRAPER_LEAD_RECHECK_DELAY_MS=0 (set by tests) makes the
// whole loop synchronous-fast; jitter is multiplicative like scrapeAll's own
// requestDelayMs so a 0 base delay stays exactly 0, not "0 to 1000ms".
const DEFAULT_RECHECK_DELAY_MS = 1500;

function resolveRecheckDelayMs() {
  const override = process.env.SCRAPER_LEAD_RECHECK_DELAY_MS;
  if (override !== undefined && override !== '') {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_RECHECK_DELAY_MS;
}

/**
 * Nightly lead recheck: re-fetch each 'New Lead' / 'Emma Review' record's own
 * listing URL (same fetch + browser-fallback path the scraper/intake use) and
 * report — never write — leads that have gone under contract/sold/off-market
 * since they were scraped, and leads whose live acreage no longer matches
 * what's on the record. REPORT ONLY: this never changes Stage or edits any
 * Airtable field (stage policy — only Emma moves records, see
 * test/stage-policy.test.js); the only local write is the JSON "last
 * checked" cache used to pick the oldest-unchecked leads when the nightly cap
 * is hit.
 */
async function runLeadRecheck() {
  const startTime = Date.now();
  const report = {
    totalCandidates: 0,
    checked: 0,
    fetchFailed: 0,
    skippedNoUrl: 0,
    droppedByCap: 0,
    droppedNames: [],
    underContract: [],
    acreageMismatches: [],
    errors: 0,
  };

  console.log('[LeadRecheck] Starting nightly lead recheck...');

  let candidates;
  try {
    candidates = await loadCandidates();
  } catch (err) {
    report.loadError = err.message;
    console.warn(`[LeadRecheck] Could not load candidate records: ${err.message}`);
    report.elapsedMinutes = parseFloat(((Date.now() - startTime) / 1000 / 60).toFixed(1));
    return report;
  }

  report.totalCandidates = candidates.length;
  console.log(`[LeadRecheck] ${candidates.length} lead(s) in New Lead / Emma Review`);

  const state = loadLeadRecheckState();
  const ordered = orderByOldestUnchecked(candidates, state);
  const toCheck = ordered.slice(0, MAX_RECHECKS_PER_NIGHT);
  const dropped = ordered.slice(MAX_RECHECKS_PER_NIGHT);

  report.droppedByCap = dropped.length;
  report.droppedNames = dropped.map(leadName);
  if (dropped.length > 0) {
    console.log(`[LeadRecheck] Cap hit — deferring ${dropped.length} lead(s) to a later night: ${report.droppedNames.slice(0, 10).join(', ')}${dropped.length > 10 ? ', ...' : ''}`);
  }

  const fetcher = new BaseParser('LeadRecheck');
  const minAcres = resolveMinAcres();
  const { FIELDS } = airtable;

  for (const record of toCheck) {
    const url = record.fields[FIELDS.url];
    const name = leadName(record);
    if (!url) {
      report.skippedNoUrl++;
      continue;
    }

    try {
      // These are stored listing URLs, not user-submitted ones, but the same
      // SSRF guard intake.js applies is cheap and keeps every outbound fetch
      // in this codebase behind one gate. SCRAPER_ALLOW_LOOPBACK_FETCH=true
      // bypasses it for tests serving fixtures from 127.0.0.1.
      if (process.env.SCRAPER_ALLOW_LOOPBACK_FETCH !== 'true') {
        await assertPublicUrl(url);
      }
      await fetcher.sleep(resolveRecheckDelayMs() * (0.75 + Math.random() * 1.25));

      let html = await fetcher.fetchPageSmart(url);
      if (fetcher.isBlockedPage(html) && browserFetch.isEnabled()) {
        // Challenge page served with HTTP 200 — one browser attempt.
        html = await fetcher.browserFetch(url);
      }
      if (fetcher.isBlockedPage(html)) {
        throw new Error('Site served a bot-challenge page (even to the browser)');
      }
      const extracted = extractListingDetails(html, url);
      // A content-free HTTP-200 app shell (ordinary title, empty root div,
      // scripts only) yields no signal — "no flags found" on it would
      // misreport the lead as verified-live, so it's a failed fetch like a
      // challenge page. Checked AFTER extraction, and only when extraction
      // found nothing: a short page that plainly says "under contract" (or
      // carries the listing's acreage/price) is informative, not a shell —
      // the untrustworthy thing is the NEGATIVE inference from empty markup.
      const informative = extracted.availabilityFlags.length > 0
        || extracted.acres != null || extracted.price != null;
      if (!informative && isEmptyAppShellHtml(html)) {
        throw new Error('Site served an empty app shell (no rendered content)');
      }
      report.checked++;
      state[record.id] = new Date().toISOString();

      if (extracted.availabilityFlags && extracted.availabilityFlags.length > 0) {
        report.underContract.push({
          name,
          stage: fieldStage(record),
          url,
          phrase: extracted.availabilityFlags[0],
        });
        console.log(`[LeadRecheck] NOW UNAVAILABLE: ${name} — ${extracted.availabilityFlags[0]}`);
      }

      const recordedAcres = record.fields[FIELDS.acres];
      const liveAcres = extracted.acres;
      if (isAcreageMismatch(recordedAcres, liveAcres, minAcres)) {
        report.acreageMismatches.push({ name, recordedAcres, liveAcres, url });
        console.log(`[LeadRecheck] ACREAGE MISMATCH: ${name} — recorded ${recordedAcres}ac, live ${liveAcres}ac`);
      }
    } catch (err) {
      report.fetchFailed++;
      report.errors++;
      // Still mark this record checked-this-run so a persistently-failing
      // fetch doesn't monopolize the front of the oldest-unchecked queue.
      state[record.id] = new Date().toISOString();
      console.warn(`[LeadRecheck] Fetch failed for ${name} (${url}): ${err.message}`);
    }
  }

  try {
    pruneState(state, candidates);
    saveLeadRecheckState(state);
  } catch (err) {
    console.warn(`[LeadRecheck] Could not save recheck state: ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`[LeadRecheck] Done in ${elapsed} minutes: ${report.checked} checked, ${report.underContract.length} now unavailable, ${report.acreageMismatches.length} acreage mismatches, ${report.fetchFailed} fetch failures`);
  report.elapsedMinutes = parseFloat(elapsed);
  return report;
}

/**
 * Every record currently in a recheck-eligible stage, deduped by id (a
 * record can't be in two stages at once, but getRecordsByStage is called
 * once per stage so this guards against any accidental double-count).
 */
async function loadCandidates() {
  const seen = new Set();
  const merged = [];
  for (const stage of RECHECK_STAGES) {
    const records = await airtable.getRecordsByStage(stage);
    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      merged.push(record);
    }
  }
  return merged;
}

/**
 * Oldest-unchecked-first ordering used when the nightly cap is hit: records
 * never seen in state sort first (as if checked at the start of time), then
 * ascending by their last-checked timestamp.
 */
function orderByOldestUnchecked(records, state) {
  return [...records].sort((a, b) => lastCheckedMs(a, state) - lastCheckedMs(b, state));
}

function lastCheckedMs(record, state) {
  const iso = state[record.id];
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity; // never-checked sorts first
}

/**
 * Drop state entries for records no longer in the candidate set (moved to
 * another stage by Emma, deleted, ...) so the local state file stays bounded
 * to the size of the current New Lead / Emma Review backlog.
 */
function pruneState(state, candidates) {
  const validIds = new Set(candidates.map(r => r.id));
  for (const id of Object.keys(state)) {
    if (!validIds.has(id)) delete state[id];
  }
}

/**
 * Recorded vs. live acreage disagreement: either a >=10% relative swing, or
 * the pair crossing the hard 40-acre floor (lib/scraper.js's
 * resolveMinAcres) in opposite directions — a lead recorded at 42ac now
 * genuinely 38ac live matters to Emma's minimum even when the raw percentage
 * swing looks small. No live acreage extracted means "can't verify" — never
 * a mismatch (that case is only visible via the fetchFailed/errors counters).
 */
function isAcreageMismatch(recordedAcres, liveAcres, minAcres) {
  if (!(recordedAcres > 0) || !(liveAcres > 0)) return false;
  const relDiff = Math.abs(recordedAcres - liveAcres) / recordedAcres;
  if (relDiff >= ACREAGE_MISMATCH_RELATIVE_THRESHOLD) return true;
  return (recordedAcres >= minAcres) !== (liveAcres >= minAcres);
}

function leadName(record) {
  return record.fields.Name || record.fields[airtable.FIELDS.propertyName] || record.id;
}

/** Airtable singleSelect values arrive as strings via the SDK; be tolerant of objects. */
function fieldStage(record) {
  const stage = record.fields[airtable.FIELDS.stage];
  return typeof stage === 'object' && stage !== null ? stage.name : stage;
}

module.exports = {
  runLeadRecheck,
  RECHECK_STAGES,
  MAX_RECHECKS_PER_NIGHT,
  ACREAGE_MISMATCH_RELATIVE_THRESHOLD,
  isAcreageMismatch,
  orderByOldestUnchecked,
  resolveRecheckDelayMs,
};
