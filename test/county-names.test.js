'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalCountyName, collapseKey } = require('../lib/county-names');
const LandWatchParser = require('../lib/parsers/landwatch');
const MossyOakParser = require('../lib/parsers/mossyoak');
const WhitetailParser = require('../lib/parsers/whitetail');

test('canonicalCountyName restores the space Airtable collapsed', () => {
  // The production bug: Airtable stores "LeFlore", so countySlug produced
  // "leflore" and LandWatch 400'd /oklahoma-land-for-sale/leflore-county on
  // the Aug 6 and Aug 9 nightlies.
  assert.equal(canonicalCountyName('LeFlore', 'OK'), 'Le Flore');
  assert.equal(canonicalCountyName('leflore', 'OK'), 'Le Flore');
  assert.equal(canonicalCountyName('Le Flore', 'OK'), 'Le Flore');
});

test('canonicalCountyName covers every multi-word target county', () => {
  // All nine carry the same collapse risk as Le Flore did.
  const cases = [
    ['redriver', 'TX', 'Red River'],
    ['sanaugustine', 'TX', 'San Augustine'],
    ['sanjacinto', 'TX', 'San Jacinto'],
    ['vanzandt', 'TX', 'Van Zandt'],
    ['hotspring', 'AR', 'Hot Spring'],
    ['vanburen', 'AR', 'Van Buren'],
    ['vanburen', 'TN', 'Van Buren'],
  ];
  for (const [collapsed, state, expected] of cases) {
    assert.equal(canonicalCountyName(collapsed, state), expected,
      `${collapsed} (${state}) should canonicalize to ${expected}`);
  }
});

test('canonicalCountyName never invents a spelling for a one-word county', () => {
  // A general camel-case splitting rule would corrupt these into "Mc Creary"
  // / "Mc Donald"; they are genuinely one word and must pass through.
  assert.equal(canonicalCountyName('McCreary', 'KY'), 'McCreary');
  assert.equal(canonicalCountyName('McDonald', 'MO'), 'McDonald');
  assert.equal(canonicalCountyName('Wayne', 'KY'), 'Wayne');
});

test('canonicalCountyName leaves unknown counties exactly as written', () => {
  assert.equal(canonicalCountyName('Nowhere', 'KY'), 'Nowhere');
  assert.equal(canonicalCountyName('', 'KY'), '');
  assert.equal(canonicalCountyName(null, 'KY'), null);
});

test('canonicalCountyName respects state — Leflore MS is not Le Flore OK', () => {
  // Two real, DIFFERENT counties whose names collapse to the same key, and
  // both states are in the target list. Rewriting one into the other would
  // point Mississippi requests at an Oklahoma URL.
  assert.equal(canonicalCountyName('Leflore', 'MS'), 'Leflore');
  assert.equal(canonicalCountyName('Le Flore', 'OK'), 'Le Flore');
});

test('canonicalCountyName without a state only resolves unambiguous names', () => {
  assert.equal(canonicalCountyName('vanzandt'), 'Van Zandt');
  assert.equal(canonicalCountyName('McCreary'), 'McCreary');
});

test('collapseKey ignores County/Parish suffixes and punctuation', () => {
  assert.equal(collapseKey('Le Flore County'), 'leflore');
  assert.equal(collapseKey('St. Clair'), 'stclair');
  assert.equal(collapseKey('LeFlore'), 'leflore');
});

test('the canonical name produces each site own confirmed slug convention', () => {
  // The whole reason this normalization lives at the county-target load and
  // NOT in countySlug: the sites disagree on purpose. LandWatch serves
  // mccreary-county (test/fixtures/landwatch-search.html) while MossyOak
  // serves mc-creary-county (captured OK county-links evidence). Normalizing
  // the NAME must not disturb either rule.
  const landwatch = new LandWatchParser();
  const mossyoak = new MossyOakParser();
  const whitetail = new WhitetailParser();

  const leFlore = canonicalCountyName('LeFlore', 'OK');
  assert.equal(landwatch.countySlug(leFlore), 'le-flore', 'the URL that 400d is now correct');
  assert.equal(mossyoak.countySlug(leFlore), 'le-flore');
  assert.equal(whitetail.countySlug(leFlore), 'le-flore');

  const mcCreary = canonicalCountyName('McCreary', 'KY');
  assert.equal(landwatch.countySlug(mcCreary), 'mccreary', 'LandWatch does NOT hyphenate Mc');
  assert.equal(mossyoak.countySlug(mcCreary), 'mc-creary', 'MossyOak DOES hyphenate Mc');

  // Whitetail spells out Saint; canonicalization must not disturb that either.
  assert.equal(whitetail.countySlug(canonicalCountyName('St. Clair', 'AL')), 'saint-clair');
});
