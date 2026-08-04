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

module.exports = { ACREAGE_NUMBER, parseAcreageNumber };
