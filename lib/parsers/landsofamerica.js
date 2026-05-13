'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

class LandsOfAmericaParser extends BaseParser {
  constructor() {
    super('LandsOfAmerica');
    this.baseUrl = 'https://www.landsofamerica.com';
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = county.toLowerCase().replace(/\s+/g, '-');
      // Pass 1: all 40+ acre listings, sort by newest
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: `${this.baseUrl}/property/${stateSlug}/${countySlug}-county/land-for-sale?minAcres=40&sort=newest&page=${page}`,
          county,
          state,
          page,
        });
      }
      // Pass 2: large tracts (150+ acres) — catches older listings pushed off the main pages
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: `${this.baseUrl}/property/${stateSlug}/${countySlug}-county/land-for-sale?minAcres=${largeTractMin}&sort=newest&page=${page}`,
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

    $('[data-testid="property-card"], .property-card, .listing-card').each((_, el) => {
      try {
        const $el = $(el);

        const name = $el.find('.property-name, .listing-title, h2, h3').first().text().trim();
        const priceText = $el.find('.property-price, .price').first().text();
        const acresText = $el.find('.property-acres, .acres').first().text();
        const href = $el.find('a[href*="/property/"]').first().attr('href');

        const price = this.parsePrice(priceText);
        const acres = this.parseAcres(acresText);
        const url = href ? (href.startsWith('http') ? href : `${this.baseUrl}${href}`) : null;

        const description = $el.find('.property-description, .description').first().text().trim();

        const lat = $el.attr('data-lat');
        const lng = $el.attr('data-lon') || $el.attr('data-lng');
        const coordinates = lat && lng ? `${lat}, ${lng}` : null;

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
            coordinates,
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

module.exports = LandsOfAmericaParser;
