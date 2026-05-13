'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LivingTheDreamParser = require('../lib/parsers/livingthedream');

test('extractCounty title-cases multi-word county names', () => {
  const parser = new LivingTheDreamParser();
  const targets = new Set(['san augustine', 'van zandt']);

  assert.equal(
    parser.extractCounty('Land in San Augustine County, TX', targets),
    'San Augustine',
  );
  assert.equal(
    parser.extractCounty('Property in Van Zandt County', targets),
    'Van Zandt',
  );
});

test('extractCounty title-cases single-word counties', () => {
  const parser = new LivingTheDreamParser();
  const targets = new Set(['anderson']);

  assert.equal(
    parser.extractCounty('Anderson County, TX', targets),
    'Anderson',
  );
});

test('extractCounty returns null for non-target counties', () => {
  const parser = new LivingTheDreamParser();
  const targets = new Set(['anderson']);

  assert.equal(parser.extractCounty('Dallas County, TX', targets), null);
});

test('extractCounty returns null for empty/null input', () => {
  const parser = new LivingTheDreamParser();
  const targets = new Set(['anderson']);

  assert.equal(parser.extractCounty(null, targets), null);
  assert.equal(parser.extractCounty('', targets), null);
});

test('extractCounty matches via "County Name County" regex pattern', () => {
  const parser = new LivingTheDreamParser();
  const targets = new Set(['san augustine']);

  assert.equal(
    parser.extractCounty('Beautiful 50ac in San Augustine County', targets),
    'San Augustine',
  );
});
