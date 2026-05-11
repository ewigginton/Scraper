'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

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

  const dir = path.join(DATA_DIR, 'failed-writes');
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

module.exports = {
  loadLocalCountyTargets,
  persistFailedListings,
};
