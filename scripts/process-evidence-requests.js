#!/usr/bin/env node
'use strict';

// Load .env FIRST so SCRAPER_BROWSER_* tuning applies to the capture. This
// script is a standalone process invoked by run-scraper.sh, which does not
// export these vars and does not source .env — without this, the browser
// fallback here always ran headless, so headless-detected CoStar walls
// (LandWatch's Imperva) hard-403'd every night and never captured, while
// unprotected sites captured fine. SCRAPER_BROWSER_HEADED=true in the Mac's
// .env now actually reaches the capture.
require('dotenv').config();

/**
 * Nightly evidence capture — closes the parser-evidence loop without a human.
 *
 * The assistant cannot fetch land sites (the cloud sandbox is blocked), so it
 * queues URLs in config/evidence-requests.json on main. This script runs on the
 * production Mac AFTER the nightly scrape (scripts/run-scraper.sh), fetches each
 * pending URL through the same browser fallback the scraper uses, and pushes the
 * captured HTML to the disposable `evidence-inbox` branch for the assistant to
 * pull. Every step is idempotent and every failure is non-fatal — this must
 * never delay or fail lead generation.
 *
 * Manual run: node scripts/process-evidence-requests.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const browserFetch = require('../lib/browser-fetch');
const evidence = require('../lib/evidence-capture');
const settings = require('../config/settings.json');

const REPO_DIR = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_DIR, 'data', 'evidence');
const REQUESTS_FILE = path.join(REPO_DIR, 'config', 'evidence-requests.json');
const EVIDENCE_BRANCH = 'evidence-inbox';
const GIT_REMOTE = 'origin';

// Reuse the scraper's request delay so evidence capture is as polite as a
// normal scrape (env override matches lib/parsers/base-parser.js).
function requestDelayMs() {
  const fromEnv = Number(process.env.SCRAPER_REQUEST_DELAY_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : settings.scraper.requestDelayMs;
}

function readRequestUrls() {
  let raw;
  try {
    raw = fs.readFileSync(REQUESTS_FILE, 'utf8');
  } catch (_) {
    return []; // Missing file → nothing to do.
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.urls) ? parsed.urls : [];
  } catch (err) {
    console.error(`Ignoring malformed ${path.basename(REQUESTS_FILE)}: ${err.message}`);
    return [];
  }
}

// Fetch one URL through the real browser. A challenge/block page whose HTML the
// fetch layer returns (e.g. an unresolved HTTP-200 wall) is saved as evidence;
// a thrown fetch (HTTP-4xx wall, timeout) propagates and is logged per-URL by
// the orchestrator, non-fatally.
function makeCaptureUrl() {
  return (url) => browserFetch.fetchPageWithBrowser(url);
}

// Commit captured files to `evidence-inbox` and force-push, WITHOUT disturbing
// the launchd checkout (which is on main and must stay there). A throwaway
// worktree gets its own branch reset from the current main, so main's working
// tree and HEAD are never touched. evidence-inbox is a disposable inbox, so a
// force-push overwriting last night's inbox is correct. Every git op is wrapped;
// any failure (no creds, offline) logs and returns false — non-fatal.
function gitPushEvidence(capturedFileNames) {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-inbox-'));
  const git = (args, cwd) => execFileSync('git', args, {
    cwd: cwd || REPO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Hard ceiling so a stalled worktree/commit/push (hung credential helper,
    // unreachable remote) can never block indefinitely even when this runs
    // outside the shell wrapper's perl-alarm timeout. execFileSync raises on
    // timeout and gitPushEvidence's try/catch makes that non-fatal.
    timeout: 120000,
  });

  let worktreeAdded = false;
  try {
    // Branch reset from local main into an isolated worktree.
    git(['worktree', 'add', '-f', '-B', EVIDENCE_BRANCH, worktreeDir, 'main']);
    worktreeAdded = true;

    // Copy the freshly captured files into the worktree. data/evidence is
    // gitignored, so `git add -f` (below) is required to stage them.
    const destDir = path.join(worktreeDir, 'data', 'evidence');
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of capturedFileNames) {
      fs.copyFileSync(path.join(EVIDENCE_DIR, name), path.join(destDir, name));
    }

    git(['add', '-f', 'data/evidence'], worktreeDir);
    // Identity supplied inline — launchd may run without global git config.
    git([
      '-c', 'user.name=CCL Evidence Bot',
      '-c', 'user.email=evidence-bot@classiccountryland.com',
      'commit', '-m', `Evidence capture ${new Date().toISOString()} (${capturedFileNames.length} file(s))`,
    ], worktreeDir);
    git(['push', '-f', GIT_REMOTE, EVIDENCE_BRANCH], worktreeDir);
    return true;
  } catch (err) {
    console.error(`Evidence git push failed: ${String(err && err.message || err).split('\n')[0]}`);
    return false;
  } finally {
    if (worktreeAdded) {
      try {
        git(['worktree', 'remove', '--force', worktreeDir]);
      } catch (_) { /* best-effort cleanup */ }
    }
    // Ensure the temp dir is gone even if worktree removal failed.
    try {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

async function main() {
  const urls = readRequestUrls();
  if (urls.length === 0) {
    return; // Silent no-op when nothing is queued.
  }

  if (!browserFetch.isEnabled()) {
    // No browser here (e.g. CI, or SCRAPER_BROWSER_FALLBACK=false) — nothing
    // can be captured. Non-fatal.
    const why = browserFetch.reasonUnavailable() || 'browser fallback disabled (SCRAPER_BROWSER_FALLBACK=false)';
    console.error(`Evidence capture skipped: ${why}`);
    return;
  }

  const result = await evidence.processEvidenceRequests({
    urls,
    evidenceDir: EVIDENCE_DIR,
    captureUrl: makeCaptureUrl(),
    gitPushEvidence,
    delayMs: requestDelayMs(),
  });

  console.log(
    `Evidence: captured ${result.captured}, skipped ${result.skipped}` +
    (result.failed ? `, failed ${result.failed}` : '') +
    `, pushed ${result.pushed ? 'yes' : 'no'}`,
  );
}

main()
  .catch((err) => {
    // Whole-run failure is still non-fatal (the nightly wrapper also guards
    // this step) — log and exit 0 so evidence never fails the night's run.
    console.error(`Evidence capture error: ${err && err.stack || err}`);
  })
  .finally(async () => {
    await browserFetch.closeBrowser();
    process.exit(0);
  });
