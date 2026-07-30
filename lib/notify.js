'use strict';

const { spawnSync } = require('child_process');
const fetch = require('node-fetch');
const { diagnoseSite } = require('./source-diagnosis');
const { loadCoverageLog } = require('./local-store');

/**
 * Whether a MIDDAY run is worth an email at all. New leads, write errors, a
 * site the run gave up on (site_abandoned — bot-blocked/aborted), or a
 * crashed site pass are noteworthy; routine dupes/rejects with nothing else
 * notable are not, so the midday run stays quiet (see sendScraperEmail's
 * quiet-if-empty gate). The nightly run is never gated by this — it always
 * sends.
 */
function isMiddayRunNoteworthy(scraperReport) {
  const totals = scraperReport.totals || {};
  if ((totals.written || 0) > 0) return true;
  if ((scraperReport.writeErrors || []).length > 0) return true;
  if ((scraperReport.sourceIssues || []).some(issue => issue.type === 'site_abandoned')) return true;
  if (Object.values(scraperReport.sites || {}).some(site => site.status === 'error')) return true;
  return false;
}

/**
 * Send THE nightly (or midday) email: scrape + price check + lead review in
 * one message. Prefers authenticated SMTP (see sendMail); falls back to macOS
 * `mail`. Always sends, even on partial failure — EXCEPT a midday run
 * (options.midday) with nothing noteworthy, which is skipped entirely.
 * Returns { sent } so callers can propagate delivery failure to exit codes.
 */
async function sendScraperEmail(scraperReport, priceCheckReport, reviewReport, intakeReport, options = {}) {
  const to = process.env.EMAIL_TO;
  const runDate = options.runDate || new Date();
  const date = runDate.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  if (options.midday && !isMiddayRunNoteworthy(scraperReport)) {
    console.log('[Midday] Nothing noteworthy — no email');
    return { sent: false, skipped: true, quiet: true };
  }

  const subject = buildScraperSubject(scraperReport, reviewReport, intakeReport, options);
  const body = buildScraperBody(scraperReport, priceCheckReport, date, reviewReport, intakeReport, { ...options, runDate });

  writeReportFile('scraper', subject, body);
  if (!to) {
    console.warn('[Notify] No EMAIL_TO configured, skipping email');
    return { sent: false, skipped: true };
  }
  const sent = await sendMail(to, subject, body);
  return { sent };
}

/**
 * Send email with review results.
 */
async function sendReviewEmail(reviewReport) {
  const to = process.env.EMAIL_TO;
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const subject = buildReviewSubject(reviewReport);
  const body = buildReviewBody(reviewReport, date);

  writeReportFile('review', subject, body);
  if (!to) {
    console.warn('[Notify] No EMAIL_TO configured, skipping email');
    return { sent: false, skipped: true };
  }
  const sent = await sendMail(to, subject, body);
  return { sent };
}

function buildScraperSubject(report, reviewReport, intakeReport, options = {}) {
  const { totals } = report;
  const hasErrors = totals.errors > 0
    || (report.writeErrors && report.writeErrors.length > 0)
    || report.priceCheckError
    || report.reviewError
    || report.intakeError
    || (reviewReport && reviewReport.errors > 0)
    || (intakeReport && intakeReport.failures.length > 0);

  // Standouts are the thing worth opening the email for — surface them in
  // the subject of the consolidated report
  const standoutSuffix = reviewReport && reviewReport.standouts.length > 0
    ? ` — ⭐ ${reviewReport.standouts.length} standout${reviewReport.standouts.length === 1 ? '' : 's'}`
    : '';

  // Marks the midday (scrape+intake-only) run apart from the nightly one —
  // undefined/false leaves the nightly subject byte-identical to before.
  const middayPrefix = options.midday ? '[Midday] ' : '';

  // writeErrors/priceCheckError normally increment totals.errors too, but
  // never render "0 errors" alongside a warning flag
  const errorCount = Math.max(totals.errors || 0, hasErrors ? 1 : 0);
  if (report.dryRun) {
    const prefix = hasErrors ? '⚠️ ' : '';
    return `${middayPrefix}${prefix}CCL Scraper (dry run) — ${totals.wouldWrite || 0} would write${hasErrors ? ` — ${errorCount} errors` : ''}`;
  }
  if (hasErrors && totals.written === 0) {
    return `${middayPrefix}⚠️ CCL Scraper — ERRORS — ${errorCount} failures${standoutSuffix}`;
  }
  if (hasErrors) {
    return `${middayPrefix}⚠️ CCL Scraper — ${totals.written} new leads, ${errorCount} errors${standoutSuffix}`;
  }
  if (totals.written === 0) {
    return `${middayPrefix}CCL Scraper — No new leads (${totals.duplicates} dupes caught)${standoutSuffix}`;
  }
  return `${middayPrefix}CCL Scraper — ${totals.written} new leads found${standoutSuffix}`;
}

// Trailing window the coverage audit inspects, and how many silent counties
// to list by name before collapsing the rest into "... and N more".
const COVERAGE_AUDIT_WINDOW_DAYS = 7;
const COVERAGE_AUDIT_LIST_LIMIT = 15;

function coverageKey(county, state) {
  return `${String(county).toLowerCase()}|${String(state).toUpperCase()}`;
}

/** Sunday in the LOCAL time of the run's own date (not midday, not UTC). */
function isSundayLocal(date) {
  return date.getDay() === 0;
}

/**
 * "COVERAGE AUDIT (7 days)" section: target counties where NO source has
 * shown a single listing in the trailing 7 days of data/coverage/coverage-log.jsonl
 * (one {date, counties} line appended per run by lib/scraper.js). Reads the
 * log defensively — loadCoverageLog already swallows a missing/corrupt file
 * and returns [] with a console warning, so a bad log can never crash the
 * email; any other unexpected failure is also caught here for the same
 * reason. Returns [] (section omitted) when there is no target-county list to
 * audit against.
 */
function buildCoverageAuditSection(targetCounties, referenceDate) {
  if (!Array.isArray(targetCounties) || targetCounties.length === 0) return [];

  let entries;
  try {
    entries = loadCoverageLog();
  } catch (err) {
    console.warn(`[Notify] Coverage audit skipped — could not read coverage log: ${err.message}`);
    return [];
  }

  const cutoffMs = referenceDate.getTime() - COVERAGE_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const sighted = new Set();
  for (const entry of entries) {
    const entryDate = new Date(entry.date);
    if (Number.isNaN(entryDate.getTime()) || entryDate.getTime() < cutoffMs) continue;
    for (const key of entry.counties || []) sighted.add(key);
  }

  const silent = targetCounties.filter(t => !sighted.has(coverageKey(t.county, t.state)));

  const lines = [];
  lines.push('COVERAGE AUDIT (7 days)');
  lines.push('-'.repeat(30));
  if (silent.length === 0) {
    lines.push(`  Every target county (${targetCounties.length}) was sighted by at least one source in the last 7 days.`);
  } else {
    lines.push(`  ${silent.length} of ${targetCounties.length} target counties with ZERO sightings in the last 7 days:`);
    for (const t of silent.slice(0, COVERAGE_AUDIT_LIST_LIMIT)) {
      lines.push(`    ${t.county}, ${t.state}`);
    }
    if (silent.length > COVERAGE_AUDIT_LIST_LIMIT) {
      lines.push(`    ... and ${silent.length - COVERAGE_AUDIT_LIST_LIMIT} more`);
    }
  }
  lines.push('');
  return lines;
}

function buildScraperBody(scraperReport, priceCheckReport, date, reviewReport, intakeReport, options = {}) {
  const lines = [];
  lines.push(`CCL Land Scraper Report — ${date}`);
  if (scraperReport.dryRun) {
    lines.push('DRY RUN — no Airtable records were created or updated');
  }
  lines.push('='.repeat(50));
  lines.push('');

  // Site breakdown
  lines.push('NEW LISTING SCAN');
  lines.push('-'.repeat(30));
  for (const [site, stats] of Object.entries(scraperReport.sites)) {
    if (stats.status === 'error') {
      lines.push(`  ❌ ${site}: ERROR — ${stats.error}`);
    } else if (stats.searchUrlsPlanned === 0) {
      // This run's target counties fell entirely outside the site's
      // coverage — it was never asked to fetch anything, so "0 checked → 0
      // passed → 0 new" would misleadingly read like a failure.
      lines.push(`  ${site}: no target counties in this source's coverage this run — skipped`);
    } else {
      const writeCount = scraperReport.dryRun ? `${stats.wouldWrite || 0} would write` : `${stats.written || 0} new`;
      lines.push(`  ${site}: ${stats.parsed} checked → ${stats.passed} passed → ${writeCount}`);
      if (stats.rotation) {
        const r = stats.rotation;
        lines.push(`    (county rotation: swept ${r.sweptCount} of ${r.totalCount} counties (group ${r.groupIndex + 1} of ${r.groupsTotal}))`);
      }
      if (stats.status === 'retried_after_cooldown') {
        const outcome = stats.retryPass && stats.retryPass.blockedAgain ? 'blocked again' : 'succeeded';
        lines.push(`    (bot-wall breaker tripped on first pass; retried after ${stats.cooldownMinutes} min cooldown — ${outcome})`);
      }
      if (stats.duplicates > 0) {
        lines.push(`    (${stats.duplicates} duplicates caught)`);
      }
      if (stats.earlyStoppedSeries > 0) {
        lines.push(`    (incremental: stopped ${stats.earlyStoppedSeries} county series early (page of already-known listings))`);
      }
      if (stats.enrichmentFetched > 0 || stats.enrichmentFailed > 0) {
        lines.push(`    (detail pages fetched: ${stats.enrichmentFetched || 0} (${stats.enrichmentFailed || 0} failed))`);
      }
    }
  }
  lines.push('');
  const totalWriteText = scraperReport.dryRun ? `${scraperReport.totals.wouldWrite || 0} would write` : `${scraperReport.totals.written} written`;
  let totalsLine = `  TOTALS: ${totalWriteText}, ${scraperReport.totals.duplicates} dupes, ${scraperReport.totals.rejected} rejected`;
  // sourceMerges is absent on report shapes predating cross-site source
  // merging (fallback shells built in index.js) — never render it then.
  const totalSourceMerges = scraperReport.totals.sourceMerges || 0;
  if (totalSourceMerges > 0) {
    const mergeWord = scraperReport.dryRun ? 'would merge' : 'merged';
    totalsLine += ` (${totalSourceMerges} source${totalSourceMerges === 1 ? '' : 's'} ${mergeWord})`;
  }
  lines.push(totalsLine);
  lines.push(`  Runtime: ${scraperReport.elapsedMinutes} minutes`);
  if (process.env.SCRAPER_GIT_COMMIT) {
    lines.push(`  Code version: ${process.env.SCRAPER_GIT_COMMIT}`);
  }
  lines.push('');

  if (scraperReport.warnings && scraperReport.warnings.length > 0) {
    lines.push('WARNINGS');
    lines.push('-'.repeat(30));
    for (const warning of scraperReport.warnings) {
      lines.push(`  ${warning}`);
    }
    lines.push('');
  }

  // Weekly coverage audit — Sunday-only (local time of the run date), and
  // never on a midday run (a midday run is a light scrape+intake sweep, not
  // the run this weekly signal is meant to ride along with).
  if (!options.midday && options.runDate && isSundayLocal(options.runDate)) {
    try {
      lines.push(...buildCoverageAuditSection(scraperReport.targetCounties, options.runDate));
    } catch (err) {
      console.warn(`[Notify] Coverage audit section failed: ${err.message}`);
    }
  }

  // Price check summary
  if (priceCheckReport) {
    lines.push('PRICE DROP CHECK');
    lines.push('-'.repeat(30));
    lines.push(`  Checked: ${priceCheckReport.checked} watched listings`);
    lines.push(`  Price drops: ${priceCheckReport.priceDrops}`);
    lines.push(`  Promoted to leads: ${priceCheckReport.promoted}`);
    lines.push(`  Expired (90+ days): ${priceCheckReport.expired}`);
    lines.push(`  Removed (404): ${priceCheckReport.removed}`);
    if (priceCheckReport.errors > 0) {
      lines.push(`  ⚠️ Errors: ${priceCheckReport.errors}`);
    }
    lines.push(`  Runtime: ${priceCheckReport.elapsedMinutes} minutes`);
    lines.push('');

    // Price drop promotions
    if (priceCheckReport.details.length > 0) {
      const promoted = priceCheckReport.details.filter(d => d.action === 'promoted');
      if (promoted.length > 0) {
        lines.push('  ⬆️ PROMOTED TO LEADS:');
        for (const p of promoted) {
          lines.push(`    ${p.name}: $${p.oldPrice?.toLocaleString()} → $${p.newPrice?.toLocaleString()} ($${p.newCPA}/ac vs $${p.target}/ac target)`);
        }
        lines.push('');
      }
    }
  } else if (scraperReport.priceCheckError) {
    // The scrape ran but the price checker crashed — say so loudly instead of
    // silently omitting the section
    lines.push('⚠️ PRICE DROP CHECK: FAILED');
    lines.push('-'.repeat(30));
    lines.push(`  ${scraperReport.priceCheckError}`);
    lines.push('  Watched listings were NOT checked, expired, or promoted this run.');
    lines.push('');
  }

  // Listing Intake (team form submissions) — runs as part of the nightly job
  if (intakeReport && (intakeReport.processed > 0 || intakeReport.loadError)) {
    lines.push('LISTING INTAKE (team form submissions)');
    lines.push('-'.repeat(30));
    if (intakeReport.loadError) {
      lines.push(`  ⚠️ Intake skipped this run: ${intakeReport.loadError}`);
    } else {
      lines.push(`  Processed: ${intakeReport.processed} | Added: ${intakeReport.created} | Duplicates: ${intakeReport.duplicates}`);
      // sourceMerges is absent on report shapes predating cross-site source
      // merging — guard so a legacy/queued report never throws or renders 0.
      const intakeSourceMerges = intakeReport.sourceMerges || 0;
      if (intakeSourceMerges > 0) {
        lines.push(`  🔗 ${intakeSourceMerges} duplicate${intakeSourceMerges === 1 ? '' : 's'} merged into an existing lead as an additional source`);
      }
      if (intakeReport.reclaimed > 0) {
        lines.push(`  ⚠️ ${intakeReport.reclaimed} of these had been failed by the OLD intake importer, which is`);
        lines.push(`     still installed on this Mac. Run 'bash scripts/setup-production.sh' to remove it`);
        lines.push(`     — until then it will keep grabbing daytime submissions with no bot-block handling.`);
      }
      for (const a of intakeReport.added) {
        lines.push(`  ✅ ${a.url} (${a.submitter})`);
        lines.push(`     ${a.summary}`);
      }
      const retrying = intakeReport.failures.filter(f => !f.final);
      const givenUp = intakeReport.failures.filter(f => f.final);
      if (retrying.length > 0) {
        lines.push(`  ⚠️ FAILED — WILL RETRY AUTOMATICALLY TOMORROW NIGHT (${retrying.length}):`);
        for (const f of retrying) {
          lines.push(`     ${f.url} (${f.submitter})`);
          lines.push(`       ${f.error}`);
        }
      }
      if (givenUp.length > 0) {
        lines.push(`  ❌ FAILED ON RETRY — GIVEN UP (${givenUp.length}):`);
        for (const f of givenUp) {
          lines.push(`     ${f.url} (${f.submitter})`);
          lines.push(`       ${f.error}`);
        }
        lines.push(`     Set the record's Status back to 'New' in the Listing Intake table to try again.`);
      }
    }
    lines.push('');
  } else if (scraperReport.intakeError) {
    lines.push('⚠️ LISTING INTAKE: FAILED');
    lines.push('-'.repeat(30));
    lines.push(`  ${scraperReport.intakeError}`);
    lines.push('  Team-submitted URLs were NOT imported this run.');
    lines.push('');
  }

  // Lead review summary (runs as part of the nightly job — one email)
  if (reviewReport) {
    lines.push('LEAD REVIEW');
    lines.push('-'.repeat(30));
    lines.push(...buildReviewSection(reviewReport));
  } else if (scraperReport.reviewError) {
    lines.push('⚠️ LEAD REVIEW: FAILED');
    lines.push('-'.repeat(30));
    lines.push(`  ${scraperReport.reviewError}`);
    lines.push('  New leads and price drops were NOT analyzed this run.');
    lines.push('');
  }

  // Cross-site sources merged into an existing record — a merged duplicate is
  // rendered here instead of the plain CROSS-SITE DUPLICATES CAUGHT section
  // below (mergeDetails is absent on report shapes predating source merging,
  // e.g. index.js's fallback report shells and stale queued reports).
  const mergeDetails = scraperReport.mergeDetails || [];
  if (mergeDetails.length > 0) {
    lines.push('CROSS-SITE SOURCES MERGED');
    lines.push('-'.repeat(30));
    for (const d of mergeDetails.slice(0, 20)) {
      const target = (d.mergedInto && (d.mergedInto.source || d.mergedInto.name)) || 'record';
      const description = d.dryRun
        ? `source+link would merge into existing ${target} lead`
        : `source+link added to existing ${target} lead`;
      lines.push(`  ${d.source}: ${d.name} — ${description}`);
    }
    if (mergeDetails.length > 20) {
      lines.push(`  ... and ${mergeDetails.length - 20} more`);
    }
    lines.push('');
  }

  // Cross-site duplicates caught (summarize) — merged entries are excluded,
  // they're already shown above in CROSS-SITE SOURCES MERGED.
  const mergedUrls = new Set(mergeDetails.map(d => d.url).filter(Boolean));
  const crossSiteDupes = scraperReport.duplicateDetails.filter(
    d => (d.matchType === 'fingerprint' || d.matchType === 'session-fingerprint' || d.matchType === 'location-price')
      && !mergedUrls.has(d.url)
  );
  if (crossSiteDupes.length > 0) {
    lines.push('CROSS-SITE DUPLICATES CAUGHT');
    lines.push('-'.repeat(30));
    for (const d of crossSiteDupes.slice(0, 20)) {
      lines.push(`  ${d.source}: ${d.name} — ${d.reason}`);
    }
    if (crossSiteDupes.length > 20) {
      lines.push(`  ... and ${crossSiteDupes.length - 20} more`);
    }
    lines.push('');
  }

  // Errors
  if (scraperReport.writeErrors.length > 0) {
    lines.push('⚠️ WRITE ERRORS');
    lines.push('-'.repeat(30));
    for (const e of scraperReport.writeErrors) {
      lines.push(`  ${e.site}: ${e.error}`);
      if (e.savedTo) {
        lines.push(`    Queued locally — will be replayed automatically on the next run: ${e.savedTo}`);
      }
    }
    lines.push('');
  }

  // SITE DIAGNOSIS — plain-English "what's the issue" per failing site,
  // computed deterministically from the recorded source issues (see
  // lib/source-diagnosis.js; no AI, no network). Rendered ABOVE the raw
  // SOURCE HEALTH ISSUES evidence below so the owner reads the verdict
  // before the wall of per-URL receipts that back it up.
  const siteDiagnoses = Object.entries(scraperReport.sites)
    .map(([site, siteStats]) => {
      const siteSourceIssues = (scraperReport.sourceIssues || []).filter(issue => issue.source === site);
      const diagnosis = diagnoseSite(site, siteStats, siteSourceIssues);
      return diagnosis ? { site, ...diagnosis } : null;
    })
    .filter(Boolean);
  if (siteDiagnoses.length > 0) {
    lines.push('SITE DIAGNOSIS');
    lines.push('-'.repeat(30));
    for (const d of siteDiagnoses) {
      const emoji = d.severity === 'action_needed' ? '🔧' : '⏳';
      lines.push(`  ${emoji} ${d.site}: ${d.headline}`);
    }
    lines.push('');
  }

  if (scraperReport.sourceIssues && scraperReport.sourceIssues.length > 0) {
    lines.push('SOURCE HEALTH ISSUES');
    lines.push('-'.repeat(30));
    const blocked = scraperReport.sourceIssues.filter(i => i.type === 'blocked');
    const drift = scraperReport.sourceIssues.filter(i => i.type === 'markup_drift');
    if (blocked.length > 0) {
      lines.push(`  🚫 ${blocked.length} page(s) served a bot-block/challenge page`);
    }
    if (drift.length > 0) {
      lines.push(`  🔧 ${drift.length} page(s) look like changed markup (0 listings parsed on a live page)`);
    }
    for (const issue of scraperReport.sourceIssues.slice(0, 20)) {
      const location = [issue.county, issue.state].filter(Boolean).join(', ');
      lines.push(`  ${issue.source}: ${issue.error || issue.type}${location ? ` (${location})` : ''}`);
      if (issue.url) {
        lines.push(`    URL: ${issue.url}`);
      }
      if (issue.savedTo) {
        lines.push(`    Evidence saved locally: ${issue.savedTo}`);
      }
    }
    if (scraperReport.sourceIssues.length > 20) {
      lines.push(`  ... and ${scraperReport.sourceIssues.length - 20} more`);
    }
    lines.push('');
  }

  // Site issues. A site whose searchUrlsPlanned is exactly 0 had no target
  // counties in its coverage this run (never asked to fetch anything) —
  // excluded here so it doesn't false-alarm as "Zero results — may be
  // blocked or down". searchUrlsPlanned is undefined for reports predating
  // this field, so undefined never suppresses a real zero-results alarm.
  const siteIssues = Object.entries(scraperReport.sites).filter(
    ([_, s]) => s.status === 'error' || (s.parsed === 0 && s.status === 'ok' && s.searchUrlsPlanned !== 0)
  );
  if (siteIssues.length > 0) {
    lines.push('⚠️ SITE ISSUES');
    lines.push('-'.repeat(30));
    for (const [site, stats] of siteIssues) {
      if (stats.status === 'error') {
        lines.push(`  ${site}: Crashed — ${stats.error}`);
      } else {
        lines.push(`  ${site}: Zero results — may be blocked or down`);
      }
    }
  }

  return lines.join('\n');
}

function buildReviewSubject(report) {
  if (report.errors > 0) {
    return `⚠️ CCL Review — ${report.reviewed} reviewed, ${report.errors} errors`;
  }
  if (report.standouts.length > 0) {
    return `⭐ CCL Review — ${report.standouts.length} standout leads`;
  }
  return `CCL Review — ${report.reviewed} leads analyzed`;
}

function buildReviewBody(report, date) {
  const lines = [];
  lines.push(`CCL Lead Review Report — ${date}`);
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(...buildReviewSection(report));

  return lines.join('\n');
}

/**
 * Review summary lines, shared between the standalone review email and the
 * LEAD REVIEW section of the consolidated nightly email.
 */
function buildReviewSection(report) {
  const lines = [];
  lines.push(`  Reviewed: ${report.reviewed} leads`);
  lines.push(`  Standouts: ${report.standouts.length}`);
  lines.push(`  Auto-rejected: ${report.autoRejected.length}`);
  if (report.floodChecked > 0) {
    lines.push(`  FEMA flood checks: ${report.floodChecked} (${report.floodHighRisk} high risk)`);
  }
  if (report.errors > 0) {
    lines.push(`  ⚠️ Errors: ${report.errors} leads could not be reviewed/updated`);
  }
  lines.push('');

  // Standouts
  if (report.standouts.length > 0) {
    lines.push('  ⭐ STANDOUT PROPERTIES');
    for (const s of report.standouts) {
      lines.push(`    ${s.name}`);
      lines.push(`      ${s.county} County, ${s.state} | ${s.acres}ac | $${s.price?.toLocaleString()} ($${Math.round(s.cpa)}/ac)`);
      if (s.positives.length > 0) {
        lines.push(`      ✅ ${s.positives.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Auto-rejects
  if (report.autoRejected.length > 0) {
    lines.push('  🚫 AUTO-REJECTED');
    for (const r of report.autoRejected) {
      lines.push(`    ${r.name}: ${r.reason}`);
    }
    lines.push('');
  }

  // Flagged
  if (report.flagged.length > 0) {
    lines.push('  ⚠️ FLAGGED (needs review)');
    for (const f of report.flagged.slice(0, 10)) {
      lines.push(`    ${f.name}: ${f.flags.join(', ')}`);
    }
    if (report.flagged.length > 10) {
      lines.push(`    ... and ${report.flagged.length - 10} more flagged in Airtable`);
    }
    lines.push('');
  }

  // Leads parked in Airtable waiting on a human decision — with their age,
  // so a week-old "New Lead" doesn't read like a brand-new find every night
  if (report.awaiting && report.awaiting.length > 0) {
    lines.push(`  ⏳ WAITING ON YOU IN AIRTABLE (${report.awaiting.length})`);
    for (const w of report.awaiting.slice(0, 15)) {
      const where = [w.county && `${w.county} County`, w.state].filter(Boolean).join(', ');
      const facts = [where, w.acres && `${w.acres}ac`, w.price && `$${w.price.toLocaleString()}`]
        .filter(Boolean).join(' | ');
      const age = w.ageDays !== null && w.ageDays !== undefined ? `waiting ${w.ageDays} day${w.ageDays === 1 ? '' : 's'}` : 'age unknown';
      const stage = typeof w.stage === 'object' && w.stage !== null ? w.stage.name : w.stage;
      lines.push(`    ${w.name} — ${facts} — ${age}${stage ? ` (${stage})` : ''}`);
    }
    if (report.awaiting.length > 15) {
      lines.push(`    ... and ${report.awaiting.length - 15} more`);
    }
    lines.push('    (Move a record to another Stage in Airtable to clear it from this list.)');
    lines.push('');
  }

  return lines;
}

/**
 * Send mail, preferring authenticated SMTP (set SMTP_HOST/SMTP_USER/SMTP_PASS
 * in .env). The macOS `mail` fallback hands the message to local postfix,
 * which on a stock machine has no relay configured — it exits 0 while the
 * message rots in the local queue. SMTP is the only path with confirmed
 * delivery, so configure it.
 * Returns true only when the send is confirmed handed to a real relay.
 */
async function sendMail(to, subject, body) {
  if (process.env.SMTP_HOST) {
    return sendMailSmtp(to, subject, body);
  }
  console.warn('[Notify] SMTP not configured (SMTP_HOST missing) — falling back to local `mail`, delivery is NOT guaranteed');
  return sendMailLocal(to, subject, body);
}

async function sendMailSmtp(to, subject, body) {
  try {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: body,
      // base64 keeps report URLs intact — quoted-printable transfer encoding
      // was getting mis-decoded downstream ("?minAcreage=40" rendered as
      // "?minAcreage@" in the received email)
      textEncoding: 'base64',
    });
    console.log(`[Notify] Email sent via SMTP to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[Notify] SMTP send failed: ${err.message}`);
    return false;
  }
}

function sendMailLocal(to, subject, body) {
  try {
    const result = spawnSync('mail', ['-s', subject, to], {
      input: body,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr || `mail exited with status ${result.status}`);
    }
    console.log(`[Notify] Email handed to local mail for ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[Notify] Failed to send email: ${err.message}`);
    return false;
  }
}

/**
 * Ping a dead-man's-switch monitor (e.g. healthchecks.io) so a run that
 * never happens — machine asleep, launchd unloaded, lock deadlock — raises
 * an alert by absence. No-op when HEALTHCHECK_URL is not configured.
 */
async function pingHealthcheck(success) {
  const url = process.env.HEALTHCHECK_URL;
  if (!url) return;
  let target = url;
  if (!success) {
    try {
      // Append /fail to the path, not the raw string — a URL with query
      // params would otherwise get "/fail" inside the query and be recorded
      // as a SUCCESS ping by healthchecks.io
      const parsed = new URL(url);
      parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/fail`;
      target = parsed.toString();
    } catch (_) {
      target = `${url.replace(/\/$/, '')}/fail`;
    }
  }
  try {
    await fetch(target, { method: 'GET', timeout: 10000 });
    console.log(`[Notify] Healthcheck ping sent (${success ? 'success' : 'fail'})`);
  } catch (err) {
    console.error(`[Notify] Healthcheck ping failed: ${err.message}`);
  }
}

function writeReportFile(kind, subject, body) {
  const filePath = process.env.SCRAPER_REPORT_FILE;
  if (!filePath) return;

  try {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `Subject: ${subject}\n\n${body}\n`, 'utf8');
    console.log(`[Notify] ${kind} report written to ${filePath}`);
  } catch (err) {
    console.error(`[Notify] Failed to write report file: ${err.message}`);
  }
}

module.exports = {
  sendScraperEmail,
  sendReviewEmail,
  buildScraperBody,
  buildReviewBody,
  buildScraperSubject,
  buildReviewSubject,
  buildCoverageAuditSection,
  isMiddayRunNoteworthy,
  sendMail,
  pingHealthcheck,
};
