'use strict';

/**
 * scripts/run-scraper.sh audits installed launchd/cron jobs on the
 * production Mac against what the repo expects (leftover agents, drifted
 * schedules) and, when it finds something, exports SCRAPER_JOB_AUDIT_WARNING
 * for lib/scraper.js to surface in the nightly report email. This only
 * covers the env-var -> report.warnings wiring; the shell audit logic itself
 * lives in scripts/run-scraper.sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyEnvWarnings } = require('../lib/scraper');

function freshReport() {
  return { warnings: [] };
}

test('SCRAPER_JOB_AUDIT_WARNING set: report warnings include it', () => {
  const original = process.env.SCRAPER_JOB_AUDIT_WARNING;
  process.env.SCRAPER_JOB_AUDIT_WARNING =
    "leftover launchd agent 'com.ccl.old-land-digest.plist'. Run 'bash scripts/setup-production.sh' on this Mac to review and remove leftovers.";
  try {
    const report = freshReport();
    applyEnvWarnings(report);
    assert.ok(
      report.warnings.some(w => w.includes("leftover launchd agent 'com.ccl.old-land-digest.plist'")),
      `expected a job-audit warning, got: ${report.warnings.join(' | ')}`
    );
  } finally {
    if (original === undefined) delete process.env.SCRAPER_JOB_AUDIT_WARNING;
    else process.env.SCRAPER_JOB_AUDIT_WARNING = original;
  }
});

test('SCRAPER_JOB_AUDIT_WARNING unset: report warnings do not mention it', () => {
  const original = process.env.SCRAPER_JOB_AUDIT_WARNING;
  delete process.env.SCRAPER_JOB_AUDIT_WARNING;
  try {
    const report = freshReport();
    applyEnvWarnings(report);
    assert.ok(
      report.warnings.every(w => !w.includes('job audit') && !w.includes('leftover')),
      `expected no job-audit warning, got: ${report.warnings.join(' | ')}`
    );
  } finally {
    if (original === undefined) delete process.env.SCRAPER_JOB_AUDIT_WARNING;
    else process.env.SCRAPER_JOB_AUDIT_WARNING = original;
  }
});
