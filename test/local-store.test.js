'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLocalCountyTargets, persistSourceIssue } = require('../lib/local-store');

test('loadLocalCountyTargets builds county lookup from local config', () => {
  const targets = loadLocalCountyTargets();

  assert.ok(targets.counties.length > 0);
  assert.equal(targets.source, 'local-config');
  assert.equal(targets.countyMap.get('taney|MO'), 4000);
  assert.equal(targets.countyMap.get('wayne|KY'), 1850);
});

test('persistSourceIssue saves source-health evidence locally', () => {
  const originalDataDir = process.env.SCRAPER_DATA_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-source-health-'));
  process.env.SCRAPER_DATA_DIR = tempDir;

  try {
    const savedTo = persistSourceIssue({
      source: 'TestSource',
      type: 'fetch_or_parse_error',
      url: 'https://example.com/listing',
      error: 'HTTP 403',
    });

    assert.ok(savedTo.startsWith(path.join(tempDir, 'source-health')));
    const lines = fs.readFileSync(savedTo, 'utf8').trim().split('\n');
    const saved = JSON.parse(lines[0]);
    assert.equal(saved.issue.source, 'TestSource');
    assert.equal(saved.issue.error, 'HTTP 403');
  } finally {
    if (originalDataDir === undefined) delete process.env.SCRAPER_DATA_DIR;
    else process.env.SCRAPER_DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
