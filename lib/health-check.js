'use strict';

// Daily scraper health-check classifier.
//
// Given the most recent run summary (lib/run-history.js) and the runs before
// it, mark each enabled site with exactly one of the five states the daily
// health-check playbook acts on:
//
//   Successful               — finished cleanly, results in the normal range
//                              (including a legitimately quiet zero-result run)
//   Successful but anomalous — finished, but something is off worth a look
//                              (unusually low volume, a transient wobble)
//   Failed                   — the job crashed, or its parser is broken
//                              (404 storm / markup drift) and needs a repair
//   Access restricted        — a bot wall / CAPTCHA / access-denied is
//                              blocking the scraper; STOP and back off
//   Needs human review       — a stark, unexplained change (e.g. a source
//                              that reliably returns results went to zero)
//
// The "what went wrong" wording reuses lib/source-diagnosis.js's diagnoseSite
// so the health check and the nightly email agree on causes. The trend logic
// (zero / unusually-low vs the previous seven successful runs) lives here —
// it is the piece diagnoseSite cannot do from a single run.

const { diagnoseSite } = require('./source-diagnosis');

const CATEGORIES = {
  SUCCESS: 'Successful',
  ANOMALOUS: 'Successful but anomalous',
  FAILED: 'Failed',
  ACCESS: 'Access restricted',
  REVIEW: 'Needs human review',
};

// Share of a site's issues one category must reach before it is treated as
// "the" cause — same bar diagnoseSite uses, so the two never disagree.
const DOMINANCE_THRESHOLD = 0.6;

// How many prior successful runs form the comparison baseline.
const BASELINE_RUNS = 7;

// A run is "unusually low" when it falls below this fraction of the baseline
// median. Only applied once the baseline is high enough (BASELINE_FLOOR) that
// a dip is meaningful rather than the normal night-to-night jitter of a source
// that only ever finds a listing or two.
const LOW_RESULT_FRACTION = 0.3;
const BASELINE_FLOOR = 4;

// A zero-result run only escalates to "Needs human review" (rather than a
// softer anomaly) when the recent baseline was reliably this high — i.e. a
// source that clearly had inventory suddenly has none.
const ZERO_REVIEW_MEDIAN = 3;

/**
 * Classify one site's most recent run.
 *
 * @param {string} name - site key (e.g. 'landflip')
 * @param {object} site - this run's summary (lib/run-history summarizeSite shape)
 * @param {object[]} priorSuccessful - that site's summaries from prior runs
 *   where it finished successfully, oldest-first, already limited to the
 *   baseline window. Empty when there is no history yet.
 * @returns {object} { name, category, transient, records, newLeads, cause,
 *   recommendedAction, baseline }
 */
function classifySite(name, site, priorSuccessful = []) {
  const parsed = numberOr(site.parsed, 0);
  const passed = numberOr(site.passed, 0);
  const issueTotal = numberOr(site.issueTotal, 0);
  const counts = site.issueCounts || {};
  const baseline = trailingStats(priorSuccessful.map(s => numberOr(s.parsed, 0)));

  const base = { name, records: parsed, newLeads: passed, baseline };

  // 0. This run's target counties fell entirely outside the site's coverage,
  // so it was never asked to fetch anything. Not a health signal.
  if (site.searchUrlsPlanned === 0 && issueTotal === 0) {
    return { ...base, category: CATEGORIES.SUCCESS, transient: false,
      cause: 'No target counties in this source’s coverage this run — nothing to fetch.',
      recommendedAction: null };
  }

  // 1. Hard crash — the job did not finish.
  if (site.status === 'error') {
    return { ...base, category: CATEGORIES.FAILED, transient: false,
      cause: `Job crashed before finishing${site.error ? `: ${site.error}` : '.'}`,
      recommendedAction: 'Inspect the run logs and the failing parser; smallest source-specific repair.' };
  }

  // 2. There are recorded error signals — let diagnoseSite name the cause and
  // decide the category from which failure dominates. Only consult it when
  // issues exist; a clean run with zero results is a trend question (step 3),
  // not a diagnosis question.
  if (issueTotal > 0) {
    const diagnosed = diagnoseFromSummary(name, site);
    const botWallShare = share(counts.bot_wall, issueTotal);
    const notFoundShare = share(counts.not_found, issueTotal);
    const serverShare = share(counts.server_error, issueTotal);
    const driftCount = numberOr(counts.drift, 0);

    // 2a. Bot wall / CAPTCHA / access-denied dominates → access restricted.
    if (botWallShare >= DOMINANCE_THRESHOLD) {
      // A post-cooldown retry that got through is a wobble, not a wall.
      if (site.retried && !site.blockedAgain && parsed > 0) {
        return { ...base, category: CATEGORIES.ANOMALOUS, transient: true,
          cause: diagnosed || 'Blocked on the first pass but the automatic retry got through.',
          recommendedAction: 'No change needed; keep watching in case the blocking becomes persistent.' };
      }
      return { ...base, category: CATEGORIES.ACCESS, transient: true,
        cause: diagnosed || 'Bot defense is blocking the scraper.',
        recommendedAction: 'STOP requests to this source and back off (see the runbook stop conditions). Do not keep retrying; escalate if it persists.' };
    }

    // 2b. 404 storm or markup drift → the parser is broken and needs a repair.
    if (notFoundShare >= DOMINANCE_THRESHOLD || driftCount > 0) {
      return { ...base, category: CATEGORIES.FAILED, transient: false,
        cause: diagnosed || 'Pages loaded but no listings were recognized — the parser likely needs updating.',
        recommendedAction: 'Inspect the saved snapshot and the parser selectors; make the smallest source-specific fix, then a 1–3 page live re-test.' };
    }

    // 2c. Server errors / timeouts dominate → the site itself is unstable.
    if (serverShare >= DOMINANCE_THRESHOLD) {
      if (parsed > 0) {
        return { ...base, category: CATEGORIES.ANOMALOUS, transient: true,
          cause: diagnosed || 'The site was slow or erroring but still returned some results.',
          recommendedAction: 'Transient/external. Retry with backoff; no code change unless it persists.' };
      }
      return { ...base, category: CATEGORIES.FAILED, transient: true,
        cause: diagnosed || 'The site appears to be down or unstable (requests timed out or errored).',
        recommendedAction: 'Transient/external — do not change code. Re-run the source later with backoff; escalate if down for multiple runs.' };
    }
    // Otherwise the issues are scattered with no dominant cause — fall through
    // to the trend check, which judges the run by its result volume.
  }

  // 3. No dominant failure — judge by result volume against the baseline.
  if (parsed === 0) {
    if (baseline.n === 0) {
      return { ...base, category: CATEGORIES.SUCCESS, transient: false,
        cause: 'Zero records, but pages fetched cleanly and there is no baseline yet to compare against — plausibly no new listings.',
        recommendedAction: 'None yet; the next few runs will establish a baseline. Watch for a repeat.' };
    }
    if (baseline.median === 0) {
      return { ...base, category: CATEGORIES.SUCCESS, transient: false,
        cause: `Zero records — consistent with recent runs (median ${baseline.median} over the last ${baseline.n}). This source is often quiet.`,
        recommendedAction: null };
    }
    // Recent runs found listings; today found none and nothing explains it.
    const stark = baseline.median >= ZERO_REVIEW_MEDIAN;
    return { ...base, category: stark ? CATEGORIES.REVIEW : CATEGORIES.ANOMALOUS, transient: false,
      cause: `Zero records this run, but the last ${baseline.n} successful runs returned a median of ${baseline.median} (max ${baseline.max}). A silent block or a markup change is possible.`,
      recommendedAction: 'Compare a freshly-saved page to a known-good snapshot and run a 1–3 page live test before concluding it is genuinely empty.' };
  }

  // 4. Non-zero but well below the recent norm.
  if (baseline.n >= 3 && baseline.median >= BASELINE_FLOOR && parsed < LOW_RESULT_FRACTION * baseline.median) {
    return { ...base, category: CATEGORIES.ANOMALOUS, transient: false,
      cause: `${parsed} records is well below the recent median of ${baseline.median} (last ${baseline.n} runs). Worth a look for partial breakage.`,
      recommendedAction: 'Spot-check that required fields are populated and no pages were quietly blocked; a small live re-test if unsure.' };
  }

  // 5. Healthy.
  const trend = baseline.n > 0 ? ` (recent median ${baseline.median})` : '';
  return { ...base, category: CATEGORIES.SUCCESS, transient: false,
    cause: `${parsed} records, ${passed} passed the filter${trend}. Within the normal range.`,
    recommendedAction: null };
}

/**
 * Reconstruct just enough of a scraper siteReport for diagnoseSite from a
 * stored summary, then return its headline (or null). Keeps the summary log
 * compact while still reusing the one shared cause-classifier.
 */
function diagnoseFromSummary(name, site) {
  const sourceIssues = (site.issues || []).map(issue => ({ ...issue, source: name }));
  if (site.abandoned) {
    sourceIssues.push({ source: name, type: 'site_abandoned', error: `Aborted after ${numberOr(site.abandonedAfter, 0)} pages` });
  }
  const siteReport = {
    status: site.retried ? 'retried_after_cooldown' : (site.status || 'ok'),
    searchUrlsPlanned: site.searchUrlsPlanned,
    parsed: numberOr(site.parsed, 0),
    checked: numberOr(site.checked, 0),
    cooldownMinutes: site.cooldownMinutes,
    retryPass: { parsed: numberOr(site.parsed, 0), blockedAgain: Boolean(site.blockedAgain) },
  };
  const diagnosis = diagnoseSite(name, siteReport, sourceIssues);
  return diagnosis ? diagnosis.headline : null;
}

/**
 * Run the health check over a whole history log.
 *
 * @param {object[]} history - run summaries oldest-first (loadRunHistory shape)
 * @param {object} [opts]
 * @param {string[]} [opts.sites] - restrict/complete the site list (e.g. the
 *   set of currently-enabled parsers) so a site that produced no report entry
 *   this run still surfaces as "Needs human review" rather than vanishing.
 * @returns {object} { runDate, hasBaseline, sites: [...], overall,
 *   counts: {category: n} }
 */
function analyzeLatestRun(history, opts = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { runDate: null, hasBaseline: false, sites: [], overall: 'No run history found',
      counts: {}, missing: opts.sites || [] };
  }

  const latest = history[history.length - 1];
  // Compare like-with-like: same run mode (dry-run vs live) and same daypart
  // (midday runs sweep a different county subset than the 2 AM full run).
  const prior = history.slice(0, history.length - 1).filter(run =>
    Boolean(run.dryRun) === Boolean(latest.dryRun) && Boolean(run.midday) === Boolean(latest.midday));

  const requested = opts.sites && opts.sites.length ? opts.sites : Object.keys(latest.sites || {});
  const seen = new Set();
  const results = [];

  for (const name of requested) {
    seen.add(name);
    const site = latest.sites[name];
    if (!site) {
      results.push({ name, category: CATEGORIES.REVIEW, transient: false, records: 0, newLeads: 0,
        baseline: trailingStats([]),
        cause: 'Enabled source produced no entry in the most recent run — it may not have started.',
        recommendedAction: 'Confirm the run reached this source; check the launch logs and run lock.' });
      continue;
    }
    const priorSuccessful = collectPriorSuccessful(prior, name);
    results.push(classifySite(name, site, priorSuccessful));
  }

  // Any site the latest run reported that the caller did not ask about.
  for (const [name, site] of Object.entries(latest.sites || {})) {
    if (seen.has(name)) continue;
    const priorSuccessful = collectPriorSuccessful(prior, name);
    results.push(classifySite(name, site, priorSuccessful));
  }

  const counts = {};
  for (const category of Object.values(CATEGORIES)) counts[category] = 0;
  for (const r of results) counts[r.category] = (counts[r.category] || 0) + 1;

  return {
    runDate: latest.date,
    dryRun: Boolean(latest.dryRun),
    midday: Boolean(latest.midday),
    hasBaseline: prior.length > 0,
    baselineRuns: prior.length,
    totals: latest.totals || {},
    sites: results,
    counts,
    overall: overallStatus(counts),
  };
}

/**
 * That site's summaries from prior runs where it finished successfully (status
 * 'ok' or a retry that got through), oldest-first, limited to the baseline
 * window. "Successful" for baseline purposes means the run actually reflects
 * this source's normal inventory — a crashed or blocked prior run tells us
 * nothing about the expected result volume.
 */
function collectPriorSuccessful(priorRuns, name) {
  const summaries = [];
  for (const run of priorRuns) {
    const site = run.sites && run.sites[name];
    if (!site) continue;
    const ok = (site.status === 'ok' || site.status === 'retried_after_cooldown')
      && !(site.blockedAgain)
      && numberOr(site.issueTotal, 0) === 0;
    if (ok) summaries.push(site);
  }
  return summaries.slice(-BASELINE_RUNS);
}

function overallStatus(counts) {
  if (counts[CATEGORIES.FAILED] > 0) return 'Action needed — one or more sources failed';
  if (counts[CATEGORIES.ACCESS] > 0) return 'Attention — a source is access-restricted';
  if (counts[CATEGORIES.REVIEW] > 0) return 'Attention — a source needs human review';
  if (counts[CATEGORIES.ANOMALOUS] > 0) return 'Anomalies detected — all sources ran, some look off';
  return 'All sources healthy';
}

/**
 * Median / max / min / count over a list of numbers. Empty list → n: 0.
 */
function trailingStats(values) {
  const nums = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return { n: 0, median: 0, max: 0, min: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
  return { n: nums.length, median, max: sorted[sorted.length - 1], min: sorted[0] };
}

function share(count, total) {
  return total > 0 ? numberOr(count, 0) / total : 0;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * True when a site's category means the daily automation should act (repair,
 * back off, or escalate) rather than just note it.
 */
function needsAttention(category) {
  return category === CATEGORIES.FAILED
    || category === CATEGORIES.ACCESS
    || category === CATEGORIES.REVIEW;
}

module.exports = {
  CATEGORIES,
  DOMINANCE_THRESHOLD,
  BASELINE_RUNS,
  classifySite,
  analyzeLatestRun,
  trailingStats,
  needsAttention,
};
