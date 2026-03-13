'use strict';

const crypto = require('crypto');
const settings = require('../config/settings.json');

/**
 * Generate a deterministic property fingerprint for cross-site deduplication.
 *
 * The fingerprint is a SHA-256 hash of: normalized county + state + acreage
 * (rounded to nearest N acres) + price (rounded to nearest $N).
 *
 * Two listings for the same property on different sites will produce the same
 * fingerprint even if the names, URLs, and descriptions differ — as long as
 * they agree on location, size, and price within rounding tolerance.
 */
function generateFingerprint(listing) {
  const { acreageRoundTo, priceRoundTo } = settings.dedup;

  const county = normalizeCounty(listing.county);
  const state = (listing.state || '').toUpperCase().trim();
  const acres = roundTo(listing.acres, acreageRoundTo);
  const price = roundTo(listing.price, priceRoundTo);

  if (!county || !state || !acres || !price) {
    return null; // Can't fingerprint incomplete data
  }

  const raw = `${county}|${state}|${acres}|${price}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Normalize county name for consistent matching.
 * Strips "County", "Parish", extra whitespace, and lowercases.
 */
function normalizeCounty(county) {
  if (!county) return '';
  return county
    .toLowerCase()
    .replace(/\bcounty\b/gi, '')
    .replace(/\bparish\b/gi, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundTo(value, nearest) {
  if (!value || !nearest) return 0;
  return Math.round(value / nearest) * nearest;
}

module.exports = { generateFingerprint, normalizeCounty, roundTo };
