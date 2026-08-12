'use strict';

/**
 * Acreage-number regex fragment shared by every acreage-extraction site in
 * the scraper. Tries the decimal alternative FIRST so a leading-decimal
 * figure with no digit before the point ('.24 acres') is captured whole.
 *
 * A naive '[\d,]+(?:\.\d+)?' pattern requires a digit before the decimal, so
 * on '.24 acres' it skips the leading '.' and matches only '24' — turning a
 * 0.24-acre listing into a 24-acre one. That exact bug corrupted a real
 * Atoka County, OK listing and let it slip past the 40-acre minimum (nothing
 * downstream re-validates acreage once it's wrong). This fragment matches
 * '.24', '0.24', '1,234.5', and '40' all correctly.
 */
const ACREAGE_NUMBER = '(?:[\\d,]*\\.\\d+|[\\d,]+)';

/**
 * Parse a raw acreage number string ('.24', '0.24', '1,234.5', '40') into a
 * float, or null if it isn't a positive number.
 */
function parseAcreageNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Structured, price-adjacent acreage signals a detail page renders for the
 * listing itself — never a number that merely appears somewhere in nearby
 * description prose. This is what fixes the "N-acre lake/park" bug: a LandWatch
 * detail page for a 0.94ac lot reading "Nestled on the gorgeous 1,000 acre Lake
 * Halford..." also carries a price line reading "$150,000 • 0.94 acres" and CTA
 * text reading "View 0.94 acres priced at $150,000" — both name the LISTING's
 * own acreage, so they must be tried (and trusted) before ever scanning the
 * free-text description where the lake's 1,000 acres lives. Both patterns route
 * through ACREAGE_NUMBER, so a leading-decimal figure ('.499 Acres +/-') never
 * loses its point here either.
 */
const PRICE_BULLET_ACRES_RE = new RegExp(
  `\\$\\s?[\\d,]+(?:\\.\\d+)?\\s*[•·|]\\s*(${ACREAGE_NUMBER})\\s*(?:±|\\+\\/-)?\\s*acres?\\b`, 'i'
);
const VIEW_ACRES_PRICED_RE = new RegExp(
  `\\bview\\s+(${ACREAGE_NUMBER})\\s*(?:±|\\+\\/-)?\\s*acres?\\s+priced\\s+at\\b`, 'i'
);

/**
 * Try each structured-signal text pattern against detail-page text, in no
 * particular priority order relative to each other (both outrank free-text
 * description prose equally). Returns the parsed acreage, or null if neither
 * pattern is present.
 */
function extractStructuredTextAcres(text) {
  const str = String(text || '');
  for (const re of [PRICE_BULLET_ACRES_RE, VIEW_ACRES_PRICED_RE]) {
    const m = str.match(re);
    if (m) {
      const value = parseAcreageNumber(m[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

/**
 * Price-ANCHORED variants of the two structured patterns, capturing the dollar
 * figure alongside the acreage so a caller can require it to match the
 * listing's own price.
 *
 * Detail pages carry "similar properties nearby" rails whose cards render the
 * exact same "$45,000 • 1.5 acres" markup as the main listing. An unanchored
 * scan returns whichever appears first in document order, so a neighbour's
 * acreage can overwrite a correct one — a real 200ac lead was reproduced being
 * rewritten to 1.5ac and then discarded by the 40-acre floor. Requiring the
 * price to match the listing's own price is what makes the signal unambiguous.
 */
const PRICE_BULLET_ACRES_ANCHORED_RE = new RegExp(
  `\\$\\s?([\\d,]+(?:\\.\\d+)?)\\s*[•·|]\\s*(${ACREAGE_NUMBER})\\s*(?:±|\\+\\/-)?\\s*acres?\\b`, 'gi'
);
const VIEW_ACRES_PRICED_ANCHORED_RE = new RegExp(
  `\\bview\\s+(${ACREAGE_NUMBER})\\s*(?:±|\\+\\/-)?\\s*acres?\\s+priced\\s+at\\s*\\$\\s?([\\d,]+(?:\\.\\d+)?)`, 'gi'
);

/** Parse a price-ish string ('1,234', '1234.00') to a number, else null. */
function parsePriceNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Prices are compared with a small relative tolerance rather than exactly: a
 * page may render the listing price rounded ($574,000 in the card vs $573,999
 * in JSON-LD). 1% is far tighter than the gap between two different listings.
 */
const PRICE_MATCH_TOLERANCE = 0.01;

function pricesMatch(a, b) {
  if (!a || !b) return false;
  return Math.abs(a - b) / Math.max(a, b) <= PRICE_MATCH_TOLERANCE;
}

/**
 * Acreage from a structured text signal whose accompanying price matches the
 * listing's own price — i.e. the pattern is naming THIS listing, not a nearby
 * card. Returns null when the listing has no known price or no pattern's price
 * matches; callers must then fall back to report-only rather than overriding.
 */
function extractPriceAnchoredAcres(text, price) {
  const listingPrice = parsePriceNumber(price);
  if (listingPrice === null) return null;
  const str = String(text || '');

  for (const { re, acresIndex, priceIndex } of [
    { re: PRICE_BULLET_ACRES_ANCHORED_RE, acresIndex: 2, priceIndex: 1 },
    { re: VIEW_ACRES_PRICED_ANCHORED_RE, acresIndex: 1, priceIndex: 2 },
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      if (!pricesMatch(parsePriceNumber(m[priceIndex]), listingPrice)) continue;
      const value = parseAcreageNumber(m[acresIndex]);
      if (value !== null) return value;
    }
  }
  return null;
}

module.exports = {
  ACREAGE_NUMBER,
  parseAcreageNumber,
  parsePriceNumber,
  pricesMatch,
  extractStructuredTextAcres,
  extractPriceAnchoredAcres,
};
