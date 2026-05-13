'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stateFullName, stateAbbrev, stateSlugLower, stateSlugTitle,
  STATE_ABBREV_TO_FULL, STATE_FULL_TO_ABBREV,
} = require('../lib/states');

test('stateFullName converts abbreviation to full name', () => {
  assert.equal(stateFullName('TX'), 'Texas');
  assert.equal(stateFullName('SC'), 'South Carolina');
  assert.equal(stateFullName('NM'), 'New Mexico');
  assert.equal(stateFullName('tx'), 'Texas');
});

test('stateFullName returns input for unknown abbreviations', () => {
  assert.equal(stateFullName('ZZ'), 'ZZ');
});

test('stateAbbrev converts full name to abbreviation', () => {
  assert.equal(stateAbbrev('Texas'), 'TX');
  assert.equal(stateAbbrev('South Carolina'), 'SC');
  assert.equal(stateAbbrev('New Mexico'), 'NM');
  assert.equal(stateAbbrev('  texas  '), 'TX');
});

test('stateAbbrev falls back to uppercase for unknown names', () => {
  assert.equal(stateAbbrev('Narnia'), 'NARNIA');
});

test('stateSlugLower produces lowercase hyphenated slugs', () => {
  assert.equal(stateSlugLower('TX'), 'texas');
  assert.equal(stateSlugLower('SC'), 'south-carolina');
  assert.equal(stateSlugLower('NM'), 'new-mexico');
});

test('stateSlugTitle produces title-case hyphenated slugs', () => {
  assert.equal(stateSlugTitle('TX'), 'Texas');
  assert.equal(stateSlugTitle('SC'), 'South-Carolina');
  assert.equal(stateSlugTitle('NM'), 'New-Mexico');
});

test('all 50 states are present in both lookup maps', () => {
  assert.equal(Object.keys(STATE_ABBREV_TO_FULL).length, 50);
  assert.equal(Object.keys(STATE_FULL_TO_ABBREV).length, 50);
});

test('round-trip: abbrev -> full -> abbrev', () => {
  for (const [abbr, full] of Object.entries(STATE_ABBREV_TO_FULL)) {
    assert.equal(stateAbbrev(full), abbr, `round-trip failed for ${abbr} / ${full}`);
  }
});
