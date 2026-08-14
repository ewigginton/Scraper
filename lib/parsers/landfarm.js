'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

class LandAndFarmParser extends BaseParser {
  constructor() {
    super('LandAndFarm');
    this.baseUrl = 'https://www.landandfarm.com';
    // Search URLs carry sort=newest (see buildSearchUrls) → newest first, so
    // deeper pages are strictly older inventory: eligible for early-stop.
    this.resultsSortedNewestFirst = true;
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      // Pass 1: all 40+ acre listings, sort by newest
      for (let page = 1; page <= 3; page++) {
        urls.push({
          url: `${this.baseUrl}/search/${stateSlug}/${countySlug}-county/land-for-sale?minAcres=40&sort=newest&page=${page}`,
          county,
          state,
          page,
        });
      }
      // Pass 2: large tracts (150+ acres) — catches older listings pushed off the main pages
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: `${this.baseUrl}/search/${stateSlug}/${countySlug}-county/land-for-sale?minAcres=${largeTractMin}&sort=newest&page=${page}`,
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
   * than named selectors — same reasoning as the Land.com parser: the old
   * '.search-result' / '.result-price' selectors were guessed, never
   * confirmed against captured markup, and a wrong guess makes the source
   * report zero listings indefinitely while appearing healthy.
   */
  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    return this.extractByDetailLinks($, {
      // LandAndFarm detail pages live under /property/{slug}. Search pages
      // sit under /search/... so they cannot be mistaken for listings.
      hrefPattern: /\/property\/[^/?#]+/i,
      county,
      state,
      verifyCounty: true,
    });
  }

}

module.exports = LandAndFarmParser;
