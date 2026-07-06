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
  const filePath = path.join(dir, `${date}.jsonl`);
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
  const target = path.join(doneDir, path.basename(filePath));
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

module.exports = {
  loadLocalCountyTargets,
  persistFailedListings,
  loadPendingFailedWrites,
  archiveFailedWrites,
  persistSourceIssue,
  persistHtmlSnapshot,
  getDataDir,
};
