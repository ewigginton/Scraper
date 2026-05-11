'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPriceFromStructuredData } = require('../lib/price-extractor');

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
