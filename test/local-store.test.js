'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLocalCountyTargets } = require('../lib/local-store');

test('loadLocalCountyTargets builds county lookup from local config', () => {
  const targets = loadLocalCountyTargets();

  assert.ok(targets.counties.length > 0);
  assert.equal(targets.source, 'local-config');
  assert.equal(targets.countyMap.get('taney|MO'), 4000);
  assert.equal(targets.countyMap.get('wayne|KY'), 1850);
});
