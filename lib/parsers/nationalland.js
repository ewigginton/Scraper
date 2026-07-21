'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

/**
 * National Land Realty — a large national rural-land brokerage whose inventory
 * overlaps only partly with the CoStar network, so it surfaces tracts the other
 * sites miss.
 *
 * URL shape (verified from captured HTML — see test fixtures):
 *   /land-for-sale/{state-slug}        — one state's inventory, page 1
 *   /land-for-sale/{state-slug}?page=N — page N (N >= 2)
 *   /listing/{slug}                    — a listing detail page
 * State slug is the lowercase full state name (KY -> "kentucky",
 * NM -> "new-mexico"); stateSlugLower builds it. The site covers ~40 states
 * (confirmed from its nav), so every target state has a page.
 *
 * IMPORTANT — statewide inventory, NO per-county URL: a state page lists EVERY
 * county's inventory and each card carries its own county in a `data-county`
 * attribute, so this parser reads county PER CARD and lets the shared
 * downstream county filter (lib/filter.js) keep only the target-county
 * listings — exactly like LANDFLIP. buildSearchUrls therefore dedupes to ONE
 * series per unique target state (never one per county).
 *
 * IMPORTANT — the search page is a client-rendered React/Mantine SPA: the
 * captured HTML (a headed-browser render, so JS ran) carries fully-populated
 * cards, but a plain HTTP fetch returns only the empty `<div id="root">` shell
 * with zero listings — which the zero-parse path would mis-diagnose as markup
 * drift. So requiresBrowserRender routes this source through the real browser
 * and, when no browser is available, skips it with an explanatory issue instead
 * (same handling as MidwestLandGroup).
 *
 * IMPORTANT — cards are read from their data attributes, not visible prose:
 * each card is a `[data-property]` element carrying name (`data-property`),
 * county (`data-county`), total price (`data-price`, a bare integer), acreage
 * (`data-acres`), detail slug (`data-slug` -> /listing/{slug}), and sale status
 * (`data-status`). Cards whose status is not a live for-sale state (PENDING,
 * SOLD, UNDER CONTRACT, OFF MARKET) are skipped — they are not buyable leads.
 */
class NationalLandRealtyParser extends BaseParser {
  constructor() {
    super('NationalLandRealty');
    this.baseUrl = 'https://nationalland.com';
    // Client-rendered SPA: a plain fetch returns only the empty React shell, so
    // scrapeAll must render this source through the real browser (see class doc).
    this.requiresBrowserRender = true;
    // No crawlable newest-first URL param exists (the sort control is JS-driven),
    // so deeper pages are NOT guaranteed older: incremental early-stop stays off
    // (resultsSortedNewestFirst = base default false).
  }

  /**
   * One search-URL series per UNIQUE target state (deduped), each covering the
   * first STATE_SEARCH_PAGES pages of that state's inventory. The per-county
   * target list only supplies which STATES to sweep; county selection happens
   * downstream in lib/filter.js against each card's own `data-county`.
   * SCRAPER_MAX_PAGE (handled in BaseParser.scrapeAll) can cap the page depth.
   */
  buildSearchUrls(counties) {
    const seenStates = new Set();
    const urls = [];
    for (const { state } of counties) {
      const abbrev = String(state || '').toUpperCase();
      if (!abbrev || seenStates.has(abbrev)) continue;
      seenStates.add(abbrev);

      const stateSlug = stateSlugLower(abbrev);
      for (let page = 1; page <= STATE_SEARCH_PAGES; page++) {
        urls.push({
          url: page === 1
            ? `${this.baseUrl}/land-for-sale/${stateSlug}`
            : `${this.baseUrl}/land-for-sale/${stateSlug}?page=${page}`,
          county: null,
          state: abbrev,
          page,
        });
      }
    }
    return urls;
  }

  /**
   * Parse a state page into raw listings. county comes from each card's
   * `data-county`; the state comes from buildSearchUrls (the page IS one state).
   * Cards with a non-live sale status are skipped. Every real card is counted
   * for markup-drift detection (via _lastCardCount) even if it is status-skipped,
   * so a page full of PENDING listings is not mistaken for changed markup.
   */
  parseSearchPage(html, _county, state) {
    const $ = cheerio.load(html);
    const listings = [];
    let cardCount = 0;

    const stateAbbrev = state ? String(state).toUpperCase() : null;

    $('[data-property]').each((_, el) => {
      const $card = $(el);
      const slug = ($card.attr('data-slug') || '').trim();
      if (!slug) return;

      cardCount++;

      const status = normalizeText($card.attr('data-status'));
      if (isUnavailableStatus(status)) return;

      const name = normalizeText($card.attr('data-property')) || `${this.baseUrl}/listing/${slug}`;
      const county = normalizeText($card.attr('data-county')) || null;

      listings.push({
        name: name.slice(0, 200),
        price: this.parsePrice($card.attr('data-price')),
        acres: this.parseAcres($card.attr('data-acres')),
        pricePerAcre: null,
        county,
        state: stateAbbrev,
        url: `${this.baseUrl}/listing/${slug}`,
        description: '',
        coordinates: null,
        daysOnMarket: null,
      });
    });

    // Count every real card (including status-skipped ones) so a page whose
    // cards were all filtered out is not mis-read as zero-card markup drift.
    this._lastCardCount = cardCount;
    return listings;
  }
}

// State pages carry statewide inventory across several pages (target-county
// cards are scattered), so sweep the first few pages per state — the
// conservative default matching the other multi-page brokerage parsers.
// SCRAPER_MAX_PAGE can lower it for validation.
const STATE_SEARCH_PAGES = 2;

// data-status values that mean a listing is NOT a buyable lead. Matched as a
// substring so "FOR SALE - UNDER CONTRACT" and bare "PENDING" both drop, while
// "FOR SALE" / "FOR SALE - NEW LISTING" / "PRICE REDUCED" / "AUCTION" pass.
const UNAVAILABLE_STATUS_RE = /\b(pending|sold|under contract|off market|contingent)\b/i;

/** Collapse whitespace and trim. */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** True when a card's data-status marks it not currently for sale. */
function isUnavailableStatus(status) {
  return UNAVAILABLE_STATUS_RE.test(String(status || ''));
}

module.exports = NationalLandRealtyParser;
