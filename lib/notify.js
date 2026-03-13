'use strict';

const { execSync } = require('child_process');

/**
 * Send email notification with scrape results.
 * Uses macOS `mail` command. Always sends, even on partial failure.
 */
async function sendScraperEmail(scraperReport, priceCheckReport) {
  const to = process.env.EMAIL_TO;
  if (!to) {
    console.warn('[Notify] No EMAIL_TO configured, skipping email');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const subject = buildScraperSubject(scraperReport);
  const body = buildScraperBody(scraperReport, priceCheckReport, date);

  sendMail(to, subject, body);
}

/**
 * Send email with review results.
 */
async function sendReviewEmail(reviewReport) {
  const to = process.env.EMAIL_TO;
  if (!to) {
    console.warn('[Notify] No EMAIL_TO configured, skipping email');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const subject = buildReviewSubject(reviewReport);
  const body = buildReviewBody(reviewReport, date);

  sendMail(to, subject, body);
}

function buildScraperSubject(report) {
  const { totals } = report;
  if (totals.errors > 0 && totals.written === 0) {
    return `⚠️ CCL Scraper — ERRORS — ${totals.errors} failures`;
  }
  if (totals.written === 0) {
    return `CCL Scraper — No new leads (${totals.duplicates} dupes caught)`;
  }
  return `CCL Scraper — ${totals.written} new leads found`;
}

function buildScraperBody(scraperReport, priceCheckReport, date) {
  const lines = [];
  lines.push(`CCL Land Scraper Report — ${date}`);
  lines.push('='.repeat(50));
  lines.push('');

  // Site breakdown
  lines.push('NEW LISTING SCAN');
  lines.push('-'.repeat(30));
  for (const [site, stats] of Object.entries(scraperReport.sites)) {
    if (stats.status === 'error') {
      lines.push(`  ❌ ${site}: ERROR — ${stats.error}`);
    } else {
      lines.push(`  ${site}: ${stats.parsed} checked → ${stats.passed} passed → ${stats.written || 0} new`);
      if (stats.duplicates > 0) {
        lines.push(`    (${stats.duplicates} duplicates caught)`);
      }
    }
  }
  lines.push('');
  lines.push(`  TOTALS: ${scraperReport.totals.written} written, ${scraperReport.totals.duplicates} dupes, ${scraperReport.totals.rejected} rejected`);
  lines.push(`  Runtime: ${scraperReport.elapsedMinutes} minutes`);
  lines.push('');

  // Price check summary
  if (priceCheckReport) {
    lines.push('PRICE DROP CHECK');
    lines.push('-'.repeat(30));
    lines.push(`  Checked: ${priceCheckReport.checked} watched listings`);
    lines.push(`  Price drops: ${priceCheckReport.priceDrops}`);
    lines.push(`  Promoted to leads: ${priceCheckReport.promoted}`);
    lines.push(`  Expired (90+ days): ${priceCheckReport.expired}`);
    lines.push(`  Removed (404): ${priceCheckReport.removed}`);
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
  }

  // Cross-site duplicates caught (summarize)
  const crossSiteDupes = scraperReport.duplicateDetails.filter(d => d.matchType === 'fingerprint' || d.matchType === 'session-fingerprint');
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
  lines.push(`Reviewed: ${report.reviewed} leads`);
  lines.push(`Standouts: ${report.standouts.length}`);
  lines.push(`Auto-rejected: ${report.autoRejected.length}`);
  lines.push('');

  // Standouts
  if (report.standouts.length > 0) {
    lines.push('⭐ STANDOUT PROPERTIES');
    lines.push('-'.repeat(30));
    for (const s of report.standouts) {
      lines.push(`  ${s.name}`);
      lines.push(`    ${s.county} County, ${s.state} | ${s.acres}ac | $${s.price?.toLocaleString()} ($${Math.round(s.cpa)}/ac)`);
      if (s.positives.length > 0) {
        lines.push(`    ✅ ${s.positives.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Auto-rejects
  if (report.autoRejected.length > 0) {
    lines.push('🚫 AUTO-REJECTED');
    lines.push('-'.repeat(30));
    for (const r of report.autoRejected) {
      lines.push(`  ${r.name}: ${r.reason}`);
    }
    lines.push('');
  }

  // Flagged
  if (report.flagged.length > 0) {
    lines.push('⚠️ FLAGGED (needs review)');
    lines.push('-'.repeat(30));
    for (const f of report.flagged.slice(0, 10)) {
      lines.push(`  ${f.name}: ${f.flags.join(', ')}`);
    }
    if (report.flagged.length > 10) {
      lines.push(`  ... and ${report.flagged.length - 10} more flagged in Airtable`);
    }
  }

  return lines.join('\n');
}

function sendMail(to, subject, body) {
  try {
    // Escape special characters for shell
    const escapedBody = body.replace(/'/g, "'\\''");
    const escapedSubject = subject.replace(/'/g, "'\\''");

    execSync(`echo '${escapedBody}' | mail -s '${escapedSubject}' '${to}'`, {
      timeout: 10000,
    });
    console.log(`[Notify] Email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error(`[Notify] Failed to send email: ${err.message}`);
    // Don't throw — email failure shouldn't crash the pipeline
  }
}

module.exports = { sendScraperEmail, sendReviewEmail };
