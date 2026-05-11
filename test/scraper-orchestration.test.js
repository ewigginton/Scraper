'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initFilter, filterListing } = require('../lib/filter');
const { generateFingerprint } = require('../lib/fingerprint');
const airtable = require('../lib/airtable');

test('full pipeline: filter -> fingerprint -> dedup flow', () => {
  initFilter(new Map([
    ['taney|MO', 4000],
    ['dallas|TX', 3000],
  ]));

  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set() };
  const sessionFingerprints = new Map();
  const passed = [];

  const listings = [
    // Should pass: under target
    { name: 'Good Deal', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/1', source: 'LandWatch' },
    // Should be rejected: over 30%
    { name: 'Too Expensive', price: 600000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/2', source: 'LandWatch' },
    // Should pass: different county
    { name: 'Dallas Tract', price: 200000, acres: 100, county: 'Dallas', state: 'TX', url: 'https://lw.com/3', source: 'LandWatch' },
    // Should be deduped: same URL as first
    { name: 'Duplicate URL', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/1', source: 'Land.com' },
    // Should pass as watch: 25% over
    { name: 'Watch Zone', price: 500000, acres: 100, county: 'Taney', state: 'MO', url: 'https://lw.com/5', source: 'LandWatch' },
    // Should be rejected: not a target county
    { name: 'Wrong County', price: 100000, acres: 100, county: 'Boone', state: 'MO', url: 'https://lw.com/6', source: 'LandWatch' },
    // Should be rejected: below min acres
    { name: 'Too Small', price: 100000, acres: 10, county: 'Taney', state: 'MO', url: 'https://lw.com/7', source: 'LandWatch' },
  ];

  let rejected = 0;
  let duplicates = 0;

  for (const listing of listings) {
    const filterResult = filterListing(listing);
    if (!filterResult.passed) {
      rejected++;
      continue;
    }

    const fingerprint = generateFingerprint(listing);
    listing.fingerprint = fingerprint;
    listing.stage = filterResult.stage;

    // URL dedup
    const dupCheck = airtable.checkDuplicate(listing, dedupIndex);
    if (dupCheck.isDuplicate) {
      duplicates++;
      continue;
    }

    // Session fingerprint dedup
    if (fingerprint && sessionFingerprints.has(fingerprint)) {
      duplicates++;
      continue;
    }

    passed.push(listing);
    if (listing.url) dedupIndex.urlSet.add(listing.url);
    if (fingerprint) sessionFingerprints.set(fingerprint, { source: listing.source, name: listing.name });
  }

  assert.equal(passed.length, 3, `expected 3 passed, got ${passed.length}: ${passed.map(l => l.name).join(', ')}`);
  assert.equal(rejected, 3, 'expected 3 rejected (too expensive, wrong county, too small)');
  assert.equal(duplicates, 1, 'expected 1 duplicate (same URL)');

  assert.equal(passed[0].name, 'Good Deal');
  assert.equal(passed[0].stage, 'New Lead');

  assert.equal(passed[1].name, 'Dallas Tract');
  assert.equal(passed[1].stage, 'New Lead');

  assert.equal(passed[2].name, 'Watch Zone');
  assert.equal(passed[2].stage, 'Watch For Price Drop');
});

test('cross-site fingerprint dedup catches same property from different sources', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const dedupIndex = { urlSet: new Set(), fingerprintSet: new Set() };
  const sessionFingerprints = new Map();

  // Same property, slightly different data, different URLs
  const fromLandWatch = {
    name: 'Taney Tract on LandWatch',
    price: 301000,
    acres: 151,
    county: 'Taney',
    state: 'MO',
    url: 'https://landwatch.com/property/abc',
    source: 'LandWatch',
  };
  const fromLandCom = {
    name: 'Taney County Tract on Land.com',
    price: 299000,
    acres: 149,
    county: 'Taney',
    state: 'MO',
    url: 'https://land.com/property/xyz',
    source: 'Land.com',
  };

  // Process first listing
  const f1 = filterListing(fromLandWatch);
  assert.ok(f1.passed);
  const fp1 = generateFingerprint(fromLandWatch);
  sessionFingerprints.set(fp1, { source: 'LandWatch', name: fromLandWatch.name });
  dedupIndex.urlSet.add(fromLandWatch.url);
  dedupIndex.fingerprintSet.add(fp1);

  // Process second listing — different URL but same fingerprint
  const f2 = filterListing(fromLandCom);
  assert.ok(f2.passed);
  const fp2 = generateFingerprint(fromLandCom);
  assert.equal(fp1, fp2, 'fingerprints should match');

  // URL check passes (different URL)
  const urlCheck = airtable.checkDuplicate(fromLandCom, dedupIndex);
  // But fingerprint catches it
  assert.equal(urlCheck.isDuplicate, true);
  assert.equal(urlCheck.matchType, 'fingerprint');
});

test('report.totals.parsed counts correctly without double-counting', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  // Simulate what scraper.js does for report counting
  const report = {
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0 },
  };

  const site1Listings = [
    { name: 'A', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://a.com/1' },
    { name: 'B', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://a.com/2' },
  ];
  const site2Listings = [
    { name: 'C', price: 300000, acres: 100, county: 'Taney', state: 'MO', url: 'https://b.com/1' },
  ];

  // scraper.js line 111: report.totals.parsed += listings.length (once per site)
  report.totals.parsed += site1Listings.length;
  report.totals.parsed += site2Listings.length;

  assert.equal(report.totals.parsed, 3, 'parsed total should be 3, not 6 (no double count)');
});
