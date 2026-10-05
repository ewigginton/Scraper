'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
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

// GUARD 1d (lib/plausibility.js wired into the price checker) — a newly
// fetched price that is implausible against the record's own Acres is
// skipped (never written as the new LP), not promoted/dropped/updated.
test('runPriceCheck skips (does not write) a newly fetched price that is implausible for the record\'s Acres', { timeout: 20000 }, async (t) => {
  // $15,000,000 / 100ac = $150,000/ac — over MAX_CPA, but only 1.5x the
  // stored price, so it clears the EXISTING extraction-sanity check
  // (0.2x-5x) and reaches the new plausibility guard.
  const IMPLAUSIBLE_HTML = `<html><body>
    <script type="application/ld+json">{"@type":"Product","offers":{"price":"15000000"}}</script>
  </body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(IMPLAUSIBLE_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/implausible-reprice`;

  const originalGetRecordsByStage = airtable.getRecordsByStage;
  airtable.getRecordsByStage = async () => [{
    id: 'recWatchImplausible01X',
    fields: {
      Name: 'Implausible Reprice Tract',
      [airtable.FIELDS.url]: url,
      [airtable.FIELDS.price]: 10000000,
      [airtable.FIELDS.acres]: 100,
    },
  }];

  try {
    const report = await runPriceCheck({ dryRun: true });
    assert.equal(report.checked, 1);
    assert.equal(report.implausibleSkipped, 1);
    assert.equal(report.priceDrops, 0);
    assert.equal(report.promoted, 0);
    const detail = report.details.find(d => d.action === 'implausible_skipped');
    assert.ok(detail, 'expected an implausible_skipped detail entry');
    assert.match(detail.reason, /\$150,000\/acre is outside the plausible range/);
  } finally {
    airtable.getRecordsByStage = originalGetRecordsByStage;
  }
});
