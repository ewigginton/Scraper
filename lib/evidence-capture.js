'use strict';

/**
 * Shared helpers for the evidence-capture pipeline.
 *
 * Parser work needs rendered HTML that only the production Mac (residential IP
 * + headed Chrome) can fetch — every land site blocks the cloud sandbox where
 * the assistant runs. The assistant queues URLs in config/evidence-requests.json
 * on main; the nightly run (scripts/process-evidence-requests.js) captures them
 * after the scrape and pushes the HTML to a disposable branch.
 *
 * The pure parts live here so they are unit-testable and shared with the manual
 * capture-evidence.js script without duplication:
 *   - shortHash / evidenceFileName : deterministic, content-addressed naming
 *   - computePendingUrls           : idempotent skip-already-captured logic
 *   - processEvidenceRequests      : orchestration with injected capture/git,
 *                                    so tests never touch a browser or real git
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Short, stable content-address of a request URL. Embedding it in the evidence
// filename is what makes the nightly capture idempotent: the same URL always
// maps to the same filename, so an already-captured file is detected and
// skipped — a captured URL costs nothing (no fetch, no hit on the source)
// until it is removed or changed in the request file.
function shortHash(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 8);
}

// Host + path slug, shared with capture-evidence.js so both scripts name files
// the same way. No timestamp here — the hash carries uniqueness/idempotency.
function slugForUrl(url) {
  const { hostname, pathname } = new URL(url);
  const slug = pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'index';
  return `${hostname}-${slug}`;
}

// Deterministic evidence filename for a request URL: <host>-<slug>-<hash8>.html
// Stable across runs for the same URL (that stability is what test (e) pins).
function evidenceFileName(url) {
  return `${slugForUrl(url)}-${shortHash(url)}.html`;
}

// URLs whose evidence file is not already present. `existingFileNames` is the
// list of filenames currently in the evidence dir. Duplicate URLs within the
// request list collapse to a single capture.
function computePendingUrls(urls, existingFileNames) {
  const present = new Set(existingFileNames);
  const pending = [];
  const seen = new Set();
  for (const url of urls) {
    const name = evidenceFileName(url);
    if (present.has(name) || seen.has(name)) continue;
    seen.add(name);
    pending.push(url);
  }
  return pending;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrate a capture run. Side effects (browser fetch, git push) are
 * injected so this is exercised in tests with fakes and never launches a
 * browser or runs real git.
 *
 * deps:
 *   urls            request URLs (from config/evidence-requests.json)
 *   evidenceDir     directory to read existing files from / write new ones to
 *   captureUrl      async (url) => html string; may throw (non-fatal per URL)
 *   gitPushEvidence async (capturedFileNames[]) => pushed:boolean; only called
 *                   when at least one new file was captured
 *   delayMs         polite pause between fetches (default 0)
 *   sleep           injectable delay (default real setTimeout)
 *   logger          console-like (default console)
 *
 * Returns { captured, skipped, failed, pushed, capturedFiles }.
 */
async function processEvidenceRequests(deps) {
  const {
    urls = [],
    evidenceDir,
    captureUrl,
    gitPushEvidence,
    delayMs = 0,
    sleep = defaultSleep,
    logger = console,
  } = deps;

  // Empty/missing "urls" → no work, no output noise.
  if (!Array.isArray(urls) || urls.length === 0) {
    return { captured: 0, skipped: 0, failed: 0, pushed: false, capturedFiles: [] };
  }

  fs.mkdirSync(evidenceDir, { recursive: true });
  const existing = fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.html'));
  const pending = computePendingUrls(urls, existing);

  // Distinct request count minus what still needs capturing = already-captured.
  const distinct = new Set(urls.map(evidenceFileName)).size;
  const skipped = distinct - pending.length;

  const capturedFiles = [];
  let failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const url = pending[i];
    try {
      const html = await captureUrl(url);
      const name = evidenceFileName(url);
      fs.writeFileSync(path.join(evidenceDir, name), html);
      capturedFiles.push(name);
      logger.log(`Captured ${html.length} bytes → ${name}`);
    } catch (err) {
      // Non-fatal: a hard fetch failure just gets logged so the remaining URLs
      // (and the push of whatever did succeed) still proceed. Challenge/block
      // pages whose HTML the fetch layer *returns* are saved above as evidence;
      // only a thrown fetch (e.g. HTTP 4xx wall) lands here.
      failed++;
      logger.error(`FAILED ${url}: ${String(err && err.message || err).split('\n')[0]}`);
    }
    if (delayMs && i < pending.length - 1) {
      await sleep(delayMs);
    }
  }

  let pushed = false;
  if (capturedFiles.length > 0 && typeof gitPushEvidence === 'function') {
    try {
      pushed = Boolean(await gitPushEvidence(capturedFiles));
    } catch (err) {
      // Push failures (no creds, offline) are non-fatal — the files remain on
      // disk and next night's run will re-attempt the push.
      logger.error(`Evidence push failed: ${String(err && err.message || err).split('\n')[0]}`);
    }
  }

  return { captured: capturedFiles.length, skipped, failed, pushed, capturedFiles };
}

module.exports = {
  shortHash,
  slugForUrl,
  evidenceFileName,
  computePendingUrls,
  processEvidenceRequests,
};
