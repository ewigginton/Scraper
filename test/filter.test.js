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
