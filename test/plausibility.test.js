'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkListingPlausibility,
  checkHardPlausibility,
  checkPricePerAcrePlausibility,
  MIN_PRICE,
  MAX_PRICE,
  MAX_ACRES,
  MIN_CPA,
  MAX_CPA,
} = require('../lib/plausibility');

function problemsMatching(result, pattern) {
  return result.problems.filter(p => pattern.test(p));
}

// --- Real good values (must pass clean) ---

test('checkListingPlausibility: real good listing — 5,501.92 ac / $8,810,350 (largest real tract on record)', () => {
  const result = checkListingPlausibility({ price: 8810350, acres: 5501.92 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('checkListingPlausibility: real good listing — 40.3 ac / $72,777', () => {
  const result = checkListingPlausibility({ price: 72777, acres: 40.3 });
  assert.equal(result.ok, true);
});

test('checkListingPlausibility: real good listing — 58.3 ac / $649,000', () => {
  const result = checkListingPlausibility({ price: 649000, acres: 58.3 });
  assert.equal(result.ok, true);
});

// --- Real bad values from the 2026-10-05 audit ---

test('checkListingPlausibility: glued LP/Acres parse (873600312 / 873600312)', () => {
  const result = checkListingPlausibility({ price: 873600312, acres: 873600312 });
  assert.equal(result.ok, false);
  // Both the absolute-range AND the glued-equality rule should fire on a
  // real glued value this large.
  assert.ok(problemsMatching(result, /outside the plausible range \(\$1,000/).length > 0);
});

test('checkListingPlausibility: glued parse — equal price/acres always flags "identical" (CPA is necessarily $1/acre too)', () => {
  const result = checkListingPlausibility({ price: 5000, acres: 5000 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /identical/).length === 1);
  assert.ok(problemsMatching(result, /\$1\/acre is outside/).length === 1);
  assert.equal(result.problems.length, 2);
});

test('checkListingPlausibility: acres > 20,000 batch — 40,000 ac at $29,900', () => {
  const result = checkListingPlausibility({ price: 29900, acres: 40000 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /Acres 40000 is outside the plausible range/).length === 1);
  // Also implausibly cheap per acre
  assert.ok(problemsMatching(result, /\$1\/acre is outside/).length === 1);
});

test('checkListingPlausibility: under $150/acre — 2,500 ac at $179,900', () => {
  const result = checkListingPlausibility({ price: 179900, acres: 2500 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /\$72\/acre is outside the plausible range/).length === 1);
});

test('checkListingPlausibility: under $150/acre and over acres ceiling — 249,249 ac at $809,250', () => {
  const result = checkListingPlausibility({ price: 809250, acres: 249249 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /Acres 249249 is outside/).length === 1);
  assert.ok(problemsMatching(result, /\$3\/acre is outside/).length === 1);
});

test('checkListingPlausibility: over $50,000/acre batch — $40,000,000 for 500 ac (CPA $80,000) is flagged', () => {
  const result = checkListingPlausibility({ price: 40000000, acres: 500 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /\$80,000\/acre is outside the plausible range/).length === 1);
});

test('checkListingPlausibility: highest real target-county lead ($11,132/ac, Mitchell NC) passes', () => {
  assert.equal(checkListingPlausibility({ price: 649000, acres: 58.3 }).ok, true);
});

test('checkListingPlausibility: over the $50,000/acre ceiling — $15,000,000 for 100 ac (CPA $150,000)', () => {
  const result = checkListingPlausibility({ price: 15000000, acres: 100 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /\$150,000\/acre is outside the plausible range/).length === 1);
});

test('checkListingPlausibility: price with 3 decimal places (1999007.094)', () => {
  const result = checkListingPlausibility({ price: 1999007.094, acres: 663 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /more than 2 decimal places/).length === 1);
});

// --- Boundaries ---

test('checkListingPlausibility: price boundary — $1,000 passes, $999 fails', () => {
  // acres chosen (5) so $/acre stays within the valid CPA band at both
  // prices, isolating the absolute price-range rule
  assert.equal(checkListingPlausibility({ price: MIN_PRICE, acres: 5 }).ok, true);
  const result = checkListingPlausibility({ price: MIN_PRICE - 1, acres: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^Price \$999 is outside the plausible range/);
});

test('checkListingPlausibility: price boundary — $100,000,000 passes, over it fails', () => {
  // acres chosen to keep $/acre within MIN_CPA..MAX_CPA so only the absolute
  // price-range rule is isolated
  const acres = MAX_PRICE / 10000;
  assert.equal(checkListingPlausibility({ price: MAX_PRICE, acres }).ok, true);
  const result = checkListingPlausibility({ price: MAX_PRICE + 1, acres });
  assert.equal(result.ok, false);
});

test('checkListingPlausibility: acres boundary — 25,000 passes, over it fails', () => {
  // price chosen to keep $/acre within range
  const price = MAX_ACRES * 1000;
  assert.equal(checkListingPlausibility({ price, acres: MAX_ACRES }).ok, true);
  const result = checkListingPlausibility({ price, acres: MAX_ACRES + 1 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /outside the plausible range \(0-25,000\)/).length === 1);
});

test('checkListingPlausibility: acres must be positive — zero and negative both fail', () => {
  assert.equal(checkListingPlausibility({ price: 100000, acres: 0 }).ok, false);
  assert.equal(checkListingPlausibility({ price: 100000, acres: -5 }).ok, false);
});

test('checkListingPlausibility: acres decimal places — 3 passes, 4 fails', () => {
  assert.equal(checkListingPlausibility({ price: 100000, acres: 40.303 }).ok, true);
  const result = checkListingPlausibility({ price: 100000, acres: 40.3031 });
  assert.equal(result.ok, false);
  assert.ok(problemsMatching(result, /more than 3 decimal places/).length === 1);
});

test('checkListingPlausibility: price decimal places — 2 passes, 3 fails', () => {
  assert.equal(checkListingPlausibility({ price: 100000.12, acres: 100 }).ok, true);
  assert.equal(checkListingPlausibility({ price: 100000.123, acres: 100 }).ok, false);
});

test('checkListingPlausibility: $/acre boundaries — $150 and $50,000 pass, just outside fails', () => {
  assert.equal(checkListingPlausibility({ price: 150 * 100, acres: 100 }).ok, true);
  assert.equal(checkListingPlausibility({ price: (MIN_CPA - 1) * 100, acres: 100 }).ok, false);
  assert.equal(checkListingPlausibility({ price: MAX_CPA * 100, acres: 100 }).ok, true);
  assert.equal(checkListingPlausibility({ price: (MAX_CPA + 1) * 100, acres: 100 }).ok, false);
});

// --- Presence rules ---

test('checkListingPlausibility: missing price is not flagged (only acres checked)', () => {
  const result = checkListingPlausibility({ acres: 100 });
  assert.equal(result.ok, true);
});

test('checkListingPlausibility: missing acres is not flagged (only price checked)', () => {
  const result = checkListingPlausibility({ price: 100000 });
  assert.equal(result.ok, true);
});

test('checkListingPlausibility: both missing passes with no problems', () => {
  const result = checkListingPlausibility({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('checkListingPlausibility: non-finite price/acres are flagged, not thrown', () => {
  assert.equal(checkListingPlausibility({ price: NaN, acres: 100 }).ok, false);
  assert.equal(checkListingPlausibility({ price: Infinity, acres: 100 }).ok, false);
  assert.equal(checkListingPlausibility({ price: 100000, acres: NaN }).ok, false);
});

// --- D1 regression: float-noise decimals must not be flagged ---
// A real NationalLandRealty data-acres value came through as
// 5.5600000000000005 (IEEE-754 noise from an upstream unit conversion, not a
// 16-decimal-place parcel). The old decimalPlaces() string-counted every
// digit and rejected it. Round-first comparison must treat it as 3 decimals.

test('checkListingPlausibility: float-noise acreage (5.5600000000000005) is NOT flagged as too many decimals', () => {
  const result = checkListingPlausibility({ price: 50000, acres: 5.5600000000000005 });
  assert.deepEqual(problemsMatching(result, /decimal places/), []);
});

test('checkListingPlausibility: float-noise acreage (0.29000000000000004) is NOT flagged as too many decimals', () => {
  const result = checkHardPlausibility({ price: 50000, acres: 0.29000000000000004 });
  assert.deepEqual(problemsMatching(result, /decimal places/), []);
});

test('checkListingPlausibility: a real 40+ acre NationalLand lead with float-noise acreage passes cleanly end to end', () => {
  // Mirrors the verifier's exact failure case: 45.56000000000001 ac, a sane
  // price, in range — must come back ok with zero problems, not refused.
  const result = checkListingPlausibility({ price: 364480, acres: 45.56000000000001 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('checkListingPlausibility: float-noise price (100000.00000000001) is NOT flagged as too many decimals', () => {
  const result = checkHardPlausibility({ price: 100000.00000000001, acres: 100 });
  assert.deepEqual(problemsMatching(result, /decimal places/), []);
});

test('checkListingPlausibility: a genuine extra decimal digit is still flagged (not masked by the float-noise fix)', () => {
  // Make sure the rounding tolerance didn't widen into a loophole: a real
  // 4th acreage decimal and a real 3rd price decimal must still fail.
  assert.equal(checkHardPlausibility({ price: 100000, acres: 40.3031 }).ok, false);
  assert.equal(checkHardPlausibility({ price: 100000.123, acres: 100 }).ok, false);
});

// --- checkHardPlausibility / checkPricePerAcrePlausibility split (D2 support) ---
// lib/filter.js calls these two halves separately so it can run its own
// acreage-floor/county checks between them (see test/filter.test.js "(D2)").

test('checkHardPlausibility: flags range/decimal/equality problems but never the $/acre range', () => {
  const result = checkHardPlausibility({ price: 15000000, acres: 100 });
  // $150,000/acre is way outside MIN_CPA-MAX_CPA, but checkHardPlausibility
  // only checks individual-field range/decimals/equality, not $/acre.
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('checkPricePerAcrePlausibility: flags only the $/acre range, independent of acreage/price range checks', () => {
  const result = checkPricePerAcrePlausibility({ price: 15000000, acres: 100 });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /\$150,000\/acre is outside the plausible range/);
});

test('checkPricePerAcrePlausibility: ok (no-op) when price or acres is missing or non-finite', () => {
  assert.equal(checkPricePerAcrePlausibility({ acres: 100 }).ok, true);
  assert.equal(checkPricePerAcrePlausibility({ price: 100000 }).ok, true);
  assert.equal(checkPricePerAcrePlausibility({ price: NaN, acres: 100 }).ok, true);
});

test('checkListingPlausibility (combined) equals checkHardPlausibility + checkPricePerAcrePlausibility problems', () => {
  const combined = checkListingPlausibility({ price: 15000000, acres: 100 });
  const hard = checkHardPlausibility({ price: 15000000, acres: 100 });
  const perAcre = checkPricePerAcrePlausibility({ price: 15000000, acres: 100 });
  assert.deepEqual(combined.problems, [...hard.problems, ...perAcre.problems]);
});
