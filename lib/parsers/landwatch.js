'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

class LandWatchParser extends BaseParser {
  constructor() {
    super('LandWatch');
    this.baseUrl = 'https://www.landwatch.com';
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;
    const urls = [];
    for (const { county, state, maxCPA } of counties) {
      // LandWatch URL format: /STATE/COUNTY-county/land-for-sale
      const stateSlug = stateSlugLower(state);
      const countySlug = county.toLowerCase().replace(/\s+/g, '-');
      // Pass 1: all 40+ acre listings, sort by newest
      for (let page = 1; page <= 5; page++) {
        urls.push({
          url: `${this.baseUrl}/${stateSlug}/${countySlug}-county/land-for-sale?minAcreage=40&sort=date_desc&page=${page}`,
          county,
          state,
          page,
        });
      }
      // Pass 2: large tracts (150+ acres) — catches older listings pushed off the main pages
      for (let page = 1; page <= 3; page++) {
        urls.push({
          url: `${this.baseUrl}/${stateSlug}/${countySlug}-county/land-for-sale?minAcreage=${largeTractMin}&sort=date_desc&page=${page}`,
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

    // LandWatch uses structured listing cards
    $('[data-testid="listing-card"], .listing-card, .property-card').each((_, el) => {
      try {
        const $el = $(el);

        const name = $el.find('.listing-title, .property-title, h2, h3').first().text().trim();
        const priceText = $el.find('.price, .listing-price, [data-testid="price"]').first().text();
        const acresText = $el.find('.acres, .listing-acres, [data-testid="acres"]').first().text();
        const linkEl = $el.find('a[href*="/land/"]').first();
        const href = linkEl.attr('href');

        const price = this.parsePrice(priceText);
        const acres = this.parseAcres(acresText);
        const url = href ? (href.startsWith('http') ? href : `${this.baseUrl}${href}`) : null;

        // Extract price per acre if shown
        const cpaText = $el.find('.price-per-acre, [data-testid="price-per-acre"]').first().text();
        const pricePerAcre = this.parsePrice(cpaText);

        // Extract description snippet
        const description = $el.find('.description, .listing-description, p').first().text().trim();

        // Extract days on market if shown
        const domText = $el.find('.days-on-market, .dom').first().text();
        const domMatch = domText.match(/(\d+)/);
        const daysOnMarket = domMatch ? parseInt(domMatch[1]) : null;

        // Extract coordinates from data attributes
        const lat = $el.attr('data-lat') || $el.find('[data-lat]').attr('data-lat');
        const lng = $el.attr('data-lng') || $el.find('[data-lng]').attr('data-lng');
        const coordinates = lat && lng ? `${lat}, ${lng}` : null;

        if (price && acres && url) {
          listings.push({
            name: name || `${county} County Land`,
            price,
            acres,
            pricePerAcre,
            county,
            state,
            url,
            description,
            coordinates,
            daysOnMarket,
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

module.exports = LandWatchParser;
