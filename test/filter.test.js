'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initFilter, filterListing } = require('../lib/filter');

test('filterListing accepts at-target listings as New Lead', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Taney County Tract',
    price: 400000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/listing',
  });

  assert.equal(result.passed, true);
  assert.equal(result.stage, 'New Lead');
  assert.equal(result.cpaTarget, 4000);
});

test('filterListing routes watch-zone listings to Watch For Price Drop', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Taney County Watch Tract',
    price: 500000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/watch',
  });

  assert.equal(result.passed, true);
  assert.equal(result.stage, 'Watch For Price Drop');
});

test('filterListing rejects non-target counties', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Outside County',
    price: 100000,
    acres: 100,
    county: 'Greene',
    state: 'MO',
    url: 'https://example.com/outside',
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /County not in target list/);
});

// GUARD 1a (lib/plausibility.js wired into filterListing) — an implausible
// listing is rejected before the county/threshold checks, with a reason the
// scraper report itemizes (lib/scraper.js' "Implausible data:" prefix check).
test('filterListing rejects a glued price/acres parse as implausible, before the county check', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Glued Parse Tract',
    price: 873600312,
    acres: 873600312,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/glued',
  });

  assert.equal(result.passed, false);
  assert.equal(result.stage, null);
  assert.match(result.reason, /^Implausible data: /);
});

test('filterListing rejects a listing with an implausible $/acre even inside a target county', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Implausible CPA Tract',
    price: 15000000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/implausible-cpa',
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /Implausible data:.*\$150,000\/acre/);
});

// D2 regression (verifier finding): a real small lot/home/commercial listing
// below the acreage floor must be rejected for that reason, not mislabeled
// "Implausible data" because its $/acre falls outside the wide rural-land
// range. The acreage floor check must run BEFORE the $/acre plausibility
// check.
test('filterListing rejects a below-floor small lot for acreage, not as implausible $/acre (D2)', () => {
  initFilter(new Map([['mcintosh|OK', 4000]]));

  // A real 1-acre lake cabin at $250,000/acre — way outside the $150-$100,000
  // rural-land $/acre range, but not garbage data, just not a rural tract.
  const result = filterListing({
    name: 'Lake Eufaula Cabin',
    price: 250000,
    acres: 1,
    county: 'McIntosh',
    state: 'OK',
    url: 'https://example.com/cabin',
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /^Below minimum acreage/);
  assert.doesNotMatch(result.reason, /Implausible/);
});

// D2 regression: the county check must also run before the $/acre
// plausibility check, so a listing in a non-target county is rejected for
// that reason rather than "Implausible data".
test('filterListing rejects a non-target-county listing with an out-of-range $/acre as county-not-in-list, not implausible (D2)', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Outside County High Value',
    price: 4200000,
    acres: 40,
    county: 'San Augustine',
    state: 'TX',
    url: 'https://example.com/outside-high-value',
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /^County not in target list/);
  assert.doesNotMatch(result.reason, /Implausible/);
});

// D2 regression: once a listing clears the acreage floor and county check,
// an out-of-range $/acre is still caught as implausible (the CPA range
// check isn't simply removed — only reordered).
test('filterListing still rejects an implausible $/acre once acreage and county both check out (D2)', () => {
  initFilter(new Map([['mcintosh|OK', 4000]]));

  const result = filterListing({
    name: 'Implausible CPA Above Floor',
    price: 15000000,
    acres: 100,
    county: 'McIntosh',
    state: 'OK',
    url: 'https://example.com/implausible-cpa-above-floor',
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /^Implausible data:.*\$150,000\/acre/);
});

test('filterListing still passes a plausible listing (plausibility check is not overly strict)', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Normal Tract',
    price: 72777,
    acres: 40.3,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/normal',
  });

  assert.equal(result.passed, true);
});

test('filterListing: "Le Flore" (LandWatch spelling) matches the "Leflore" County target', () => {
  const { initFilter, filterListing } = require('../lib/filter');
  initFilter(new Map([['leflore|OK', 1900]]));
  const result = filterListing({ price: 199000, acres: 120, county: 'Le Flore', state: 'OK', url: 'https://example.com/l/1', name: 'x' });
  assert.equal(result.passed, true);
  assert.equal(result.cpaTarget, 1900);
});
