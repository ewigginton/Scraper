'use strict';

const fetch = require('node-fetch');
const settings = require('../../config/settings.json');
const browserFetch = require('../browser-fetch');
const { persistSourceIssue, persistHtmlSnapshot } = require('../local-store');

// Full modern-Chrome header set — WAF rules score missing sec-* headers as
// bot signals. (The TLS fingerprint still gives node-fetch away to the
// stricter vendors; the browser fallback below handles those.)
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const { isBlockedHtml } = require('../block-markers');

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

// After this many blocked pages in one run, stop hitting the site entirely —
// continuing just feeds the bot-detector hundreds more identical requests
const BLOCKED_PAGES_ABORT_THRESHOLD = 5;
// Cap HTML evidence snapshots per source per run; a site-wide outage would
// otherwise write hundreds of ~500KB files in one night
const MAX_SNAPSHOTS_PER_RUN = 3;

class BaseParser {
  constructor(name) {
    this.name = name;
    this.stats = { checked: 0, parsed: 0, errors: 0, blockedPages: 0, driftPages: 0, snapshotsSaved: 0, browserFetches: 0 };
    this.sourceIssues = [];
    // parseSearchPage implementations set this to the raw count of card
    // elements matched, BEFORE filtering — it distinguishes "selectors match
    // nothing (markup drift)" from "cards found but none passed filters"
    this._lastCardCount = null;
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
   * Fetch a URL, falling back to a real browser when the plain client is
   * refused outright (HTTP 403). Challenge pages served with HTTP 200 are
   * handled separately in scrapeAll (they're only detectable after parsing).
   */
  async fetchPageSmart(url) {
    try {
      return await this.fetchPage(url);
    } catch (err) {
      if (err.status !== 403 || !browserFetch.isEnabled()) throw err;
      try {
        const html = await this.browserFetch(url);
        console.log(`[${this.name}] Plain fetch got 403 — browser fallback succeeded for ${url}`);
        return html;
      } catch (browserErr) {
        if (browserErr.browserUnavailable) {
          browserFetch.warnUnavailableOnce(this.name);
        } else {
          console.error(`[${this.name}] Browser fallback failed for ${url}: ${browserErr.message.split('\n')[0]}`);
        }
        // Always rethrow the ORIGINAL 403: it keeps the blocked-page
        // accounting (and the per-site circuit breaker) working even when
        // the browser itself is flaky
        throw err;
      }
    }
  }

  /** Browser fetch with stats accounting; overridable in tests. */
  async browserFetch(url) {
    const html = await browserFetch.fetchPageWithBrowser(url);
    this.stats.browserFetches++;
    return html;
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
    return isBlockedHtml(html);
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

      // Circuit breaker: a site serving block pages will keep serving them —
      // abandoning the run beats feeding the detector 300 more requests
      if (this.stats.blockedPages >= BLOCKED_PAGES_ABORT_THRESHOLD) {
        this.recordSourceIssue({
          type: 'site_abandoned',
          url: null,
          county: null,
          state: null,
          page: null,
          error: `Aborted after ${this.stats.blockedPages} blocked pages — remaining counties skipped this run`,
        });
        console.error(`[${this.name}] Aborting run: ${this.stats.blockedPages} blocked pages`);
        break;
      }

      try {
        // Jittered delay — a metronomic request cadence is an easy bot signature
        await this.sleep(requestDelayMs * (0.75 + Math.random() * 1.25));
        let html = await this.fetchPageSmart(url);
        this.stats.checked++;

        this._lastCardCount = null;
        let parsed = this.parseSearchPage(html, county, state);
        let rawCards = this._lastCardCount;

        // Challenge pages arrive as HTTP 200 and parse to zero listings —
        // give the browser one shot at the page before writing it off
        if (parsed.length === 0 && this.isBlockedPage(html) && browserFetch.isEnabled()) {
          try {
            html = await this.browserFetch(url);
            this._lastCardCount = null;
            parsed = this.parseSearchPage(html, county, state);
            rawCards = this._lastCardCount;
            if (parsed.length > 0) {
              console.log(`[${this.name}] Challenge page bypassed via browser for ${url}`);
            }
          } catch (browserErr) {
            if (browserErr.browserUnavailable) browserFetch.warnUnavailableOnce(this.name);
            // fall through — the original challenge HTML is handled below
          }
        }

        this.stats.parsed += parsed.length;

        for (const listing of parsed) {
          listing.source = this.name;
          listings.push(listing);
        }

        if (parsed.length === 0) {
          // The block check runs only on zero-parse pages: challenge pages
          // never contain parseable listings, and real pages that merely
          // mention a bot-vendor string (Imperva injects its script into
          // every page it fronts) must not kill the county series.
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
            exhaustedSeries.add(seriesKey);
            continue;
          }

          // Zero CARD ELEMENTS on page 1 with no "no results" text is the
          // signature of changed markup. Cards that matched but were all
          // filtered out (wrong county, no price) are NOT drift — that's
          // normal for state-wide searches like LivingTheDream.
          const cardsMatched = typeof rawCards === 'number' ? rawCards : 0;
          if ((page || 1) === 1 && cardsMatched === 0 && !this.looksLikeEmptyResults(html)) {
            this.stats.driftPages++;
            const savedTo = this.recordSourceIssue({
              type: 'markup_drift',
              url,
              county,
              state,
              page: page || null,
              error: 'Page fetched OK but zero listing cards matched and no "no results" marker found — selectors may be stale',
            }, html);
            console.warn(`[${this.name}] Possible markup drift at ${url}${savedTo ? ` (evidence: ${savedTo})` : ''}`);
          }
          exhaustedSeries.add(seriesKey);
        }
      } catch (err) {
        this.stats.errors++;
        const issueType = err.status === 403 || err.status === 429 ? 'blocked' : 'fetch_or_parse_error';
        if (issueType === 'blocked') {
          this.stats.blockedPages++;
          exhaustedSeries.add(seriesKey); // don't walk deeper pages of a blocked series
        }
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
      if (html && this.stats.snapshotsSaved < MAX_SNAPSHOTS_PER_RUN) {
        const snapshotPath = persistHtmlSnapshot(this.name, html);
        if (snapshotPath) {
          this.stats.snapshotsSaved++;
          fullIssue.snapshot = snapshotPath;
        }
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
        .replace(/([?&])pg=\d+/i, '$1pg=*')
        .replace(/\/page-\d+/i, '/page-*'),
    ].join('|');
  }

  /**
   * Generic card extraction for sites whose exact markup hasn't been
   * fixture-verified yet: find detail-page anchors, then treat the nearest
   * ancestor containing both a dollar amount and an acreage figure as the
   * listing card. Class-name agnostic, so it survives cosmetic redesigns;
   * markup-drift detection still applies via _lastCardCount.
   *
   * opts: { hrefPattern, excludePattern?, county, state, verifyCounty? }
   */
  extractByDetailLinks($, opts) {
    const { hrefPattern, excludePattern, county, state, verifyCounty } = opts;
    const seen = new Set();
    const listings = [];

    const anchors = $('a[href]').toArray().filter(el => {
      const href = $(el).attr('href') || '';
      if (!hrefPattern.test(href)) return false;
      if (excludePattern && excludePattern.test(href)) return false;
      return true;
    });

    // Unique detail links count as "cards" for drift detection
    this._lastCardCount = new Set(
      anchors.map(el => ($(el).attr('href') || '').split('#')[0].split('?')[0])
    ).size;

    for (const el of anchors) {
      const $a = $(el);
      const href = ($a.attr('href') || '').split('#')[0].split('?')[0];
      if (!href || seen.has(href)) continue;

      // Walk up to the smallest ancestor that carries price + acreage text
      let $container = $a;
      let text = '';
      for (let depth = 0; depth < 4; depth++) {
        $container = $container.parent();
        if (!$container.length) break;
        const candidate = ($container.text() || '').replace(/\s+/g, ' ').trim();
        if (/\$\s?[\d,]{4,}/.test(candidate) && /acres?/i.test(candidate)) {
          text = candidate;
          break;
        }
      }
      if (!text) continue;

      const price = this.extractTotalPrice(text);
      const acres = this.extractAcres(text);
      if (!price || !acres) continue;

      // On sites whose county pages mix in nearby-county inventory, only
      // keep cards whose own location text matches the target county.
      // Rule: if the card mentions "<somewhere> county" at all, the target
      // county (st/saint variants included) must be among the mentions —
      // "county road"-style phrases are excluded from the check.
      if (verifyCounty && county) {
        const normText = ` ${String(text).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
        const mentionsACounty = /\b[a-z]+ county\b(?! road)/.test(normText);
        if (mentionsACounty) {
          const target = normalizeCountyText(county);
          const variants = new Set([
            target,
            target.replace(/^saint /, 'st '),
            target.replace(/^sainte /, 'ste '),
            target.replace(/^st /, 'saint '),
            target.replace(/^ste /, 'sainte '),
          ]);
          const matchesTarget = [...variants].some(v => normText.includes(` ${v} county `));
          if (!matchesTarget) continue;
        }
      }

      seen.add(href);
      const name = ($a.text() || '').replace(/\s+/g, ' ').trim();
      const url = href.startsWith('http') ? href : `${this.baseUrl}${href}`;

      listings.push({
        name: (name || `${county || state} Land`).slice(0, 200),
        price,
        acres,
        pricePerAcre: null,
        county,
        state,
        url,
        description: text.slice(0, 400),
        coordinates: null,
        daysOnMarket: null,
      });
    }

    return listings;
  }

  /**
   * Total price from card text: take the LARGEST dollar amount — a card's
   * total price always exceeds any $/acre figure it also displays.
   */
  extractTotalPrice(text) {
    const amounts = (String(text).match(/\$\s?[\d,]+(?:\.\d+)?/g) || [])
      .map(s => parseFloat(s.replace(/[^0-9.]/g, '')))
      .filter(n => Number.isFinite(n) && n >= 10000);
    return amounts.length ? Math.max(...amounts) : null;
  }

  /**
   * Acreage from card text: handles "160 acres", "155± Acres", "30+/- acres".
   */
  extractAcres(text) {
    const m = String(text).match(/([\d,]+(?:\.\d+)?)\s*(?:±|\+\/-)?\s*acres?\b/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
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

/**
 * Loose county-name comparison for card-level verification:
 * "St. Francois" ≡ "Saint Francois" ≡ "st francois".
 */
function normalizeCountyText(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^st\.?\s+/, 'saint ')
    .replace(/^ste\.?\s+/, 'sainte ')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = BaseParser;
