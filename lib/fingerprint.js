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
 * Price-free location key: normalized county + state + acreage bucket.
 * Used as a secondary dedup layer so the same property listed at slightly
 * different prices on two sites (different $5k buckets) is still matched —
 * the caller must confirm with a price-tolerance comparison, since two
 * genuinely different tracts can share a county and acreage bucket.
 */
function locationKey(county, state, acres) {
  const { acreageRoundTo } = settings.dedup;
  const normCounty = normalizeCounty(county);
  const normState = (state || '').toUpperCase().trim();
  const acresBucket = roundTo(acres, acreageRoundTo);
  if (!normCounty || !normState || !acresBucket) return null;
  return `${normCounty}|${normState}|${acresBucket}`;
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
  if (!value || !nearest || value <= 0) return 0;
  // Never round a real value down to bucket 0 — sub-half-bucket values
  // (e.g. a $2,000 price with $5k rounding) land in the first bucket instead
  // of producing a falsy bucket that disables fingerprinting entirely.
  return Math.max(nearest, Math.round(value / nearest) * nearest);
}

module.exports = { generateFingerprint, locationKey, normalizeCounty, roundTo };
