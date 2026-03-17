'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');

class LandComParser extends BaseParser {
  constructor() {
    super('Land.com');
    this.baseUrl = 'https://www.land.com';
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = this.stateToSlug(state);
      const countySlug = county.toLowerCase().replace(/\s+/g, '-');
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

  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    const listings = [];

    $('.property-card, .listing-item, [data-listing-id]').each((_, el) => {
      try {
        const $el = $(el);

        const name = $el.find('.property-title, .listing-name, h2, h3').first().text().trim();
        const priceText = $el.find('.property-price, .price').first().text();
        const acresText = $el.find('.property-acres, .acres').first().text();
        const href = $el.find('a[href*="/listing/"], a[href*="/property/"]').first().attr('href');

        const price = this.parsePrice(priceText);
        const acres = this.parseAcres(acresText);
        const url = href ? (href.startsWith('http') ? href : `${this.baseUrl}${href}`) : null;

        const cpaText = $el.find('.price-per-acre').first().text();
        const pricePerAcre = this.parsePrice(cpaText);

        const description = $el.find('.property-description, .description').first().text().trim();

        const lat = $el.attr('data-latitude');
        const lng = $el.attr('data-longitude');
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
            daysOnMarket: null,
          });
        }
      } catch (err) {
        this.stats.errors++;
      }
    });

    return listings;
  }

  stateToSlug(abbr) {
    const map = {
      TX: 'Texas', OK: 'Oklahoma', AR: 'Arkansas', AL: 'Alabama',
      KS: 'Kansas', MS: 'Mississippi', MO: 'Missouri', TN: 'Tennessee',
      SC: 'South-Carolina', AZ: 'Arizona', NM: 'New-Mexico',
    };
    return map[abbr.toUpperCase()] || abbr;
  }
}

module.exports = LandComParser;
