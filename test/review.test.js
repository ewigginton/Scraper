'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeLead } = require('../lib/review');
const airtable = require('../lib/airtable');
const { initFilter } = require('../lib/filter');

// B4(a): a large tract (over settings.review.preferredAcresMax) must get
// full size-scoring credit, same as a tract squarely inside the
// preferred min-max window — Emma's business favors large tracts, and the
// old scoring only gave half credit above preferredAcresMax, so large
// tracts almost never scored high enough to appear as standouts.
test('size scoring: a tract at/above preferredAcresMin gets full credit even when it is far above preferredAcresMax', () => {
  initFilter(new Map([['taney|MO', 4000]]));

  const base = (acres, price) => ({
    id: 'recX',
    fields: {
      Name: 'Big Tract',
      [airtable.FIELDS.acres]: acres,
      [airtable.FIELDS.price]: price,
      [airtable.FIELDS.cpaFormula]: `$${Math.round(price / acres)}`,
      [airtable.FIELDS.notes]: '',
    },
  });

  // 250ac — squarely inside the old 150-400 "sweet spot"
  const preferred = analyzeLead(base(250, 250 * 4000), { county: 'Taney', state: 'MO' });
  // 900ac — far above preferredAcresMax (400), at the same $/acre (so
  // pricing score is identical) — size credit must now match, not be half.
  const large = analyzeLead(base(900, 900 * 4000), { county: 'Taney', state: 'MO' });

  assert.equal(preferred.sizeClass, 'preferred');
  assert.equal(large.sizeClass, 'large');
  // Same pricing input, same positives (none) — the only thing that could
  // differ is the size-score term, and it must not.
  assert.equal(large.score, preferred.score, 'a large tract must score the same size credit as a preferred-range tract at the same price point');
});

test('size scoring: a small tract (below smallAcresMax) still gets only the reduced/no credit', () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    id: 'recY',
    fields: {
      Name: 'Small Tract',
      [airtable.FIELDS.acres]: 20,
      [airtable.FIELDS.price]: 20 * 4000,
      [airtable.FIELDS.cpaFormula]: '$4000',
      [airtable.FIELDS.notes]: '',
    },
  };
  const analysis = analyzeLead(record, { county: 'Taney', state: 'MO' });
  assert.equal(analysis.sizeClass, 'small');
});

// B4(b): a record whose price/acreage fails lib/plausibility.js's checks
// must be marked implausible and excluded from standout consideration —
// the standout list was flooded by $1/acre-style garbage before this check.
test('a record with impossible price/acreage is flagged implausible, regardless of its raw score', () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    id: 'recZ',
    fields: {
      Name: 'Garbage Tract',
      // 300ac at $300 total — a $1/acre listing, the exact pattern that
      // flooded the standout list (see lib/plausibility.js MIN_CPA).
      [airtable.FIELDS.acres]: 300,
      [airtable.FIELDS.price]: 300,
      [airtable.FIELDS.cpaFormula]: '$1',
      [airtable.FIELDS.notes]: 'paved road frontage, cleared, pond, fenced',
    },
  };
  const analysis = analyzeLead(record, { county: 'Taney', state: 'MO' });
  assert.equal(analysis.implausible, true);
  assert.ok(analysis.implausibilityProblems.length > 0);
  assert.match(analysis.implausibilityProblems[0], /plausible range/);
});

test('a plausible, well-priced large tract with positives is NOT flagged implausible', () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    id: 'recW',
    fields: {
      Name: 'Good Tract',
      [airtable.FIELDS.acres]: 500,
      [airtable.FIELDS.price]: 500 * 3000, // below the $4000/ac target
      [airtable.FIELDS.cpaFormula]: '$3000',
      [airtable.FIELDS.notes]: 'paved road frontage, cleared, pond, fenced',
    },
  };
  const analysis = analyzeLead(record, { county: 'Taney', state: 'MO' });
  assert.equal(analysis.implausible, false);
  assert.equal(analysis.implausibilityProblems.length, 0);
  assert.ok(analysis.score >= 3, 'should score high enough to be a standout candidate');
});

// A record missing Acres entirely must NOT be treated as "0 acres" (which
// would fail the >0 plausibility check) — isPresent-style checks must see
// the raw (absent) field, not the `|| 0`-defaulted value used for scoring.
test('a record with no Acres value at all is not wrongly flagged implausible', () => {
  initFilter(new Map([['taney|MO', 4000]]));
  const record = {
    id: 'recV',
    fields: {
      Name: 'No Acres Yet',
      [airtable.FIELDS.price]: 100000,
      [airtable.FIELDS.cpaFormula]: '',
      [airtable.FIELDS.notes]: '',
    },
  };
  const analysis = analyzeLead(record, { county: 'Taney', state: 'MO' });
  assert.equal(analysis.implausible, false);
});
