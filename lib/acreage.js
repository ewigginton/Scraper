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

module.exports = { ACREAGE_NUMBER, parseAcreageNumber, extractStructuredTextAcres };
