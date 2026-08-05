'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AVAILABILITY_FLAGS, matchesKeyword, findAvailabilityMatches } = require('../lib/availability');

test('findAvailabilityMatches: status-anchored "sold" detection matches the listing\'s own status', () => {
  assert.ok(findAvailabilityMatches('This property has been SOLD.').includes('sold'));
  assert.ok(findAvailabilityMatches('SOLD OUT - Big Ranch').includes('sold'), 'listing name prefixed "SOLD OUT -"');
  assert.ok(findAvailabilityMatches('Status: Sold').includes('sold'));
  assert.ok(findAvailabilityMatches('SOLD - Widow Creek Ranch, 80 acres').includes('sold'), 'listing name prefixed "SOLD -"');
  assert.ok(findAvailabilityMatches('This tract is now sold, thanks everyone.').includes('sold'));
  assert.ok(findAvailabilityMatches('Just sold — closed last Friday.').includes('sold'));
});

test('findAvailabilityMatches: comp/closing prose never trips "sold"', () => {
  assert.ok(!findAvailabilityMatches('unsold inventory').includes('sold'));
  assert.ok(!findAvailabilityMatches('similar tracts have sold for $3,000/acre').includes('sold'));
  assert.ok(!findAvailabilityMatches('sold comps support this price').includes('sold'), 'starts with "sold" but is not a status tag');
  assert.ok(!findAvailabilityMatches('we sold 3 tracts nearby last year').includes('sold'));
});

test('matchesKeyword: hyphen/whitespace-tolerant phrase matching', () => {
  assert.equal(matchesKeyword('This tract is under-contract as of today.', 'under contract'), true);
  assert.equal(matchesKeyword('Under  contract (double space)', 'under contract'), true);
  assert.equal(matchesKeyword('open pasture with no restrictions', 'under contract'), false);
});

test('findAvailabilityMatches: phrase-based flags still match alongside "sold"', () => {
  const matches = findAvailabilityMatches('This listing is under contract and has been SOLD.');
  assert.ok(matches.includes('under contract'));
  assert.ok(matches.includes('sold'));
});

test('AVAILABILITY_FLAGS does not itself contain "sold" (it lives only behind findAvailabilityMatches)', () => {
  assert.ok(!AVAILABILITY_FLAGS.includes('sold'));
});

test('findAvailabilityMatches: a name that IS entirely "SOLD"/"SOLD OUT" (cleanTitle residue) matches', () => {
  assert.ok(findAvailabilityMatches('SOLD').includes('sold'));
  assert.ok(findAvailabilityMatches('SOLD OUT').includes('sold'));
  assert.ok(findAvailabilityMatches('  Sold  ').includes('sold'));
  // Both ends anchored: prose containing or starting with "sold" stays clean
  assert.ok(!findAvailabilityMatches('sold comps').includes('sold'));
  assert.ok(!findAvailabilityMatches('Sold on the location? Come see it.').includes('sold'));
});
