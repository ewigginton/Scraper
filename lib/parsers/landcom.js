'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugTitle } = require('../states');

class LandComParser extends BaseParser {
  constructor() {
    super('Land.com');
    this.baseUrl = 'https://www.land.com';
    // Search URLs use the /date-posted/ sort segment (see buildSearchUrls) →
    // most-recently-posted first, so deeper pages are strictly older
    // inventory: eligible for early-stop.
    this.resultsSortedNewestFirst = true;
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugTitle(state);
      const countySlug = this.countySlug(county);
      // Pass 1: all 40+ acre listings, sort by date posted
      for (let page = 1; page <= 5; page++) {
        urls.push({
          url: `${this.baseUrl}/${stateSlug}/${countySlug}-county/land-over-40-acres/all-land/date-posted/page-${page}`,
          county,
          state,
          page,
        });
      }
      // Pass 2: large tracts (150+ acres) — catches older listings pushed off the main pages
      for (let page = 1; page <= 3; page++) {
        urls.push({
          url: `${this.baseUrl}/${stateSlug}/${countySlug}-county/land-over-${largeTractMin}-acres/all-land/date-posted/page-${page}`,
          county,
          state,
          page,
        });
      }
    }
    return urls;
  }

  /**
   * Cards are read with the class-name-agnostic detail-link engine rather
   * than named selectors.
   *
   * The previous implementation matched '.property-card', '.listing-item',
   * '.property-price' and friends — plausible-sounding names that were never
   * verified against a captured page. Real listing sites ship obfuscated,
   * build-generated class names (the captured LandWatch markup uses
   * '.sBMpXMAWt' for its price), so hand-guessed selectors match nothing and
   * the source reports zero listings forever while looking healthy. This
   * source has no fixture yet, which is exactly when guessing costs most.
   *
   * extractByDetailLinks depends only on things that are structural rather
   * than cosmetic: links pointing at a detail page, and price + acreage text
   * inside the card. See BaseParser#extractByDetailLinks.
   */
  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    return this.extractByDetailLinks($, {
      // Land.com detail pages live under /property/{slug}-{id}; the search
      // page itself sits at /{state}/{county}-county/... so the county and
      // filter pages can never be mistaken for listings.
      hrefPattern: /\/(?:property|listing)\/[^/?#]+/i,
      county,
      state,
      verifyCounty: true,
    });
  }

}

module.exports = LandComParser;
