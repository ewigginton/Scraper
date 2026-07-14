'use strict';

const { spawnSync } = require('child_process');
const fetch = require('node-fetch');

/**
 * Send THE nightly email: scrape + price check + lead review in one message.
 * Prefers authenticated SMTP (see sendMail); falls back to macOS `mail`.
 * Always sends, even on partial failure.
 * Returns { sent } so callers can propagate delivery failure to exit codes.
 */
async function sendScraperEmail(scraperReport, priceCheckReport, reviewReport) {
  const to = process.env.EMAIL_TO;
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const subject = buildScraperSubject(scraperReport, reviewReport);
  const body = buildScraperBody(scraperReport, priceCheckReport, date, reviewReport);

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

function buildScraperSubject(report, reviewReport) {
  const { totals } = report;
  const hasErrors = totals.errors > 0
    || (report.writeErrors && report.writeErrors.length > 0)
    || report.priceCheckError
    || report.reviewError
    || (reviewReport && reviewReport.errors > 0);

  // Standouts are the thing worth opening the email for — surface them in
  // the subject of the consolidated report
  const standoutSuffix = reviewReport && reviewReport.standouts.length > 0
    ? ` — ⭐ ${reviewReport.standouts.length} standout${reviewReport.standouts.length === 1 ? '' : 's'}`
    : '';

  // writeErrors/priceCheckError normally increment totals.errors too, but
  // never render "0 errors" alongside a warning flag
  const errorCount = Math.max(totals.errors || 0, hasErrors ? 1 : 0);
  if (report.dryRun) {
    const prefix = hasErrors ? '⚠️ ' : '';
    return `${prefix}CCL Scraper (dry run) — ${totals.wouldWrite || 0} would write${hasErrors ? ` — ${errorCount} errors` : ''}`;
  }
  if (hasErrors && totals.written === 0) {
    return `⚠️ CCL Scraper — ERRORS — ${errorCount} failures${standoutSuffix}`;
  }
  if (hasErrors) {
    return `⚠️ CCL Scraper — ${totals.written} new leads, ${errorCount} errors${standoutSuffix}`;
  }
  if (totals.written === 0) {
    return `CCL Scraper — No new leads (${totals.duplicates} dupes caught)${standoutSuffix}`;
  }
  return `CCL Scraper — ${totals.written} new leads found${standoutSuffix}`;
}

function buildScraperBody(scraperReport, priceCheckReport, date, reviewReport) {
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
    } else {
      const writeCount = scraperReport.dryRun ? `${stats.wouldWrite || 0} would write` : `${stats.written || 0} new`;
      lines.push(`  ${site}: ${stats.parsed} checked → ${stats.passed} passed → ${writeCount}`);
      if (stats.duplicates > 0) {
        lines.push(`    (${stats.duplicates} duplicates caught)`);
      }
    }
  }
  lines.push('');
  const totalWriteText = scraperReport.dryRun ? `${scraperReport.totals.wouldWrite || 0} would write` : `${scraperReport.totals.written} written`;
  lines.push(`  TOTALS: ${totalWriteText}, ${scraperReport.totals.duplicates} dupes, ${scraperReport.totals.rejected} rejected`);
  lines.push(`  Runtime: ${scraperReport.elapsedMinutes} minutes`);
  lines.push('');

  if (scraperReport.warnings && scraperReport.warnings.length > 0) {
    lines.push('WARNINGS');
    lines.push('-'.repeat(30));
    for (const warning of scraperReport.warnings) {
      lines.push(`  ${warning}`);
    }
    lines.push('');
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

  // Cross-site duplicates caught (summarize)
  const crossSiteDupes = scraperReport.duplicateDetails.filter(
    d => d.matchType === 'fingerprint' || d.matchType === 'session-fingerprint' || d.matchType === 'location-price'
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

  // Site issues
  const siteIssues = Object.entries(scraperReport.sites).filter(
    ([_, s]) => s.status === 'error' || (s.parsed === 0 && s.status === 'ok')
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
  sendMail,
  pingHealthcheck,
};
