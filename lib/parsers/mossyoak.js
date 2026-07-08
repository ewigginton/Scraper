'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

/**
 * Mossy Oak Properties — rural land brokerage franchise network, strong in
 * CCL's target states, independent of the CoStar inventory pool.
 *
 * URL shape (verified from indexed pages):
 *   /land-for-sale/{state}/                       — state page
 *   /land-for-sale/{state}/{county}-county/       — county page
 *   /land-for-sale/{state}/{county}-county/?pg=2  — pagination
 *
 * County pages advertise large "N listings" counts that suggest they mix in
 * nearby inventory, so extraction verifies each card's own county text and
 * drops mismatches (verifyCounty).
 */
class MossyOakParser extends BaseParser {
  constructor() {
    super('MossyOakProperties');
    this.baseUrl = 'https://www.mossyoakproperties.com';
  }

  buildSearchUrls(counties) {
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: page === 1
            ? `${this.baseUrl}/land-for-sale/${stateSlug}/${countySlug}-county/`
            : `${this.baseUrl}/land-for-sale/${stateSlug}/${countySlug}-county/?pg=${page}`,
          county,
          state,
          page,
        });
      }
    }
    return urls;
  }

  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    return this.extractByDetailLinks($, {
      // Property detail links: /property/... , /listing/... , or a path
      // deeper than the county page under /land-for-sale/
      hrefPattern: /(\/property\/|\/listings?\/|\/land-for-sale\/[^/]+\/[^/]+\/[^/?#]+)/i,
      // Never treat other county/region pages as listings
      excludePattern: /-county\/?$|\/land-for-sale\/[^/]+\/?$/i,
      county,
      state,
      verifyCounty: true,
    });
  }
}

module.exports = MossyOakParser;
