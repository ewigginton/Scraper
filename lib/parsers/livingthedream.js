'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');

class LivingTheDreamParser extends BaseParser {
  constructor() {
    super('LivingTheDreamLand');
    this.baseUrl = 'https://www.livingthedreamland.com';
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;

    // Store counties for use in parseSearchPage
    this._counties = counties;

    const urls = [];
    // LivingTheDream is a smaller independent site — search by state only
    const states = [...new Set(counties.map(c => c.state))];
    for (const state of states) {
      const stateSlug = state.toLowerCase();
      // Pass 1: all 40+ acre listings, sort by newest
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: `${this.baseUrl}/properties?state=${stateSlug}&min_acres=40&sort=newest&page=${page}`,
          county: null, // We'll extract county from each listing
          state,
          page,
        });
      }
      // Pass 2: large tracts (150+ acres) — catches older listings pushed off the main pages
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: `${this.baseUrl}/properties?state=${stateSlug}&min_acres=${largeTractMin}&sort=newest&page=${page}`,
          county: null,
          state,
          page,
        });
      }
    }
    return urls;
  }

  parseSearchPage(html, defaultCounty, state) {
    const $ = cheerio.load(html);
    const listings = [];

    // Build a set of target counties for this state for fast lookup
    const targetCounties = new Set(
      (this._counties || [])
        .filter(c => c.state.toUpperCase() === state.toUpperCase())
        .map(c => c.county.toLowerCase())
    );

    const $cards = $('.property-listing, .listing-item, .property-card');
    this._lastCardCount = $cards.length;
    $cards.each((_, el) => {
      try {
        const $el = $(el);

        const name = $el.find('.property-title, h2, h3').first().text().trim();
        const priceText = $el.find('.property-price, .price').first().text();
        const acresText = $el.find('.property-acres, .acres').first().text();
        const href = $el.find('a[href*="/propert"]').first().attr('href');

        // Extract county from location text
        const locationText = $el.find('.property-location, .location').first().text();
        const county = this.extractCounty(locationText, targetCounties);

        const price = this.parsePrice(priceText);
        const acres = this.parseAcres(acresText);
        const url = href ? (href.startsWith('http') ? href : `${this.baseUrl}${href}`) : null;

        const description = $el.find('.property-description, .description').first().text().trim();

        if (price && acres && url && county) {
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

  /**
   * Try to extract a target county name from location text like "Smith County, TX"
   */
  extractCounty(text, targetCounties) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const county of targetCounties) {
      if (lower.includes(county)) return this.titleCase(county);
    }
    const match = text.match(/(\w[\w\s]*?)\s*county/i);
    if (match) {
      const name = match[1].trim().toLowerCase();
      if (targetCounties.has(name)) return this.titleCase(name);
    }
    return null;
  }

  titleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }
}

module.exports = LivingTheDreamParser;
