'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

class LandAndFarmParser extends BaseParser {
  constructor() {
    super('LandAndFarm');
    this.baseUrl = 'https://www.landandfarm.com';
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

  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    const listings = [];

    const $cards = $('.search-result, .listing-card, .property-result');
    this._lastCardCount = $cards.length;
    $cards.each((_, el) => {
      try {
        const $el = $(el);

        const name = $el.find('.result-title, .listing-title, h2, h3').first().text().trim();
        const priceText = $el.find('.result-price, .price').first().text();
        const acresText = $el.find('.result-acres, .acres, .acreage').first().text();
        const href = $el.find('a[href*="/property/"], a[href*="/land/"]').first().attr('href');

        const price = this.parsePrice(priceText);
        const acres = this.parseAcres(acresText);
        const url = href ? (href.startsWith('http') ? href : `${this.baseUrl}${href}`) : null;

        const description = $el.find('.result-description, .description').first().text().trim();

        if (price && acres && url) {
          listings.push({
            name: name || `${county} County Land`,
            price,
            acres,
            pricePerAcre: null,
            county,
            state,
            url,
            description,
            coordinates: null,
            daysOnMarket: null,
          });
        }
      } catch (err) {
        this.stats.errors++;
        console.error(`[${this.name}] Parse error: ${err.message}`);
      }
    });

    return listings;
  }

}

module.exports = LandAndFarmParser;
