'use strict';

// Per-run, per-site health history for the daily scraper health check.
//
// Each nightly run appends ONE JSON line to data/run-history/history.jsonl
// summarizing what every enabled site did that run (status, pages checked,
// records parsed, records that passed the filter, and a tally of the source
// issues recorded by lib/parsers/base-parser.js). scripts/health-check.js
// reads this log to compare a run against the previous seven successful runs
// (see lib/health-check.js), which is the only way to tell an unusually-low
// or zero result apart from a genuinely quiet night.
//
// data/ is gitignored and machine-local, so this history accumulates on the
// host that actually runs the nightly scrape (Nora's Mac). The health check
// degrades gracefully to single-run checks where no history exists yet.
//
// Storage rules mirror lib/local-store.js: tolerate a missing file, skip
// corrupt lines individually, prune on write, and never let a history-write
// failure crash the run. No URLs/PII are stored — issue messages are
// sanitized and issue detail is reduced to a category tally.

const fs = require('fs');
const path = require('path');

const { classifyIssue } = require('./source-diagnosis');
const { getDataDir } = require('./local-store');

// How long a run summary stays in the log. Comfortably past the 7-run window
// the health check compares against, so a few skipped nights still leave real
// history to look back over.
const HISTORY_RETENTION_DAYS = 60;

// The issue categories classifyIssue can return. Kept here so a summary always
// carries a full, zero-filled tally (a missing key would break ratio math in
// the health check).
const ISSUE_CATEGORIES = ['not_found', 'bot_wall', 'drift', 'server_error', 'other_error'];

function historyPath() {
  return path.join(getDataDir(), 'run-history', 'history.jsonl');
}

/**
 * Strip anything URL-like out of an issue message and cap its length. Issue
 * URLs live in a separate field the summary never keeps, but a stray URL can
 * still end up inside err.message — scrub it so the shared history log can
 * never leak a customer-facing link or token (see CLAUDE.md hard lines).
 */
function sanitizeIssueMessage(message) {
  return String(message || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Pull the request count out of a site_abandoned issue's message
 * ("Aborted after 10 error pages ...") — mirrors lib/source-diagnosis.js so a
 * summarized run can still tell the health check where the circuit breaker
 * tripped without carrying the raw issue.
 */
function parseStoppedAfter(errorText) {
  const match = /Aborted after (\d+)/.exec(errorText || '');
  return match ? Number(match[1]) : null;
}

/**
 * Condense one site's report entry (report.sites[name], as built by
 * lib/scraper.js) into the compact, PII-free shape the history log stores.
 */
function summarizeSite(siteReport) {
  const rawIssues = Array.isArray(siteReport.sourceIssues) ? siteReport.sourceIssues : [];

  // site_abandoned is a synthetic circuit-breaker marker, not a failed
  // request — keep it out of the category tally (matches diagnoseSite, which
  // filters it before classifying) but remember that it fired.
  const abandoned = rawIssues.find(issue => issue.type === 'site_abandoned');
  const realIssues = rawIssues.filter(issue => issue.type !== 'site_abandoned');

  const issueCounts = Object.fromEntries(ISSUE_CATEGORIES.map(category => [category, 0]));
  for (const issue of realIssues) {
    const category = classifyIssue(issue);
    if (category in issueCounts) issueCounts[category]++;
  }

  const summary = {
    status: siteReport.status || 'ok',
    checked: numberOr(siteReport.checked, 0),
    parsed: numberOr(siteReport.parsed, 0),
    passed: numberOr(siteReport.passed, 0),
    duplicates: numberOr(siteReport.duplicates, 0),
    rejected: numberOr(siteReport.rejected, 0),
    errors: numberOr(siteReport.errors, 0),
    // Preserve undefined (unknown) vs 0 (no target counties in coverage this
    // run) — the health check treats them differently.
    searchUrlsPlanned: siteReport.searchUrlsPlanned,
    issueCounts,
    issueTotal: realIssues.length,
    // Trimmed, sanitized issues so the health check can reuse diagnoseSite for
    // plain-English wording without the log ever holding a URL.
    issues: realIssues.map(issue => ({ type: issue.type, error: sanitizeIssueMessage(issue.error) })),
  };

  if (siteReport.error) summary.error = sanitizeIssueMessage(siteReport.error);
  if (abandoned) {
    summary.abandoned = true;
    summary.abandonedAfter = parseStoppedAfter(abandoned.error);
  }
  if (siteReport.status === 'retried_after_cooldown') {
    summary.retried = true;
    summary.blockedAgain = Boolean(siteReport.retryPass && siteReport.retryPass.blockedAgain);
    if (typeof siteReport.cooldownMinutes === 'number') summary.cooldownMinutes = siteReport.cooldownMinutes;
  }

  return summary;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Build the single history record for a completed run. Pure — takes the run
 * report and an injected date (mirrors lib/local-store.js's injected-date
 * style so callers and tests are deterministic).
 *
 * @param {object} report - the scraper report (report.sites, report.totals, ...)
 * @param {object} [opts]
 * @param {Date} [opts.date] - the run's date (defaults to now at call sites)
 * @param {boolean} [opts.midday] - midday runs sweep a different county subset,
 *   so the health check compares them only against other midday runs.
 */
function summarizeRun(report, { date = new Date(), midday } = {}) {
  const sites = {};
  for (const [name, siteReport] of Object.entries(report.sites || {})) {
    sites[name] = summarizeSite(siteReport || {});
  }

  return {
    date: date.toISOString().slice(0, 10),
    timestamp: date.toISOString(),
    dryRun: Boolean(report.dryRun),
    midday: Boolean(midday),
    elapsedMinutes: numberOr(report.elapsedMinutes, 0),
    totals: {
      checked: numberOr(report.totals && report.totals.checked, 0),
      parsed: numberOr(report.totals && report.totals.parsed, 0),
      passed: numberOr(report.totals && report.totals.passed, 0),
      written: numberOr(report.totals && report.totals.written, 0),
      wouldWrite: numberOr(report.totals && report.totals.wouldWrite, 0),
      duplicates: numberOr(report.totals && report.totals.duplicates, 0),
      rejected: numberOr(report.totals && report.totals.rejected, 0),
      errors: numberOr(report.totals && report.totals.errors, 0),
    },
    sites,
  };
}

/**
 * Append one run's summary to the history log and prune entries older than
 * HISTORY_RETENTION_DAYS. Returns the file path, or null if nothing was
 * recorded. Never throws — a history-write failure is logged and swallowed so
 * it can never break the nightly run or its email.
 */
function recordRun(report, opts = {}) {
  try {
    const date = opts.date || new Date();
    const record = summarizeRun(report, opts);

    const dir = path.join(getDataDir(), 'run-history');
    fs.mkdirSync(dir, { recursive: true });

    const cutoffMs = date.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const kept = loadRunHistory().filter(entry => {
      const entryDate = new Date(entry.timestamp || entry.date);
      return !Number.isNaN(entryDate.getTime()) && entryDate.getTime() >= cutoffMs;
    });
    kept.push(record);

    const lines = kept.map(entry => JSON.stringify(entry));
    fs.writeFileSync(historyPath(), `${lines.join('\n')}\n`, 'utf8');
    return historyPath();
  } catch (err) {
    console.warn(`[RunHistory] Failed to record run: ${err.message}`);
    return null;
  }
}

/**
 * Load the run-history log oldest-first. Tolerates a missing file (returns [])
 * and corrupt lines (skipped individually with a warning). Optional
 * { limit } keeps only the most recent N entries.
 */
function loadRunHistory({ limit } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(historyPath(), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[RunHistory] Could not read history: ${err.message}`);
    }
    return [];
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.date === 'string' && entry.sites && typeof entry.sites === 'object') {
        entries.push(entry);
      }
    } catch (err) {
      console.warn(`[RunHistory] Skipping corrupt history line: ${err.message}`);
    }
  }

  if (typeof limit === 'number' && limit > 0 && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }
  return entries;
}

module.exports = {
  HISTORY_RETENTION_DAYS,
  ISSUE_CATEGORIES,
  historyPath,
  summarizeSite,
  summarizeRun,
  recordRun,
  loadRunHistory,
  sanitizeIssueMessage,
};
