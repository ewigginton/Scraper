'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPriceFromStructuredData } = require('../lib/price-extractor');
const { runPriceCheck } = require('../lib/price-checker');
const airtable = require('../lib/airtable');

test('extractPriceFromStructuredData handles @graph data', () => {
  const price = extractPriceFromStructuredData({
    '@graph': [
      { '@type': 'WebPage' },
      { '@type': 'Product', offers: { price: '$725,000' } },
    ],
  });

  assert.equal(price, 725000);
});

test('extractPriceFromStructuredData reads offers arrays', () => {
  const price = extractPriceFromStructuredData({
    '@type': 'Product',
    offers: [{ price: '349000' }],
  });

  assert.equal(price, 349000);
});

test('runPriceCheck skips Airtable read failures during dry runs', async () => {
  const originalGetRecordsByStage = airtable.getRecordsByStage;
  airtable.getRecordsByStage = async () => {
    throw new Error('Missing AIRTABLE_LAND_TOKEN or AIRTABLE_BASE_ID in environment');
  };

  try {
    const report = await runPriceCheck({ dryRun: true });
    assert.equal(report.checked, 0);
    assert.equal(report.errors, 1);
    assert.equal(report.details[0].action, 'skipped');
  } finally {
    airtable.getRecordsByStage = originalGetRecordsByStage;
  }
});

test('runPriceCheck still fails Airtable read failures outside dry runs', async () => {
  const originalGetRecordsByStage = airtable.getRecordsByStage;
  airtable.getRecordsByStage = async () => {
    throw new Error('Airtable is unavailable');
  };

  try {
    await assert.rejects(() => runPriceCheck({ dryRun: false }), /Airtable is unavailable/);
  } finally {
    airtable.getRecordsByStage = originalGetRecordsByStage;
  }
});
