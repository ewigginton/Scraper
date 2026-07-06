'use strict';

const fetch = require('node-fetch');
const settings = require('../../config/settings.json');
const { persistSourceIssue, persistHtmlSnapshot } = require('../local-store');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Bot-management vendors (Imperva/Cloudflare/PerimeterX/etc.) serve their
// challenge pages with HTTP 200, so a "successful" fetch can still be a
// block. These markers distinguish a challenge from a real results page.
const BLOCK_MARKERS = [
  'just a moment',
  'access denied',
  'incapsula',
  '_incapsula_resource',
  'perimeterx',
  'px-captcha',
  'cf-browser-verification',
  'cf-challenge',
  'attention required',
  'request unsuccessful',
  'verify you are a human',
  'are you a robot',
  'enable javascript and cookies to continue',
];

// Phrases sites use on genuinely empty result pages. If a page parses to
// zero listings and has none of these, the markup probably changed.
const EMPTY_RESULTS_MARKERS = [
  'no results',
  'no properties',
  'no listings',
  'no land for sale',
  '0 results',
  '0 properties',
  'nothing matched',
  'try adjusting',
  'no matches',
];

class BaseParser {
  constructor(name) {
    this.name = name;
    this.stats = { checked: 0, parsed: 0, errors: 0, blockedPages: 0, driftPages: 0 };
    this.sourceIssues = [];
  }

  /**
   * Fetch a URL with retries and delay.
   */
  async fetchPage(url) {
    const maxRetries = parsePositiveInt(process.env.SCRAPER_MAX_RETRIES, settings.scraper.maxRetries);
    const requestTimeoutMs = parsePositiveInt(process.env.SCRAPER_REQUEST_TIMEOUT_MS, settings.scraper.requestTimeoutMs);
    const retryDelayMs = parsePositiveInt(process.env.SCRAPER_RETRY_DELAY_MS, settings.scraper.retryDelayMs);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(url, {
          headers: this.getHeaders(),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = new Error(`HTTP ${response.status} for ${url}`);
          err.status = response.status;
          throw err;
        }

        return await response.text();
      } catch (err) {
        // 4xx (except 429) fails identically every time — retrying a 404
        // county URL just burns time, and retrying a 403 with the same
        // fingerprint amplifies block signals
        const retryable = typeof err.status !== 'number' || err.status === 429 || err.status >= 500;
        if (!retryable || attempt === maxRetries - 1) throw err;

        // Exponential backoff with jitter; back off harder when rate-limited
        const base = retryDelayMs * Math.pow(2, attempt) * (err.status === 429 ? 2 : 1);
        await this.sleep(base + Math.floor(Math.random() * retryDelayMs));
      } finally {
        clearTimeout(timeout);
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
   * True when the HTML is a bot-management challenge page rather than
   * site content.
   */
  isBlockedPage(html) {
    if (!html) return false;
    const sample = html.slice(0, 20000).toLowerCase();
    return BLOCK_MARKERS.some(marker => sample.includes(marker));
  }

  /**
   * True when a zero-listing page looks like a genuinely empty results page
   * (site said "no results") rather than changed markup.
   */
  looksLikeEmptyResults(html) {
    if (!html) return false;
    const lower = html.toLowerCase();
    return EMPTY_RESULTS_MARKERS.some(marker => lower.includes(marker));
  }

  /**
   * Main scrape loop: fetch all pages for all counties, return parsed listings.
   */
  async scrapeAll(counties) {
    this._counties = counties; // some parsers need the target list at parse time
    const listings = [];
    const maxPage = parsePositiveInt(process.env.SCRAPER_MAX_PAGE, null);
    const requestDelayMs = parsePositiveInt(process.env.SCRAPER_REQUEST_DELAY_MS, settings.scraper.requestDelayMs);
    const searchUrls = this.buildSearchUrls(counties)
      .filter(item => !maxPage || !item.page || item.page <= maxPage);
    const exhaustedSeries = new Set();

    for (const { url, county, state, page } of searchUrls) {
      const seriesKey = this.paginationSeriesKey(url, county, state);
      if (exhaustedSeries.has(seriesKey)) {
        continue;
      }

      try {
        // Jittered delay — a metronomic request cadence is an easy bot signature
        await this.sleep(requestDelayMs * (0.75 + Math.random() * 1.25));
        const html = await this.fetchPage(url);
        this.stats.checked++;

        // A challenge page parses to zero listings and would otherwise be
        // indistinguishable from "no results tonight"
        if (this.isBlockedPage(html)) {
          this.stats.errors++;
          this.stats.blockedPages++;
          const savedTo = this.recordSourceIssue({
            type: 'blocked',
            url,
            county,
            state,
            page: page || null,
            error: 'Bot-block/challenge page served with HTTP 200',
          }, html);
          console.error(`[${this.name}] BLOCKED at ${url}${savedTo ? ` (evidence: ${savedTo})` : ''}`);
          exhaustedSeries.add(seriesKey); // don't hammer a blocking site
          continue;
        }

        const parsed = this.parseSearchPage(html, county, state);
        this.stats.parsed += parsed.length;

        for (const listing of parsed) {
          listing.source = this.name;
          listings.push(listing);
        }

        if (parsed.length === 0) {
          // Zero listings on page 1 of a series with no "no results" text is
          // the signature of changed markup — selectors matching nothing on a
          // live page. Deeper pages hitting zero is normal pagination end.
          if ((page || 1) === 1 && !this.looksLikeEmptyResults(html)) {
            this.stats.driftPages++;
            const savedTo = this.recordSourceIssue({
              type: 'markup_drift',
              url,
              county,
              state,
              page: page || null,
              error: 'Page fetched OK but zero listings parsed and no "no results" marker found — selectors may be stale',
            }, html);
            console.warn(`[${this.name}] Possible markup drift at ${url}${savedTo ? ` (evidence: ${savedTo})` : ''}`);
          }
          exhaustedSeries.add(seriesKey);
        }
      } catch (err) {
        this.stats.errors++;
        const issueType = err.status === 403 || err.status === 429 ? 'blocked' : 'fetch_or_parse_error';
        if (issueType === 'blocked') this.stats.blockedPages++;
        const savedTo = this.recordSourceIssue({
          type: issueType,
          url,
          county,
          state,
          page: page || null,
          error: err.message,
        });
        console.error(`[${this.name}] Error fetching ${url}: ${err.message}${savedTo ? ` (saved: ${savedTo})` : ''}`);
      }
    }

    return listings;
  }

  recordSourceIssue(issue, html = null) {
    const fullIssue = {
      source: this.name,
      ...issue,
    };
    let savedTo = null;
    try {
      savedTo = persistSourceIssue(fullIssue);
      if (html) {
        const snapshotPath = persistHtmlSnapshot(this.name, html);
        if (snapshotPath) fullIssue.snapshot = snapshotPath;
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to save source issue evidence: ${err.message}`);
    }
    this.sourceIssues.push({ ...fullIssue, savedTo });
    return savedTo;
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
   * URL slug for a county name. Strips punctuation ("St. Clair" → "st-clair",
   * "O'Brien" → "obrien") — leaving it in produces 404s on every page.
   */
  countySlug(county) {
    return String(county)
      .toLowerCase()
      .replace(/[.'’]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
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

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = BaseParser;
