'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'data');

function loadLocalCountyTargets() {
  const configPath = path.join(ROOT_DIR, 'config', 'acquisition_counties.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const counties = (parsed.counties || [])
    .filter(c => c.county && c.state && Number(c.maxCPA) > 0)
    .map(c => ({
      county: String(c.county).trim(),
      state: String(c.state).trim().toUpperCase(),
      maxCPA: Number(c.maxCPA),
    }));

  const countyMap = new Map();
  for (const c of counties) {
    countyMap.set(`${c.county.toLowerCase()}|${c.state.toUpperCase()}`, c.maxCPA);
  }

  return {
    counties,
    countyMap,
    source: 'local-config',
    meta: parsed.meta || {},
  };
}

function persistFailedListings(listings, context = {}) {
  if (!Array.isArray(listings) || listings.length === 0) {
    return null;
  }

  const dir = path.join(getDataDir(), 'failed-writes');
  fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  // fileTag keeps replay re-failures in a separate file from the one being
  // replayed — appending them to today's file while today's file is itself
  // being replayed would archive them along with it, losing them forever
  const fileName = context.fileTag ? `${date}-${context.fileTag}.jsonl` : `${date}.jsonl`;
  const filePath = path.join(dir, fileName);
  const savedAt = new Date().toISOString();

  const lines = listings.map(listing => JSON.stringify({
    savedAt,
    context,
    listing,
  }));

  fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

/**
 * Load all pending failed-write files for replay.
 * Returns [{ filePath, listings }] — corrupt lines are skipped with a warning
 * so one bad line can't block the rest of the queue.
 */
function loadPendingFailedWrites() {
  const dir = path.join(getDataDir(), 'failed-writes');
  if (!fs.existsSync(dir)) return [];

  const pending = [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  for (const file of files) {
    const filePath = path.join(dir, file);
    const listings = [];
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.listing) listings.push(entry.listing);
      } catch (err) {
        console.warn(`[LocalStore] Skipping corrupt line in ${file}: ${err.message}`);
      }
    }
    pending.push({ filePath, listings });
  }
  return pending;
}

/**
 * Move a replayed failed-write file into failed-writes/done/ so it is never
 * replayed twice. Any listings that fail again during replay are re-persisted
 * to today's file by writeListings, so archiving is always safe.
 */
function archiveFailedWrites(filePath) {
  const doneDir = path.join(getDataDir(), 'failed-writes', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  // Unique archive name — replaying the same-dated file twice in one day
  // must not clobber the earlier archive's audit trail
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(doneDir, `${stamp}-${path.basename(filePath)}`);
  fs.renameSync(filePath, target);
  return target;
}

function persistSourceIssue(issue = {}) {
  const dir = path.join(getDataDir(), 'source-health');
  fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dir, `${date}.jsonl`);
  const savedAt = new Date().toISOString();

  fs.appendFileSync(filePath, `${JSON.stringify({ savedAt, issue })}\n`, 'utf8');
  return filePath;
}

/**
 * Save a raw HTML snapshot as evidence for a blocked/markup-drift page.
 * Returns the saved path, or null on failure.
 */
function persistHtmlSnapshot(source, html) {
  try {
    const dir = path.join(getDataDir(), 'source-health', 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSource = String(source || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `${stamp}-${safeSource}.html`);
    fs.writeFileSync(filePath, String(html || '').slice(0, 500000), 'utf8');
    return filePath;
  } catch (err) {
    console.warn(`[LocalStore] Failed to save HTML snapshot: ${err.message}`);
    return null;
  }
}

function getDataDir() {
  return process.env.SCRAPER_DATA_DIR || DEFAULT_DATA_DIR;
}

// How long a coverage-audit sighting stays in the log — well past the 7-day
// window lib/notify.js's weekly audit reads, so a skipped Sunday email still
// has real history to look back over.
const COVERAGE_LOG_RETENTION_DAYS = 30;

function coverageLogPath() {
  return path.join(getDataDir(), 'coverage', 'coverage-log.jsonl');
}

/**
 * Append one run's county-sighting set to the weekly coverage-audit log
 * (data/coverage/coverage-log.jsonl) as a single JSON line: {date, counties}.
 * `counties` are 'county|ST' keys in the SAME shape lib/filter.js's countyMap
 * uses (lowercase county, uppercase state) — see lib/scraper.js, which builds
 * the set from parsed (pre-filter/pre-dedup) listings whose county+state
 * resolve against the target list.
 *
 * Prunes entries older than 30 days on every write so the log never grows
 * without bound. `date` is the run's own date, passed in by the caller rather
 * than read from Date.now() here — mirrors lib/county-rotation.js's injected-
 * date style so callers (and tests) get deterministic behavior.
 */
function appendCoverageSighting(countyKeys, date = new Date()) {
  const dir = path.join(getDataDir(), 'coverage');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = coverageLogPath();

  const cutoffMs = date.getTime() - COVERAGE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = loadCoverageLog().filter(entry => {
    const entryDate = new Date(entry.date);
    return !Number.isNaN(entryDate.getTime()) && entryDate.getTime() >= cutoffMs;
  });

  kept.push({
    date: date.toISOString().slice(0, 10),
    counties: Array.from(new Set(countyKeys || [])),
  });

  const lines = kept.map(entry => JSON.stringify(entry));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

/**
 * Load the coverage-audit log. Tolerates a missing file (returns []) and
 * corrupt lines (skipped individually with a warning) — a bad log must never
 * crash the nightly email or a coverage-log write.
 */
function loadCoverageLog() {
  const filePath = coverageLogPath();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[LocalStore] Could not read coverage log: ${err.message}`);
    }
    return [];
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.date === 'string' && Array.isArray(entry.counties)) {
        entries.push(entry);
      }
    } catch (err) {
      console.warn(`[LocalStore] Skipping corrupt coverage-log line: ${err.message}`);
    }
  }
  return entries;
}

module.exports = {
  loadLocalCountyTargets,
  persistFailedListings,
  loadPendingFailedWrites,
  archiveFailedWrites,
  persistSourceIssue,
  persistHtmlSnapshot,
  getDataDir,
  appendCoverageSighting,
  loadCoverageLog,
};
