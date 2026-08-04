'use strict';

require('dotenv').config();

// Daily scraper health check (CLI).
//
// Reviews the most recent recorded run (data/run-history/history.jsonl, written
// by lib/run-history.js at the end of every scrape), classifies each enabled
// source against the previous seven successful runs, and prints the concise
// daily report the health-check playbook expects. Read-only: it never scrapes,
// writes to Airtable, or touches lead data.
//
// Usage:
//   node scripts/health-check.js            # human-readable report
//   node scripts/health-check.js --json     # machine-readable JSON (for the
//                                            # 9 AM automation to parse)
//   node scripts/health-check.js --email    # also email the report to EMAIL_TO
//                                            # (the 9 AM launchd service uses this)
//
// Exit code: 0 when every source is Successful (including a legitimately quiet
// zero-result run); 1 when only soft anomalies exist; 2 when a source is
// Failed / Access restricted / Needs human review — so CI and the daily
// automation can gate on "something needs attention".

const fs = require('fs');
const { loadRunHistory } = require('../lib/run-history');
const { analyzeLatestRun, CATEGORIES, needsAttention } = require('../lib/health-check');
const { sendMail } = require('../lib/notify');

function loadEnabledSites() {
  try {
    const settings = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
    return Object.entries(settings.sites || {})
      .filter(([, cfg]) => cfg && cfg.enabled)
      .map(([name]) => name);
  } catch (err) {
    console.warn(`[HealthCheck] Could not read enabled sites from config: ${err.message}`);
    return [];
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const asEmail = process.argv.includes('--email');
  const history = loadRunHistory();
  const analysis = analyzeLatestRun(history, { sites: loadEnabledSites() });
  const report = renderReport(analysis);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
  } else {
    process.stdout.write(`${report}\n`);
  }

  // Email the report when asked (the 9 AM launchd service runs with --email so
  // Emma gets the daily health check whether or not anything is wrong). Never
  // let a mail failure change the exit code — the printed report already ran.
  if (asEmail) {
    const to = process.env.EMAIL_TO;
    if (!to) {
      console.warn('[HealthCheck] --email set but EMAIL_TO is not configured — skipping email.');
    } else {
      const subject = analysis.runDate === null
        ? 'CCL Scraper Health Check — no run data yet'
        : `CCL Scraper Health Check — ${analysis.overall} (${analysis.runDate})`;
      try {
        await sendMail(to, subject, report);
      } catch (err) {
        console.warn(`[HealthCheck] Could not send health-check email: ${err.message}`);
      }
    }
  }

  if (analysis.runDate === null) {
    // No history yet — nothing to judge. Not an error (a fresh checkout, or a
    // host that has not run the scraper). Exit 0.
    process.exitCode = 0;
    return;
  }

  const attention = analysis.sites.some(s => needsAttention(s.category));
  const anomalies = analysis.sites.some(s => s.category === CATEGORIES.ANOMALOUS);
  process.exitCode = attention ? 2 : (anomalies ? 1 : 0);
}

function renderReport(a) {
  const lines = [];
  lines.push('='.repeat(64));
  lines.push('CCL SCRAPER — DAILY HEALTH CHECK');
  lines.push('='.repeat(64));

  if (a.runDate === null) {
    lines.push('No run history found yet (data/run-history/history.jsonl is empty).');
    lines.push('The check will have data to compare after the next recorded scrape.');
    if (a.missing && a.missing.length) {
      lines.push('');
      lines.push(`Enabled sources awaiting a first recorded run: ${a.missing.join(', ')}`);
    }
    return lines.join('\n');
  }

  const mode = `${a.dryRun ? 'dry-run' : 'live'}${a.midday ? ', midday' : ''}`;
  lines.push(`Run reviewed: ${a.runDate} (${mode})`);
  lines.push(`Baseline: ${a.hasBaseline ? `previous ${a.baselineRuns} comparable run(s)` : 'none yet — single-run checks only'}`);
  lines.push('');
  lines.push(`OVERALL STATUS: ${a.overall}`);
  lines.push('');

  // Per-source status.
  lines.push('PER-SOURCE STATUS');
  lines.push('-'.repeat(64));
  for (const s of sortForReport(a.sites)) {
    lines.push(`${mark(s.category)} ${s.name}`);
    lines.push(`    Status : ${s.category}${s.transient ? ' (transient)' : ''}`);
    lines.push(`    Records: ${s.records} found, ${s.newLeads} passed the filter` +
      (s.baseline && s.baseline.n > 0 ? ` — baseline median ${s.baseline.median} over ${s.baseline.n} runs` : ''));
    if (s.cause) lines.push(`    Note   : ${s.cause}`);
    if (s.recommendedAction) lines.push(`    Action : ${s.recommendedAction}`);
    lines.push('');
  }

  // Records-found roll-up.
  lines.push('RECORDS FOUND BY EACH SOURCE');
  lines.push('-'.repeat(64));
  for (const s of a.sites) lines.push(`    ${s.name.padEnd(20)} ${s.records}`);
  const totalNew = a.totals && (a.totals.written || a.totals.wouldWrite || 0);
  lines.push('');
  lines.push(`NEW DEDUPLICATED LEADS ADDED (run total): ${totalNew}` +
    (a.dryRun ? ' (dry-run — would-write, nothing persisted)' : ''));
  lines.push('');

  // Attention roll-ups the playbook acts on.
  const failed = a.sites.filter(s => s.category === CATEGORIES.FAILED);
  const access = a.sites.filter(s => s.category === CATEGORIES.ACCESS);
  const review = a.sites.filter(s => s.category === CATEGORIES.REVIEW);
  const anomalous = a.sites.filter(s => s.category === CATEGORIES.ANOMALOUS);

  lines.push('ANOMALIES DETECTED');
  lines.push('-'.repeat(64));
  lines.push(anomalous.length ? anomalous.map(s => `    - ${s.name}: ${s.cause}`).join('\n') : '    None.');
  lines.push('');
  lines.push('FAILURES DISCOVERED');
  lines.push('-'.repeat(64));
  lines.push(failed.length ? failed.map(s => `    - ${s.name}: ${s.cause}`).join('\n') : '    None.');
  lines.push('');
  lines.push('ACCESS RESTRICTED (stop & back off)');
  lines.push('-'.repeat(64));
  lines.push(access.length ? access.map(s => `    - ${s.name}: ${s.cause}`).join('\n') : '    None.');
  lines.push('');

  // Human-action queue.
  const needs = [...failed, ...access, ...review];
  lines.push('SOURCES STILL REQUIRING ATTENTION / HUMAN ACTION');
  lines.push('-'.repeat(64));
  if (!needs.length) {
    lines.push('    None — every source is validated or legitimately empty.');
  } else {
    for (const s of needs) lines.push(`    - ${s.name} [${s.category}]: ${s.recommendedAction || s.cause}`);
  }

  return lines.join('\n');
}

const ORDER = [CATEGORIES.FAILED, CATEGORIES.ACCESS, CATEGORIES.REVIEW, CATEGORIES.ANOMALOUS, CATEGORIES.SUCCESS];

function sortForReport(sites) {
  return [...sites].sort((x, y) => ORDER.indexOf(x.category) - ORDER.indexOf(y.category) || x.name.localeCompare(y.name));
}

function mark(category) {
  switch (category) {
    case CATEGORIES.SUCCESS: return '[ OK ]';
    case CATEGORIES.ANOMALOUS: return '[ ?? ]';
    case CATEGORIES.FAILED: return '[FAIL]';
    case CATEGORIES.ACCESS: return '[BLOK]';
    case CATEGORIES.REVIEW: return '[RVW ]';
    default: return '[ -- ]';
  }
}

main().catch(err => {
  console.error(`[HealthCheck] Unexpected error: ${err.message}`);
  process.exit(1);
});
