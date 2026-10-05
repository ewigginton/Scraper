'use strict';

const airtable = require('./airtable');
const BaseParser = require('./parsers/base-parser');
const browserFetch = require('./browser-fetch');
// The same subject-listing reader Listing Intake uses (per-site rules, never
// a nearby-listings widget or a filter menu), so "the page now says under
// contract" and "the page's acreage disagrees" are read identically
// everywhere they matter.
const { readListingSubject } = require('./listing-subject');
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

// Site-change guard for HTTP 404/410 ("listing removed"). One host answering
// most of a night's rechecks with 404/410 is far more likely a URL-scheme
// change on that site (LandWatch's 2026 redesign moved every listing URL)
// than a wave of real removals. When MORE than this share of one host's
// rechecks — and at least SITE_CHANGE_MIN_GONE of them — come back 404/410,
// they are reported as fetch failures with a "site may have changed its URLs"
// warning, never as removals.
const SITE_CHANGE_GONE_SHARE = 0.5;
const SITE_CHANGE_MIN_GONE = 3;

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
    // Pages fetched fine but the listing could not be read (also counted in
    // fetchFailed, so the email's "could not verify" line includes them).
    unreadable: [],
    // A known site's listing was read but its own status is not shown (e.g.
    // a LANDFLIP page with no JSON-LD availability, a LandWatch page without
    // the status word). Not "live": also counted in fetchFailed ("could not
    // verify") and excluded from checked, so the email never calls them
    // live. Acreage is still compared. Unknown sites (source 'generic') keep
    // the old rule: no unavailable phrase in the subject-scoped text = live.
    statusUnknown: [],
    // HTTP 404/410: the site says the listing page no longer exists. Its own
    // list (not underContract) so the email shows it under its own heading.
    // Each: { name, stage, url, httpStatus, phrase }.
    removed: [],
    // Hosts whose 404/410s tripped the site-change guard (see
    // SITE_CHANGE_GONE_SHARE). Those 404/410s are counted in fetchFailed and
    // NOT listed in removed. Each: { host, gone, rechecked, message }.
    siteChangeWarnings: [],
    // The same warnings as one line for the email (null when none).
    siteChangeWarning: null,
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
  // Per-host tallies for the site-change guard: every recheck attempted on a
  // host, and its 404/410 answers (held until the loop ends).
  const recheckedByHost = new Map();
  const goneByHost = new Map();

  for (const record of toCheck) {
    const url = record.fields[FIELDS.url];
    const name = leadName(record);
    if (!url) {
      report.skippedNoUrl++;
      continue;
    }
    const host = hostOf(url);
    recheckedByHost.set(host, (recheckedByHost.get(host) || 0) + 1);

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
      const subject = readListingSubject(html, url);
      if (!subject.ok) {
        // Never "all clear" on a page we could not read: an error shell, an
        // empty app shell, or a layout whose listing block was not found is
        // counted as a failed check, not a live lead.
        const why = isEmptyAppShellHtml(html)
          ? 'Site served an empty app shell (no rendered content)'
          : `Could not read the listing on the page (${subject.note || 'listing block not found'})`;
        report.unreadable.push({ name, url, note: why });
        throw new Error(why);
      }
      state[record.id] = new Date().toISOString();
      if (subject.statusKind === null && subject.source !== 'generic') {
        report.statusUnknown.push({ name, url, note: subject.note || 'listing status not shown on the page' });
        report.fetchFailed++;
        console.log(`[LeadRecheck] STATUS UNKNOWN: ${name} — ${subject.note || 'listing status not shown on the page'}`);
      } else {
        report.checked++;
      }

      if (subject.unavailable) {
        report.underContract.push({
          name,
          stage: fieldStage(record),
          url,
          phrase: subject.status,
          statusKind: subject.statusKind,
        });
        console.log(`[LeadRecheck] NOW UNAVAILABLE: ${name} — ${subject.status}`);
      }

      const recordedAcres = record.fields[FIELDS.acres];
      const liveAcres = subject.acres;
      if (isAcreageMismatch(recordedAcres, liveAcres, minAcres)) {
        report.acreageMismatches.push({ name, recordedAcres, liveAcres, url });
        console.log(`[LeadRecheck] ACREAGE MISMATCH: ${name} — recorded ${recordedAcres}ac, live ${liveAcres}ac`);
      }
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        // The site says the listing page no longer exists. Held per host
        // until every recheck has run: the site-change guard below decides
        // whether these are removals or a URL-scheme change. Plain fetch does
        // not retry 404/410, so this adds no requests.
        state[record.id] = new Date().toISOString();
        if (!goneByHost.has(host)) goneByHost.set(host, []);
        goneByHost.get(host).push({
          name,
          stage: fieldStage(record),
          url,
          httpStatus: err.status,
          phrase: `listing removed (HTTP ${err.status})`,
        });
        continue;
      }
      report.fetchFailed++;
      report.errors++;
      // Still mark this record checked-this-run so a persistently-failing
      // fetch doesn't monopolize the front of the oldest-unchecked queue.
      state[record.id] = new Date().toISOString();
      console.warn(`[LeadRecheck] Fetch failed for ${name} (${url}): ${err.message}`);
    }
  }

  applyGoneResults(report, goneByHost, recheckedByHost);

  try {
    pruneState(state, candidates);
    saveLeadRecheckState(state);
  } catch (err) {
    console.warn(`[LeadRecheck] Could not save recheck state: ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`[LeadRecheck] Done in ${elapsed} minutes: ${report.checked} checked, ${report.underContract.length} now unavailable, ${report.removed.length} removed, ${report.acreageMismatches.length} acreage mismatches, ${report.fetchFailed} fetch failures`);
  report.elapsedMinutes = parseFloat(elapsed);
  return report;
}

/**
 * Sorts the night's HTTP 404/410 answers into report.removed, or — for a host
 * where more than SITE_CHANGE_GONE_SHARE of its rechecks (and at least
 * SITE_CHANGE_MIN_GONE) came back 404/410 — into fetch failures plus one
 * report.siteChangeWarnings entry: that pattern means the site probably
 * changed its listing URLs, and calling every lead on it "removed" would be
 * wrong data.
 */
function applyGoneResults(report, goneByHost, recheckedByHost) {
  for (const [host, gone] of goneByHost) {
    const rechecked = recheckedByHost.get(host) || gone.length;
    if (isLikelySiteChange(gone.length, rechecked)) {
      report.fetchFailed += gone.length;
      report.errors += gone.length;
      const message = `${host}: ${gone.length} of ${rechecked} rechecked listing URLs returned "not found" (HTTP 404/410) — the site may have changed its URLs; these were not counted as removed listings`;
      report.siteChangeWarnings.push({ host, gone: gone.length, rechecked, message });
      console.warn(`[LeadRecheck] SITE MAY HAVE CHANGED ITS URLS: ${message}`);
      continue;
    }
    for (const entry of gone) {
      report.checked++;
      report.removed.push(entry);
      console.log(`[LeadRecheck] LISTING REMOVED: ${entry.name} — HTTP ${entry.httpStatus}`);
    }
  }
  report.siteChangeWarning = report.siteChangeWarnings.length > 0
    ? report.siteChangeWarnings.map(w => w.message).join('; ')
    : null;
}

function isLikelySiteChange(goneCount, recheckedCount) {
  return goneCount >= SITE_CHANGE_MIN_GONE && goneCount / recheckedCount > SITE_CHANGE_GONE_SHARE;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return String(url);
  }
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
  isLikelySiteChange,
  orderByOldestUnchecked,
  resolveRecheckDelayMs,
};
