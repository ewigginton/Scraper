'use strict';

function extractPriceFromStructuredData(data) {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
    for (const offer of offers) {
      if (offer?.price) {
        const price = parsePriceValue(offer.price);
        if (price !== null) return price;
      }
    }
    if (item.price) {
      const price = parsePriceValue(item.price);
      if (price !== null) return price;
    }
    if (item['@graph']) {
      const price = extractPriceFromStructuredData(item['@graph']);
      if (price !== null) return price;
    }
  }
  return null;
}

function parsePriceValue(value) {
  const num = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return num > 1000 ? num : null;
}

module.exports = {
  extractPriceFromStructuredData,
  parsePriceValue,
};
