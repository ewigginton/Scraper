'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateFingerprint, normalizeCounty, roundTo } = require('../lib/fingerprint');

test('normalizeCounty strips county suffix and punctuation', () => {
  assert.equal(normalizeCounty('St. Clair County'), 'st clair');
  assert.equal(normalizeCounty('Taney Parish'), 'taney');
});

test('generateFingerprint matches nearby acreage and price values', () => {
  const first = generateFingerprint({
    county: 'Taney County',
    state: 'mo',
    acres: 151,
    price: 602000,
  });
  const second = generateFingerprint({
    county: 'Taney',
    state: 'MO',
    acres: 149,
    price: 601000,
  });

  assert.equal(first, second);
});

test('roundTo rounds to configured-style buckets', () => {
  assert.equal(roundTo(151, 5), 150);
  assert.equal(roundTo(603000, 5000), 605000);
});
