'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower, STATE_ABBREV_TO_FULL } = require('../states');

/**
 * Tutt Land & Co — a regional rural/timber/poultry-farm brokerage in the Deep
 * South, with inventory independent of the CoStar network.
 *
 * URL shape (verified from captured HTML — see test fixtures):
 *   /land-sale/{state-slug}/                          — one state's inventory
 *   /land-sale/{state-slug}/{county}-county/{slug}    — a listing detail page
 * State slug is the lowercase full state name (AL -> "alabama", MS ->
 * "mississippi"); stateSlugLower builds it. The site's own title —
 * "Land for Sale in AL, GA, MS, TN & FL" — names its coverage (COVERED_STATES).
 *
 * IMPORTANT — statewide inventory, county PER CARD: a state page lists every
 * county's inventory and each card carries its own county+state in a schema.org
 * `.tl-subtitle` location block ("... for Sale in Autauga County, AL"), so this
 * parser reads county PER CARD and lets the shared downstream county filter
 * (lib/filter.js) keep only the target-county listings — the same design as
 * NationalLand/LivingTheDream. buildSearchUrls dedupes to ONE series per unique
 * covered target state (never one per county).
 *
 * IMPORTANT — server-rendered schema.org cards, NO browser render needed: the
 * captured HTML is a plain page whose `<article class="tl-tile ...">` cards
 * already carry every filter-critical field in the initial markup — a
 * machine-readable `<meta itemprop="price">`, the detail href on the
 * `a.tl-hit`, the acreage in a `.tl-line.tl-county` span (its class name says
 * "county" but the TEXT is "367 acres"), the title in `.tl-tile-title`, and the
 * county+state in the `.tl-subtitle` location. So a plain fetch suffices
 * (requiresBrowserRender stays false).
 *
 * IMPORTANT — pagination param is unverified: only the root index was captured,
 * not a deeper state page, so the page-2 URL form is unknown. buildSearchUrls
 * sweeps just page 1 per state; a future state-page capture can add pagination.
 *
 * IMPORTANT — NOT newest-first: the captured cards run price-descending, so
 * deeper pages are not guaranteed older. resultsSortedNewestFirst stays false
 * (base default): incremental early-stop must not fire.
 *
 * Cards whose status is not a live for-sale state (UNDER CONTRACT, SOLD,
 * PENDING) are skipped — they are not buyable leads — but still counted for
 * markup-drift detection.
 */
class TuttLandParser extends BaseParser {
  constructor() {
    super('TuttLand');
    this.baseUrl = 'https://www.tuttland.com';
    // Server-rendered schema.org cards (see class doc) — a plain fetch already
    // carries every field, so no browser render is required.
    // Price-descending default order with no crawlable newest-first param, so
    // incremental early-stop stays off (resultsSortedNewestFirst = false).
  }

  /**
   * One search-URL series per UNIQUE covered target state (deduped). Target
   * states outside COVERED_STATES are skipped (they have no state page). The
   * per-county target list only supplies which STATES to sweep; county
   * selection happens downstream in lib/filter.js against each card's own
   * `.tl-subtitle` county text.
   */
  buildSearchUrls(counties) {
    const seenStates = new Set();
    const urls = [];
    for (const { state } of counties) {
      const abbrev = String(state || '').toUpperCase();
      if (!abbrev || seenStates.has(abbrev) || !COVERED_STATES.has(abbrev)) continue;
      seenStates.add(abbrev);

      urls.push({
        url: `${this.baseUrl}/land-sale/${stateSlugLower(abbrev)}/`,
        county: null,
        state: abbrev,
        page: 1,
      });
    }
    return urls;
  }

  /**
   * Parse a state (or root index) page into raw listings. county/state come
   * from each card's `.tl-subtitle` location; the passed state is a fallback
   * only when a card's own location is missing. Under-contract/sold/pending
   * cards are skipped but still counted for markup-drift detection.
   */
  parseSearchPage(html, _county, state) {
    const $ = cheerio.load(html);
    const listings = [];
    let cardCount = 0;

    const fallbackState = state ? String(state).toUpperCase() : null;

    $('article.tl-tile').each((_, el) => {
      const $card = $(el);
      const href = ($card.find('a.tl-hit[href]').first().attr('href') || '').trim();
      if (!href) return;

      cardCount++;

      const status = normalizeText($card.find('.tl-badge.tl-status').first().text());
      if (isUnavailableStatus(status)) return;

      const url = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
      const title = normalizeText($card.find('.tl-tile-title').first().text());

      // Prefer the machine-readable schema.org price; fall back to the visible
      // "$1,795,000" badge if the meta is absent.
      const price = this.parsePrice(
        $card.find('meta[itemprop="price"]').first().attr('content')
          || $card.find('.tl-badge.tl-price').first().text(),
      );
      // The ".tl-county" span holds ACREAGE text ("367 acres"), not a county.
      const acres = this.parseAcres($card.find('.tl-line.tl-county').first().text());

      // Location: "<Type> for Sale in <County> County, <ST>".
      const location = normalizeText($card.find('.tl-subtitle [itemprop="name"]').first().text());
      const { county, cardState } = parseLocation(location);

      listings.push({
        name: (title || `${county || fallbackState || 'Tutt Land'} Land`).slice(0, 200),
        price,
        acres,
        pricePerAcre: null,
        county,
        state: cardState || fallbackState,
        url,
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

// The site's title names its coverage: "Land for Sale in AL, GA, MS, TN & FL".
// Requesting a state outside this set has no state page, so buildSearchUrls
// skips non-covered target states.
const COVERED_STATES = new Set(['AL', 'GA', 'MS', 'TN', 'FL']);

// Card status values that mean a listing is NOT a buyable lead. Matched as a
// substring so "Under Contract" drops while "Active"/"New"/"Reduced" pass.
const UNAVAILABLE_STATUS_RE = /\b(under contract|pending|sold|off market|contingent)\b/i;

/** Collapse whitespace and trim. */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** True when a card's status marks it not currently for sale. */
function isUnavailableStatus(status) {
  return UNAVAILABLE_STATUS_RE.test(String(status || ''));
}

/**
 * County + two-letter state from a card location like
 * "Duck Land for Sale in Autauga County, AL" -> { county: 'Autauga',
 * cardState: 'AL' }. Returns nulls when the pattern is absent; the state is
 * only accepted when it is a real US abbreviation so a stray token can't inject
 * a bogus state.
 */
function parseLocation(location) {
  const m = /\bin\s+(.+?)\s+County,\s*([A-Za-z]{2})\b/i.exec(String(location || ''));
  if (!m) return { county: null, cardState: null };
  const county = normalizeText(m[1]) || null;
  const abbrev = m[2].toUpperCase();
  return { county, cardState: STATE_ABBREV_TO_FULL[abbrev] ? abbrev : null };
}

module.exports = TuttLandParser;
