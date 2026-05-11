'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateFingerprint } = require('../lib/fingerprint');
const airtable = require('../lib/airtable');

test('fingerprint from scraper matches fingerprint from checkDuplicate', () => {
  const listing = {
    name: 'Test Tract',
    price: 200000,
    acres: 100,
    county: 'Taney',
    state: 'MO',
    url: 'https://example.com/listing-1',
    source: 'LandWatch',
  };

  // scraper.js computes fingerprint this way:
  const fpFromScraper = generateFingerprint(listing);
  listing.fingerprint = fpFromScraper;

  // airtable.js checkDuplicate also calls generateFingerprint internally:
  const dedupIndex = {
    urlSet: new Set(),
    fingerprintSet: new Set([fpFromScraper]),
  };

  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'fingerprint');
});

test('same property on different sites produces same fingerprint', () => {
  const landwatchListing = {
    county: 'Taney County',
    state: 'mo',
    acres: 151,
    price: 602000,
  };
  const landcomListing = {
    county: 'Taney',
    state: 'MO',
    acres: 149,
    price: 601000,
  };

  const fp1 = generateFingerprint(landwatchListing);
  const fp2 = generateFingerprint(landcomListing);
  assert.equal(fp1, fp2, 'cross-site fingerprints should match within rounding tolerance');
});

test('different properties produce different fingerprints', () => {
  const a = { county: 'Taney', state: 'MO', acres: 100, price: 200000 };
  const b = { county: 'Taney', state: 'MO', acres: 300, price: 600000 };
  assert.notEqual(generateFingerprint(a), generateFingerprint(b));
});

test('checkDuplicate detects URL match', () => {
  const listing = {
    name: 'Test',
    price: 100000,
    acres: 50,
    county: 'Dallas',
    state: 'TX',
    url: 'https://landwatch.com/property/123',
  };

  const dedupIndex = {
    urlSet: new Set(['https://landwatch.com/property/123']),
    fingerprintSet: new Set(),
  };

  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'url');
});

test('checkDuplicate passes for new listing', () => {
  const listing = {
    name: 'Brand New',
    price: 100000,
    acres: 50,
    county: 'Dallas',
    state: 'TX',
    url: 'https://landwatch.com/property/new',
  };

  const dedupIndex = {
    urlSet: new Set(['https://landwatch.com/property/old']),
    fingerprintSet: new Set(),
  };

  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, false);
});

test('incomplete listing produces null fingerprint and passes dedup', () => {
  const listing = {
    name: 'No County',
    price: 100000,
    acres: 50,
    county: '',
    state: 'TX',
    url: 'https://example.com/no-county',
  };

  const fp = generateFingerprint(listing);
  assert.equal(fp, null);

  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set() };
  const result = airtable.checkDuplicate(listing, dedupIndex);
  assert.equal(result.isDuplicate, false);
});
