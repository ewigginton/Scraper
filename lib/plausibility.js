'use strict';

/**
 * Write-time sanity check for a listing's price/acreage, shared by every
 * Airtable write chokepoint (lib/filter.js, lib/intake.js, lib/airtable.js,
 * lib/price-checker.js) so no caller can bypass it.
 *
 * Built from a read-only audit of the live Land table on 2026-10-05, which
 * found 143 records holding impossible values:
 *   - 75 with LP exactly equal to Acres (a "glued" parse — e.g. LP 873600312
 *     / Acres 873600312, where two separately-parsed numbers collided into
 *     one digit string upstream)
 *   - 12 with acres > 20,000 (no real CCL target-county tract is anywhere
 *     near that; the largest legitimate one on record is 5,501.92 ac)
 *   - 8 under $150/acre (e.g. 40,000 ac at $29,900 — under a dollar an acre)
 *   - 48 over $50,000/acre (an old March batch, e.g. $40,000,000 for 500 ac)
 *   - prices carrying 3 decimal places (e.g. 1999007.094 — not a real
 *     dollar-and-cents figure, a sign of an arithmetic/parse artifact)
 *
 * Legitimate leads in Emma's target counties run roughly $800-$12,000/acre
 * and 40-6,000 acres.
 */

// --- Price ---
// No real rural land parcel CCL would consider lists for under $1,000 total;
// a value this low is almost always a parse artifact (a per-acre figure read
// as the total, a stray partial number, etc.).
const MIN_PRICE = 1000;
// Comfortably above anything CCL's target counties would ever see (the
// largest real tracts run a few million dollars); also well below the glued
// LP===Acres values seen in the audit (hundreds of millions), so it still
// catches those even before the price===acres check runs.
const MAX_PRICE = 100000000;
// A real listing price is dollars and cents — no more than 2 decimal places.
// 3+ decimals (e.g. 1999007.094) is an arithmetic/float artifact, not a price
// anyone posted.
const MAX_PRICE_DECIMALS = 2;

// --- Acreage ---
// Acreage must be a positive number — zero or negative acres is meaningless.
// (No separate named constant: the check is simply `acres > 0`.)
// The largest legitimate tract CCL has ever seen on record is 5,501.92 ac;
// 25,000 gives generous headroom above that for an unusually large real
// listing while still rejecting the glued/garbled values in the audit
// (12 records over 20,000 ac, several in the hundreds of thousands).
const MAX_ACRES = 25000;
// Surveyed acreage is reported to at most thousandths (e.g. 40.303 ac) in
// practice; more decimal places is a parse/arithmetic artifact.
const MAX_ACRES_DECIMALS = 3;

// --- Price per acre (computed from price/acres together) ---
// Below this, land is essentially being given away — the audit's worst
// examples ran well under $1/acre. Emma's real target-county leads run
// $800-$12,000/acre, so $150/acre is a wide floor that only catches garbage.
const MIN_CPA = 150;
// Above this, the arithmetic is implausible for a CCL raw-land lead. The
// highest county target is $10,000/acre (Mitchell NC), so even the 30% watch
// ceiling tops out near $13,000; $50,000/acre leaves ample headroom while
// catching the audit's "over $50,000/acre" batch (e.g. $40,000,000 for 500
// ac). Matters most for Listing Intake, which has no county-target check.
const MAX_CPA = 50000;

// Tolerance for float-noise when comparing a value to its rounded form (e.g.
// a unit conversion upstream producing 5.5600000000000005 for a real 5.56).
// Well below a cent or a thousandth of an acre, so it never masks a real
// extra digit.
const DECIMAL_NOISE_TOLERANCE = 1e-9;

/**
 * Whether `num` carries more than `maxDecimals` decimal places of real
 * precision. Rounds to `maxDecimals` first and compares within a small float
 * tolerance, so float-noise like 5.5600000000000005 (a real 5.56 that picked
 * up IEEE-754 rounding error somewhere upstream, e.g. a unit conversion) is
 * NOT flagged — only a genuine extra digit, like 40.3031, is.
 */
function exceedsDecimalPlaces(num, maxDecimals) {
  if (!Number.isFinite(num)) return false;
  const rounded = Number(num.toFixed(maxDecimals));
  return Math.abs(num - rounded) >= DECIMAL_NOISE_TOLERANCE;
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Check a listing's { price, acres } for impossible individual values: out
 * of plausible range, too many decimal places, or (when both are present)
 * price and acres being identical — a glued/garbled parse. Does NOT check
 * the price-per-acre range; see checkPricePerAcrePlausibility for that.
 *
 * Split out from checkListingPlausibility (which still runs both) so a
 * caller like lib/filter.js can run these hard checks first and defer the
 * $/acre range check until after its own minimum-acreage and county checks
 * — the $/acre range only makes sense to apply to a listing that has
 * already cleared those (see lib/filter.js filterListing and defect D2).
 *
 * Returns { ok, problems: [plain-English strings] }. Fields that are absent
 * are not checked individually (callers decide separately whether a missing
 * field is itself a problem) — this function only flags values that ARE
 * present but implausible.
 */
function checkHardPlausibility({ price, acres } = {}) {
  const problems = [];

  const priceOk = isPresent(price);
  const acresOk = isPresent(acres);

  if (priceOk) {
    const p = Number(price);
    if (!Number.isFinite(p)) {
      problems.push(`Price is not a finite number: ${price}`);
    } else {
      if (p < MIN_PRICE || p > MAX_PRICE) {
        problems.push(`Price $${p.toLocaleString()} is outside the plausible range ($${MIN_PRICE.toLocaleString()}-$${MAX_PRICE.toLocaleString()})`);
      }
      if (exceedsDecimalPlaces(p, MAX_PRICE_DECIMALS)) {
        problems.push(`Price $${p} has more than ${MAX_PRICE_DECIMALS} decimal places`);
      }
    }
  }

  if (acresOk) {
    const a = Number(acres);
    if (!Number.isFinite(a)) {
      problems.push(`Acres is not a finite number: ${acres}`);
    } else {
      if (!(a > 0) || a > MAX_ACRES) {
        problems.push(`Acres ${a} is outside the plausible range (0-${MAX_ACRES.toLocaleString()})`);
      }
      if (exceedsDecimalPlaces(a, MAX_ACRES_DECIMALS)) {
        problems.push(`Acres ${a} has more than ${MAX_ACRES_DECIMALS} decimal places`);
      }
    }
  }

  if (priceOk && acresOk && Number.isFinite(Number(price)) && Number.isFinite(Number(acres))) {
    const p = Number(price);
    const a = Number(acres);
    if (p === a) {
      problems.push(`Price and acres are identical (${p}) — looks like a glued/garbled parse`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Check a listing's computed $/acre against the plausible range (MIN_CPA to
 * MAX_CPA). Only meaningful once a listing has already cleared the hard
 * checks above and any minimum-acreage floor a caller applies — a legitimate
 * small lot (e.g. a 1-acre cabin at $250,000/acre) can fall outside this
 * wide "raw rural land" range without being garbage data; it's simply not a
 * rural land lead. See defect D2.
 *
 * Returns { ok, problems: [plain-English strings] }. No-op (ok: true) unless
 * both price and acres are present, finite, and acres > 0.
 */
function checkPricePerAcrePlausibility({ price, acres } = {}) {
  const problems = [];
  const priceOk = isPresent(price) && Number.isFinite(Number(price));
  const acresOk = isPresent(acres) && Number.isFinite(Number(acres));

  if (priceOk && acresOk) {
    const p = Number(price);
    const a = Number(acres);
    if (a > 0) {
      const cpa = p / a;
      if (cpa < MIN_CPA || cpa > MAX_CPA) {
        problems.push(`$${Math.round(cpa).toLocaleString()}/acre is outside the plausible range ($${MIN_CPA}-$${MAX_CPA.toLocaleString()}/acre)`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Check a listing's { price, acres } for impossible values — the full
 * check, combining checkHardPlausibility and checkPricePerAcrePlausibility.
 * Used by write chokepoints that have no acreage-floor/county notion of
 * their own (lib/intake.js, lib/airtable.js, lib/price-checker.js).
 * lib/filter.js calls the two halves separately instead — see D2 above.
 */
function checkListingPlausibility({ price, acres } = {}) {
  const hard = checkHardPlausibility({ price, acres });
  const perAcre = checkPricePerAcrePlausibility({ price, acres });
  const problems = [...hard.problems, ...perAcre.problems];
  return { ok: problems.length === 0, problems };
}

module.exports = {
  checkListingPlausibility,
  checkHardPlausibility,
  checkPricePerAcrePlausibility,
  MIN_PRICE,
  MAX_PRICE,
  MAX_PRICE_DECIMALS,
  MAX_ACRES,
  MAX_ACRES_DECIMALS,
  MIN_CPA,
  MAX_CPA,
};
