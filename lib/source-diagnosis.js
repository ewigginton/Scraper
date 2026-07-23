'use strict';

// Deterministic "what went wrong" classifier for one site's scraper run.
// Reads only what lib/parsers/base-parser.js already records this run
// (source issues + stats) and lib/scraper.js already assembles onto
// report.sites — no AI, no network calls, so it's cheap enough to run on
// every consolidated email. Pure function: never mutates its inputs.

// HTTP statuses a bot-wall serves to refuse a request outright (mirrors
// lib/browser-fetch.js isBotWallStatus) — 503 is included because
// Akamai/Imperva commonly use it for rate-limit refusals, not real outages.
const BOT_WALL_STATUSES = new Set([400, 403, 429, 503]);

// Share of a site's counted issues one failure category must reach before we
// call it "the" cause rather than noise. Below this, the mix is too murky
// for a confident deterministic headline — an honest "no diagnosis" beats a
// guess (see CLAUDE.md: never invent numbers / fabricate a diagnosis).
const DOMINANCE_THRESHOLD = 0.6;

/**
 * Diagnose one site's run in plain English for the owner.
 *
 * @param {string} siteName - unused in the classification itself (issues are
 *   already scoped to this site by the caller) but kept in the signature so
 *   callers/tests can pass it straight through without a wrapper closure.
 * @param {object} siteReport - report.sites[siteName], as built by
 *   lib/scraper.js (processScrapedListings / the crash branch / the
 *   post-cooldown retry branch).
 * @param {object[]} sourceIssues - this site's recorded issues (source ===
 *   siteName), covering both the first pass and any post-cooldown retry.
 * @returns {{severity: 'action_needed'|'transient', headline: string}|null}
 *   null when the run has nothing noteworthy to report: a healthy site, too
 *   mixed a signal to classify with confidence, or a site whose target
 *   counties fell entirely outside its coverage this run (searchUrlsPlanned
 *   === 0 and no issues recorded — it was never asked to fetch anything).
 */
function diagnoseSite(siteName, siteReport, sourceIssues) {
  // A crash already gets its own "Crashed — <error>" line elsewhere in the
  // email (buildScraperBody's SITE ISSUES section) — don't duplicate it here
  // with a guessed cause.
  if (!siteReport || siteReport.status === 'error') return null;

  const issues = (sourceIssues || []).filter(issue => issue.type !== 'site_abandoned');
  const abandonedIssue = (sourceIssues || []).find(issue => issue.type === 'site_abandoned');
  const stoppedAfter = abandonedIssue ? parseStoppedAfter(abandonedIssue.error) : null;

  // 0. Zero search URLs planned this run — this run's target counties fall
  // entirely outside the site's coverage (e.g. a two-Missouri-county dry run
  // against an AL/GA/MS/TN/FL-only source), so the site was never asked to
  // fetch anything. Nothing to diagnose. searchUrlsPlanned is undefined for
  // reports predating this field (a stale queued/replayed report) — treat
  // undefined as "unknown" and fall through to the existing behavior rather
  // than suppress a possibly-real alarm; only an explicit 0 short-circuits.
  if (siteReport.searchUrlsPlanned === 0 && (sourceIssues || []).length === 0) {
    return null;
  }

  const parsed = typeof siteReport.parsed === 'number' ? siteReport.parsed : 0;
  const checked = typeof siteReport.checked === 'number' ? siteReport.checked : 0;
  // Best-effort total request count: successful fetches (checked) plus every
  // recorded issue. Real (not synthetic site_abandoned) issues each
  // correspond to one failed request.
  const totalRequests = checked + issues.length;

  const counts = tallyByCategory(issues);
  const dominant = dominantCategory(counts, issues.length);

  // 1. 404 storm — the classic "site changed its URL structure" signature.
  if (dominant && dominant.category === 'not_found' && dominant.ratio >= DOMINANCE_THRESHOLD) {
    const fraction = describeFraction(dominant.count, totalRequests, 'request');
    const stopSuffix = stoppedAfter !== null ? ` — stopped after ${stoppedAfter} requests` : '';
    return {
      severity: 'action_needed',
      headline: `${fraction} returned HTTP 404 — the site likely changed its URL structure; the parser needs updating${stopSuffix}`,
    };
  }

  // 2. Bot wall — 400/403/429/503 or a detected challenge page dominate.
  if (dominant && dominant.category === 'bot_wall' && dominant.ratio >= DOMINANCE_THRESHOLD) {
    const fraction = describeFraction(dominant.count, totalRequests, 'request');
    const retrySuffix = describeRetry(siteReport);
    return {
      severity: 'transient',
      headline: `bot defense is blocking the scraper — ${fraction} blocked${retrySuffix}`,
    };
  }

  // 3. Markup drift — pages fetch fine but selectors match nothing. This is
  // a strong enough signal on its own that it doesn't need to "dominate";
  // any recorded drift page means the parser needs a look.
  if (counts.drift > 0) {
    const fraction = describeFraction(counts.drift, totalRequests, 'page');
    return {
      severity: 'action_needed',
      headline: `pages load but no listings were recognized — the site likely redesigned its markup; selectors need updating (${fraction})`,
    };
  }

  // 4. Timeouts / 5xx dominate — the site itself, not the scraper, is sick.
  if (dominant && dominant.category === 'server_error' && dominant.ratio >= DOMINANCE_THRESHOLD) {
    const fraction = describeFraction(dominant.count, totalRequests, 'request');
    return {
      severity: 'transient',
      headline: `the site appears to be down or unstable (${fraction} timed out or errored)`,
    };
  }

  // 5. Zero results with no clear cause in the recorded issues — keep the
  // same "may be blocked or down" flavor the SITE ISSUES section has always
  // used, so the wording stays familiar even though it now lives up top.
  if (parsed === 0) {
    return {
      severity: 'transient',
      headline: '0 listings parsed this run — may be blocked or down',
    };
  }

  // Site produced listings and no failure category dominates — a few
  // scattered issues in an otherwise-working run aren't noteworthy.
  return null;
}

/**
 * Bucket one source issue into a failure category for dominance counting.
 */
function classifyIssue(issue) {
  if (issue.type === 'blocked') return 'bot_wall';
  if (issue.type === 'markup_drift') return 'drift';
  if (issue.type !== 'fetch_or_parse_error') return 'other_error';

  const statusMatch = /HTTP (\d{3})/.exec(issue.error || '');
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 404) return 'not_found';
  if (status !== null && BOT_WALL_STATUSES.has(status)) return 'bot_wall';
  if (status !== null && status >= 500) return 'server_error';
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network/i.test(issue.error || '')) return 'server_error';
  return 'other_error';
}

function tallyByCategory(issues) {
  const counts = { not_found: 0, bot_wall: 0, drift: 0, server_error: 0, other_error: 0 };
  for (const issue of issues) {
    counts[classifyIssue(issue)]++;
  }
  return counts;
}

/**
 * The category with the most issues, and its share of all counted issues.
 * null when there are no issues to classify.
 */
function dominantCategory(counts, issueTotal) {
  if (issueTotal === 0) return null;
  let best = null;
  for (const [category, count] of Object.entries(counts)) {
    if (count === 0) continue;
    if (!best || count > best.count) best = { category, count };
  }
  if (!best) return null;
  return { category: best.category, count: best.count, ratio: best.count / issueTotal };
}

/**
 * "every request" when count fills the whole total, else "N of M requests"
 * (singular unit when total is exactly 1).
 */
function describeFraction(count, total, unit) {
  if (total > 0 && count === total) return `every ${unit}`;
  const label = total === 1 ? unit : `${unit}s`;
  return `${count} of ${total} ${label}`;
}

/**
 * Pull the request count out of a site_abandoned issue's message
 * ("Aborted after 10 error pages ..." / "Aborted after 5 blocked pages ...")
 * rather than re-deriving it — the circuit breaker in base-parser.js already
 * knows the exact count that tripped it.
 */
function parseStoppedAfter(errorText) {
  const match = /Aborted after (\d+)/.exec(errorText || '');
  return match ? Number(match[1]) : null;
}

/**
 * Mention the post-cooldown retry outcome for a bot-wall diagnosis — the
 * owner's first question after "bot defense is blocking us" is always
 * "did the automatic retry get through?".
 */
function describeRetry(siteReport) {
  if (siteReport.status !== 'retried_after_cooldown') return '';
  const retryPass = siteReport.retryPass || {};
  const cooldownMinutes = siteReport.cooldownMinutes;
  if (retryPass.blockedAgain) {
    return `; retried after a ${cooldownMinutes}-minute cooldown but was blocked again`;
  }
  return `; retried after a ${cooldownMinutes}-minute cooldown and got through (${retryPass.parsed || 0} found)`;
}

module.exports = { diagnoseSite };
