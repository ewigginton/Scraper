'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

/**
 * Whitetail Properties — rural/hunting land brokerage, heavy in CCL's
 * target states, with inventory that never appears on the CoStar sites.
 *
 * URL shape (verified from indexed pages):
 *   /hunting-land/{state}/{county}          — county search page
 *   /hunting-land/{state}/{county}/{slug}   — listing detail page
 * County slugs spell out "saint" (saint-francois, not st-francois).
 *
 * Parsing uses the generic detail-link engine in BaseParser: exact card
 * markup is unverified, so extraction is class-name agnostic and markup
 * drift on page 1 raises a source-health alert with an HTML snapshot.
 */
class WhitetailParser extends BaseParser {
  constructor() {
    super('WhitetailProperties');
    this.baseUrl = 'https://www.whitetailproperties.com';
  }

  countySlug(county) {
    const expanded = String(county)
      .replace(/^st\.?\s+/i, 'Saint ')
      .replace(/^ste\.?\s+/i, 'Sainte ');
    return super.countySlug(expanded);
  }

  buildSearchUrls(counties) {
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: page === 1
            ? `${this.baseUrl}/hunting-land/${stateSlug}/${countySlug}`
            : `${this.baseUrl}/hunting-land/${stateSlug}/${countySlug}?page=${page}`,
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
      // Detail pages have 3+ path segments under /hunting-land/
      hrefPattern: /\/hunting-land\/[^/]+\/[^/]+\/[^/?#]+/i,
      county,
      state,
      verifyCounty: true,
    });
  }
}

module.exports = WhitetailParser;
