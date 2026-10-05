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
 *
 * Comma grouping is STRICT: every comma must be followed by exactly three
 * digits, and the number may not start in the middle of another digit run or
 * right after a digit's decimal point (the lookbehind — so the "69" of a
 * glued "938812.69" can't be picked up on its own either). The old loose '[\d,]+' read a glued Whitetail card
 * "$873,600312 acres" (price element + acreage element with no space between
 * them) as 873,600,312 acres — 81 impossible leads in the 2026-09-15 nightly.
 * With strict grouping that text yields no acreage at all (rejected, never
 * misread); callers that know where the price ends (BaseParser.extractAcres)
 * strip the price first and recover the real '312'.
 */
const ACREAGE_NUMBER = '(?<![\\d,]|\\d\\.)(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)?\\.\\d+|\\d{1,3}(?:,\\d{3})+(?![\\d,])|\\d+(?![\\d,]))';

// Acreage is reported to at most thousandths (e.g. 40.303 ac). Sites that
// serialize a JS float straight into markup emit binary floating-point noise
// instead — NationalLandRealty's data-acres attribute carried
// "5.5600000000000005" and "0.29000000000000004" in the 2026-10-05 live dry
// run — and the write-time plausibility guard (lib/plausibility.js) refuses
// any acreage with more than 3 decimal places, so that noise would have
// silently refused a real 45.56-acre lead. Rounding here, at the one numeric
// parse every parser shares, strips the noise without touching any real
// surveyed value.
const ACREAGE_DECIMALS = 3;
const ACREAGE_SCALE = 10 ** ACREAGE_DECIMALS;

/**
 * Parse a raw acreage number string ('.24', '0.24', '1,234.5', '40') into a
 * float rounded to thousandths (see ACREAGE_DECIMALS), or null if it isn't a
 * positive number.
 */
function parseAcreageNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/,/g, '').trim();
  const num = Math.round(parseFloat(cleaned) * ACREAGE_SCALE) / ACREAGE_SCALE;
  return Number.isFinite(num) && num > 0 ? num : null;
}

module.exports = { ACREAGE_NUMBER, ACREAGE_DECIMALS, parseAcreageNumber };
