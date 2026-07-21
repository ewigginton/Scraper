'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower, STATE_ABBREV_TO_FULL } = require('../states');

/**
 * Living the Dream Outdoor Properties — a regional rural/recreational land
 * brokerage. The site was rebuilt on the RealStack ("rs-*") listing platform;
 * the old `/properties?state=&min_acres=&sort=newest&page=N` URLs now 404.
 *
 * URL shape (verified from captured HTML — see test fixtures):
 *   /land-for-sale/                    — national index (ALL states), page 1
 *   /land-for-sale/{state-slug}/       — one state's inventory, page 1
 *   ...?pg=N                           — page N (N >= 2), the ONLY crawlable
 *                                        pagination param
 *   /property/{slug}/{id}/             — a listing detail page
 * State slug is the lowercase full state name (KY -> "kentucky",
 * MO -> "missouri"); stateSlugLower builds it.
 *
 * IMPORTANT — the site's title advertises five states ("MO, KY, KS, AR, IL"),
 * but only MISSOURI and KENTUCKY actually have navigable per-state pages (the
 * captured index links exactly those two; KS/AR/IL appear only in marketing
 * prose and their /land-for-sale/{state}/ URLs 404 — see COVERED_STATES).
 * buildSearchUrls therefore sweeps only target states inside that coverage set —
 * a `/land-for-sale/oklahoma/` request would just 404 — and dedupes to ONE
 * series per covered state. A state page
 * carries EVERY county's inventory and each card carries its own county/state,
 * so this parser reads county/state PER CARD and lets the shared downstream
 * county filter (lib/filter.js) keep only the target-county listings — the same
 * state-page design as LANDFLIP.
 *
 * IMPORTANT — NOT newest-first: the captured page's default order is PRICE
 * DESCENDING (its first page runs $17.5M -> $2.25M), and the "Newest"
 * (`created_date_desc`) option lives in a JS-driven `data-rsfs="sort"` select
 * with NO crawlable URL parameter. So resultsSortedNewestFirst stays false
 * (base default): deeper pages are NOT guaranteed older inventory, so
 * incremental early-stop must not fire. (The old parser's `?sort=newest` claim
 * belonged to the dead URL structure.)
 *
 * IMPORTANT — cards are read with precise RealStack selectors: each card is a
 * `.rs-listing-card` carrying its coordinates in `data-lat`/`data-lng`, its
 * county+state in a two-span `.location` block ("Wayne County," + "MO"), and
 * its acreage/price in `.label--acre` ("65± Acres") / `.label--price`
 * ("$2,750,000"). The exact selectors read all of this — including the
 * per-card coordinates the search cards rarely expose elsewhere — so no detail
 * fetch is needed for the filter-critical fields.
 */
class LivingTheDreamParser extends BaseParser {
  constructor() {
    super('LivingTheDreamLand');
    this.baseUrl = 'https://www.livingthedreamland.com';
    // Default page order is price-descending and the newest-first sort is a
    // JS-only control with no crawlable URL param (see class doc), so deeper
    // pages are NOT guaranteed older: incremental early-stop must stay off.
  }

  /**
   * One search-URL series per UNIQUE target state that the site actually
   * covers (COVERED_STATES), each covering the first STATE_SEARCH_PAGES pages
   * of that state's inventory. Target states outside the coverage set are
   * skipped (they would 404). The per-county target list only supplies which
   * STATES to sweep; county selection happens downstream in lib/filter.js
   * against each card's own county text. SCRAPER_MAX_PAGE (handled in
   * BaseParser.scrapeAll) can cap the page depth for validation runs.
   */
  buildSearchUrls(counties) {
    const seenStates = new Set();
    const urls = [];
    for (const { state } of counties) {
      const abbrev = String(state || '').toUpperCase();
      if (!abbrev || seenStates.has(abbrev) || !COVERED_STATES.has(abbrev)) continue;
      seenStates.add(abbrev);

      const stateSlug = stateSlugLower(abbrev);
      for (let page = 1; page <= STATE_SEARCH_PAGES; page++) {
        urls.push({
          url: page === 1
            ? `${this.baseUrl}/land-for-sale/${stateSlug}/`
            : `${this.baseUrl}/land-for-sale/${stateSlug}/?pg=${page}`,
          county: null,
          state: abbrev,
          page,
        });
      }
    }
    return urls;
  }

  /**
   * Parse a state page into raw listings. county/state come from each card, so
   * the passed county (null for state pages) is ignored; the passed state is a
   * fallback only when a card's own state span is missing. A card missing
   * price/acreage is still emitted with nulls so detail-page enrichment
   * (lib/scraper.js) can fill them before filtering.
   */
  parseSearchPage(html, _county, state) {
    const $ = cheerio.load(html);
    const listings = [];
    let cardCount = 0;

    $('.rs-listing-card').each((_, el) => {
      const $card = $(el);
      const href = ($card.find('.card-title a[href]').first().attr('href') || '').trim();
      if (!href) return;

      cardCount++;

      const url = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
      const name = normalizeText($card.find('.card-title a').first().text()) || url;

      // Location is a two-span block: "<County> County," then the state abbrev.
      const locSpans = $card.find('.location span')
        .map((_, s) => normalizeText($(s).text())).get();
      const county = parseCountyFromLocation(locSpans[0]);
      const cardState = toValidStateAbbrev(stripTrailingComma(locSpans[1]));

      const price = this.parsePrice($card.find('.label--price').first().text());
      const acres = this.parseAcres($card.find('.label--acre').first().text());

      // Cards publish their parcel coordinates as data-lat/data-lng — rare on
      // search cards and the only flood-check input the pipeline gets without a
      // detail fetch. Validated through the continental-US bounds check.
      const coordinates = this.parseCoordinates(
        `${$card.attr('data-lat') || ''}, ${$card.attr('data-lng') || ''}`
      );

      listings.push({
        name: name.slice(0, 200),
        price,
        acres,
        pricePerAcre: null,
        county,
        state: cardState || (state ? String(state).toUpperCase() : null),
        url,
        description: normalizeText($card.find('.description').first().text()).slice(0, 400),
        coordinates,
        daysOnMarket: null,
      });
    });

    this._lastCardCount = cardCount;
    return listings;
  }
}

// The site's marketing copy names five states ("MO, KY, KS, AR, IL"), but only
// MISSOURI and KENTUCKY are actually navigable: the captured /land-for-sale/
// index links exactly two per-state pages —
// /land-for-sale/missouri/ and /land-for-sale/kentucky/ — while KS/AR/IL appear
// ONLY in the meta-description prose with NO state-page links (a stray non-MO/KY
// card can appear on marketing category pages like /land-for-sale/hunting/, but
// those pages are never swept). Requesting /land-for-sale/kansas|arkansas|illinois/
// just 404'd last run, so buildSearchUrls sweeps only the two real state pages.
// Verified against data/evidence/www.livingthedreamland.com-land-for-sale-8f92fbe0.html.
const COVERED_STATES = new Set(['MO', 'KY']);

// State pages carry statewide inventory across several pages in price-descending
// order (target-county cards are scattered), so sweep the first few pages per
// state — the conservative default matching the other multi-page brokerage
// parsers. SCRAPER_MAX_PAGE can lower it for validation.
const STATE_SEARCH_PAGES = 2;

/** Collapse whitespace and trim. */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Drop a single trailing comma (the location county span is "<County> County,"). */
function stripTrailingComma(text) {
  return normalizeText(text).replace(/,\s*$/, '');
}

/**
 * County name from a card's first location span ("Wayne County," ->
 * "Wayne", "St. Louis County," -> "St. Louis"): drop the trailing comma and the
 * "County"/"Co" suffix, preserving internal punctuation. Returns null when the
 * span is absent or carries no county.
 */
function parseCountyFromLocation(text) {
  const cleaned = stripTrailingComma(text);
  if (!cleaned) return null;
  const m = /^(.*\S)\s+(?:County|Co)\.?$/i.exec(cleaned);
  return m ? m[1].trim() : (cleaned || null);
}

/**
 * Map a state token to its two-letter abbreviation, but ONLY when it already
 * IS a real two-letter US state code (the cards publish the abbrev directly);
 * returns null for anything else so a stray span can't inject a bogus state.
 */
function toValidStateAbbrev(token) {
  const abbrev = String(token || '').trim().toUpperCase();
  return STATE_ABBREV_TO_FULL[abbrev] ? abbrev : null;
}

module.exports = LivingTheDreamParser;
