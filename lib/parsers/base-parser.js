'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const settings = require('../../config/settings.json');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

class BaseParser {
  constructor(name) {
    this.name = name;
    this.stats = { checked: 0, parsed: 0, errors: 0 };
  }

  /**
   * Fetch a URL with retries and delay.
   */
  async fetchPage(url) {
    const { maxRetries, requestTimeoutMs, retryDelayMs } = settings.scraper;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

        const response = await fetch(url, {
          headers: this.getHeaders(),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${url}`);
        }

        return await response.text();
      } catch (err) {
        if (attempt === maxRetries - 1) throw err;
        await this.sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  /**
   * Override in subclasses to add site-specific headers.
   */
  getHeaders() {
    return { ...DEFAULT_HEADERS };
  }

  /**
   * Build search URLs for all target counties in a state.
   * Override in each site parser.
   */
  buildSearchUrls(counties) {
    throw new Error(`${this.name}: buildSearchUrls not implemented`);
  }

  /**
   * Parse a search results page into an array of raw listings.
   * Override in each site parser.
   */
  parseSearchPage(html, county, state) {
    throw new Error(`${this.name}: parseSearchPage not implemented`);
  }

  /**
   * Parse a single listing detail page for additional data.
   * Optional override — not all sites need this.
   */
  parseDetailPage(html) {
    return {};
  }

  /**
   * Main scrape loop: fetch all pages for all counties, return parsed listings.
   */
  async scrapeAll(counties) {
    const listings = [];
    const searchUrls = this.buildSearchUrls(counties);
    const exhaustedSeries = new Set();

    for (const { url, county, state, page } of searchUrls) {
      const seriesKey = this.paginationSeriesKey(url, county, state);
      if (exhaustedSeries.has(seriesKey)) {
        continue;
      }

      try {
        await this.sleep(settings.scraper.requestDelayMs);
        const html = await this.fetchPage(url);
        this.stats.checked++;

        const parsed = this.parseSearchPage(html, county, state);
        this.stats.parsed += parsed.length;

        for (const listing of parsed) {
          listing.source = this.name;
          listings.push(listing);
        }

        // Stop paginating if no results on this page
        if (parsed.length === 0) {
          exhaustedSeries.add(seriesKey);
        }
      } catch (err) {
        this.stats.errors++;
        console.error(`[${this.name}] Error fetching ${url}: ${err.message}`);
      }
    }

    return listings;
  }

  paginationSeriesKey(url, county, state) {
    return [
      county || '',
      state || '',
      url
        .replace(/([?&])page=\d+/i, '$1page=*')
        .replace(/\/page-\d+/i, '/page-*'),
    ].join('|');
  }

  /**
   * Parse price string like "$1,250,000" or "1250000" into a number.
   */
  parsePrice(priceStr) {
    if (!priceStr) return null;
    const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  /**
   * Parse acreage string like "160 acres" or "160.5" into a number.
   */
  parseAcres(acresStr) {
    if (!acresStr) return null;
    const cleaned = String(acresStr).replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) || num <= 0 ? null : num;
  }

  /**
   * Extract coordinates from text (lat, lng format).
   */
  parseCoordinates(text) {
    if (!text) return null;
    const match = text.match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/);
    if (!match) return null;
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    if (lat < 24 || lat > 50 || lng > -65 || lng < -125) return null; // Continental US bounds
    return `${lat}, ${lng}`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = BaseParser;
