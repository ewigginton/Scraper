'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initFilter, filterListing } = require('../lib/filter');

test('filterListing sets rounded computedCPA on the listing object', () => {
  initFilter(new Map([['dallas|TX', 5000]]));

  const listing = {
    name: 'Dallas County Tract',
    price: 333333,
    acres: 100,
    county: 'Dallas',
    state: 'TX',
    url: 'https://example.com/listing',
  };

  const result = filterListing(listing);
  assert.equal(result.passed, true);
  assert.equal(listing.computedCPA, 3333.33);
});

test('computedCPA is rounded to exactly 2 decimal places', () => {
  initFilter(new Map([['anderson|TX', 5000]]));

  const listing = {
    name: 'Anderson Tract',
    price: 100000,
    acres: 43, // above 40ac minAcres
    county: 'Anderson',
    state: 'TX',
    url: 'https://example.com/test',
  };

  const result = filterListing(listing);
  assert.equal(result.passed, true);
  // 100000 / 43 = 2325.581395... should round to 2325.58
  assert.equal(listing.computedCPA, 2325.58);
  const decimalStr = listing.computedCPA.toString().split('.')[1] || '';
  assert.ok(decimalStr.length <= 2, `got ${decimalStr.length} decimal places`);
});

test('filterListing accepts listings within 20% of CPA target', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  // 19% over = $4760/ac
  const result = filterListing({
    name: 'Just Under 20%',
    price: 476000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/close',
  });

  assert.equal(result.passed, true);
  assert.equal(result.stage, 'New Lead');
});

test('filterListing rejects listings more than 30% over CPA target', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  // 31% over = $5240/ac
  const result = filterListing({
    name: 'Way Over',
    price: 524000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/over',
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /Over threshold/);
});

test('filterListing rejects listings below min acreage', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const result = filterListing({
    name: 'Small Tract',
    price: 100000,
    acres: 10,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/small',
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /Below minimum acreage/);
});

test('filterListing catches price per acre discrepancy', () => {
  initFilter(new Map([['dallas|TX', 5000]]));

  const result = filterListing({
    name: 'Discrepancy Tract',
    price: 200000,
    acres: 100,
    pricePerAcre: 2500, // site says $2500 but computed is $2000 — $500 diff
    county: 'Dallas',
    state: 'TX',
    url: 'https://example.com/disc',
  });

  assert.ok(result.validationErrors.some(e => e.includes('discrepancy')));
});
