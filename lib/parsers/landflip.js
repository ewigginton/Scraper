'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower, stateAbbrev, STATE_ABBREV_TO_FULL } = require('../states');

/**
 * LANDFLIP — a large rural-land marketplace whose inventory overlaps only
 * partly with the CoStar network, so it surfaces tracts the other sites miss.
 *
 * URL shape (verified from captured HTML — see test fixtures):
 *   /land-for-sale/{state-slug}        — state page, page 1 (statewide inventory)
 *   /land-for-sale/{state-slug}/{N}-p  — state page, page N (N >= 2)
 *   /land/{numericId}                  — a listing detail page
 * State slug is the lowercase full state name with spaces hyphenated
 * (KY -> "kentucky", "New Mexico" -> "new-mexico"); stateSlugLower builds it.
 *
 * IMPORTANT — statewide inventory, NO per-county URL is used: a state page
 * lists EVERY county's listings, and each card carries its own county text
 * ("City : County Co : ST"), so this parser reads county/state PER CARD and
 * lets the shared downstream county filter (lib/filter.js) keep only the
 * target-county listings — exactly like MidwestLandGroup. buildSearchUrls
 * therefore dedupes to ONE series per unique target state (never one per
 * county). LANDFLIP does expose per-county URLs too, but the state-page +
 * per-card-county approach avoids one fetch per county and is the directed
 * design here.
 *
 * IMPORTANT — cards are read with precise selectors, not extractByDetailLinks:
 * a card's acreage/price live together in one ".price-ac" tag as
 * "11 Acres : $489,900", and its county sits in a separate ".list-info" line.
 * The shared extractByDetailLinks engine, which hunts the nearest ancestor
 * holding both "$" and "acres" text and cannot read the "Co" county
 * abbreviation, would mis-scope these; the explicit selectors below are exact.
 */
class LandflipParser extends BaseParser {
  constructor() {
    super('LANDFLIP');
    this.baseUrl = 'https://www.landflip.com';
    // State pages render in the site's DEFAULT "FEATURED" order (the sort-select
    // dropdown's newest option is JS-driven with NO crawlable URL parameter in
    // the captured HTML), so a newer listing can sit on any page. Therefore
    // resultsSortedNewestFirst stays false (base default): NOT eligible for
    // incremental early-stop — a whole page of known URLs does not prove the
    // deeper pages are older.
  }

  /**
   * One search-URL series per UNIQUE target state (deduped), each covering the
   * first STATE_SEARCH_PAGES pages of that state's statewide inventory. The
   * per-county target list only supplies which STATES to sweep; county
   * selection happens downstream in lib/filter.js against each card's own
   * county text. SCRAPER_MAX_PAGE (handled in BaseParser.scrapeAll) can cap the
   * page depth for validation runs.
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
            : `${this.baseUrl}/land-for-sale/${stateSlug}/${page}-p`,
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
   * the passed county/state (null for statewide pages) are ignored. Only real
   * listing cards (article.list-block with a /land/{id} link) are read; the
   * site's "news-block" carousel articles are a different class and never
   * match. A card missing price/acreage is still emitted with nulls so
   * detail-page enrichment (lib/scraper.js) can fill them before filtering.
   */
  parseSearchPage(html, _county, _state) {
    const $ = cheerio.load(html);
    const listings = [];
    let cardCount = 0;

    $('article.list-block').each((_, el) => {
      const $card = $(el);
      const href = this.listingHref($, $card);
      if (!href) return;

      cardCount++;

      const url = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
      const name = normalizeText($card.find('.list-info h4 a').first().text())
        || `${this.baseUrl}${href}`;

      // Acreage + total price share one ".price-ac" tag: "11 Acres : $489,900".
      const priceAc = parsePriceAcreageTag($card.find('.price-ac').first().text());
      // County/state live in the first ".list-info" paragraph:
      // "City : County Co : ST" (or "County County : State" with no city).
      const location = parseLocationLine($card.find('.list-info p').first().text());

      listings.push({
        name: name.slice(0, 200),
        price: priceAc.price,
        acres: priceAc.acres,
        pricePerAcre: null,
        county: location.county,
        // Two-letter abbreviation the rest of the pipeline keys on (lib/filter.js
        // and lib/airtable.js both match on the uppercased abbreviation).
        state: location.state,
        url,
        description: normalizeText($card.find('.excerpt').first().text()).slice(0, 400),
        coordinates: null,
        daysOnMarket: null,
      });
    });

    // Non-carousel cards seen, for markup-drift detection in scrapeAll.
    this._lastCardCount = cardCount;
    return listings;
  }

  /**
   * Structured read of a /land/{id} DETAIL page, verified against a real
   * capture (test/fixtures/landflip-detail-420517.html; full page at
   * data/evidence/www.landflip.com-land-420517-*.html). Real detail pages do
   * NOT carry the card's "N Acres : $X" tag or "County Co : ST" location line —
   * those are search-card signatures only. Instead the page exposes:
   *   - PRICE in a schema.org Product JSON-LD block (offers.price). The visible
   *     "$N" figures on the page belong to a price-filter dropdown and are
   *     unreliable, so price is read from structured data only.
   *   - ACREAGE + LOCATION in the og/meta description, whose canonical phrasing
   *     is "... with 11 acres by Campbellsville in Taylor County, Kentucky
   *     42718 ...": acres after "with", county before "County", state after the
   *     comma (validated against the known-states table so a stray token can't
   *     inject a bogus state).
   * Returns ONLY the fields it finds with confidence, and {} on anything
   * unexpected; never throws (detail enrichment is a non-fatal step).
   */
  parseDetailPage(html) {
    if (!html || typeof html !== 'string') return {};
    try {
      const result = {};

      // Price: structured data only (see method doc — the visible dollar
      // figures are a filter dropdown, not this listing's price).
      const price = extractJsonLdOfferPrice(html);
      if (price) result.price = price;

      // Acreage + county/state come from the canonical meta/og description.
      const metaDesc = extractMetaDescription(html);
      const acres = parseAcresFromDescription(metaDesc);
      if (acres) result.acres = acres;

      const location = parseCountyStateFromDescription(metaDesc);
      if (location.county) result.county = location.county;
      if (location.state) result.state = location.state;

      // Description reuses the guarded generic extractor (its own size/tag caps).
      const description = this.extractDetailDescription(html);
      if (description) result.description = description;

      return result;
    } catch (err) {
      // Detail parsing is best-effort enrichment — never break a scrape.
      return {};
    }
  }

  /**
   * A card's detail-page href: the ".list-info" title anchor when it points at
   * a /land/{id} page, else the card's own data-url attribute (the site stamps
   * "/land/{id}" on every list-block article). Excludes anything that is not a
   * /land/{id} link so nav/filter/keyword anchors never count as listings.
   */
  listingHref($, $card) {
    const titleHref = ($card.find('.list-info h4 a[href]').first().attr('href') || '').trim();
    if (isListingDetailHref(titleHref)) return stripHref(titleHref);
    const dataUrl = ($card.attr('data-url') || '').trim();
    if (isListingDetailHref(dataUrl)) return stripHref(dataUrl);
    return null;
  }
}

// State pages carry statewide inventory across many pages (8-61 in the captured
// fixtures) in FEATURED order, so target-county cards are scattered. Sweeping
// every page for every state would be a very large request volume; sweeping the
// first few pages per state is the conservative default (matching the other
// multi-page brokerage parsers). SCRAPER_MAX_PAGE can lower it for validation.
const STATE_SEARCH_PAGES = 2;

// "11 Acres : $489,900" / "13.96 Acres : $2,475,000" — one distinctive tag the
// site uses site-wide (on SEARCH CARDS) for a listing's acreage + total price.
const PRICE_ACREAGE_RE = /([\d,]+(?:\.\d+)?)\s*acres?\s*:\s*\$\s*([\d,]+(?:\.\d+)?)/i;

// Detail-page meta/og description phrasing (verified capture):
//   "... View this land for sale with 11 acres by Campbellsville in Taylor
//    County, Kentucky 42718. Contact ..."
// Acreage follows "with"; county precedes "County"; the state follows the comma
// (as one or two words, so "New Mexico" resolves), validated below so a ZIP or
// stray token can never be read as the state.
const ACRES_IN_DESCRIPTION_RE = /\bwith\s+([\d,]+(?:\.\d+)?)\s+acres?\b/i;
const COUNTY_STATE_IN_DESCRIPTION_RE = /\bin\s+([A-Z][A-Za-z.'\-]*(?:\s+[A-Z][A-Za-z.'\-]*)*?)\s+County,\s+([A-Za-z]{2,})(?:\s+([A-Za-z]{2,}))?/;

/** Collapse whitespace and trim. */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Drop a URL's query/hash, keeping the bare path (or absolute URL) form. */
function stripHref(href) {
  return href.split('#')[0].split('?')[0];
}

/**
 * True for a listing DETAIL href (/land/{numericId}), false for everything
 * else (state/county/keyword pages, nav, ads). Accepts absolute and
 * root-relative forms.
 */
function isListingDetailHref(href) {
  if (!href) return false;
  const path = href.replace(/^https?:\/\/[^/]+/i, '');
  return /^\/land\/\d+\/?$/.test(stripHref(path));
}

/**
 * Parse the "N Acres : $X" tag into { acres, price } (both null when the tag is
 * absent or unparseable). Handles decimal acreage and comma-grouped prices.
 */
function parsePriceAcreageTag(text) {
  const m = PRICE_ACREAGE_RE.exec(String(text || ''));
  if (!m) return { acres: null, price: null };
  const acres = parseFloat(m[1].replace(/,/g, ''));
  const price = parseFloat(m[2].replace(/,/g, ''));
  return {
    acres: Number.isFinite(acres) && acres > 0 ? acres : null,
    price: Number.isFinite(price) && price > 0 ? price : null,
  };
}

/**
 * Parse a card's clean "City : County Co : ST" location line into
 * { county, state }. State is validated against the known-states table (an
 * unrecognized trailing token yields state null); county is the colon-delimited
 * part ending in "Co" or "County", with that suffix stripped.
 */
function parseLocationLine(line) {
  const parts = String(line || '').split(/\s*:\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return { county: null, state: null };

  const state = toValidStateAbbrev(parts[parts.length - 1]);

  let county = null;
  for (const part of parts) {
    const m = /^(.*\S)\s+(?:Co|County)$/i.exec(part);
    if (m) { county = m[1].trim(); break; }
  }
  return { county: county || null, state };
}

/**
 * Read the og/meta description content from a detail page. That tag is the
 * site's canonical, junk-free summary and the reliable carrier of a listing's
 * acreage/location phrasing. DOM-free (a bounded head slice, both attribute
 * orders) so it never throws and stays cheap on large pages. Returns '' when
 * absent.
 */
function extractMetaDescription(html) {
  const head = String(html || '').slice(0, 200000);
  const patterns = [
    /<meta\s[^>]*(?:property=["']og:description["']|name=["']description["'])[^>]*content=["']([^"']*)/i,
    /<meta\s[^>]*content=["']([^"']*)["'][^>]*(?:property=["']og:description["']|name=["']description["'])/i,
  ];
  for (const re of patterns) {
    const m = re.exec(head);
    if (m) {
      const decoded = m[1]
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      return normalizeText(decoded);
    }
  }
  return '';
}

/** Acreage from the "... with N acres ..." description phrasing (null if absent). */
function parseAcresFromDescription(text) {
  const m = ACRES_IN_DESCRIPTION_RE.exec(String(text || ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * County + state from the "... in <County> County, <State> <zip> ..."
 * description phrasing. Only accepts a match whose state token names a real US
 * state (two-word "New Mexico" tried first, else the single word), so a ZIP or
 * stray prose token can never be read as the state — and the county is dropped
 * with it. Returns { county, state } (nulls when nothing confident found).
 */
function parseCountyStateFromDescription(text) {
  const m = COUNTY_STATE_IN_DESCRIPTION_RE.exec(String(text || ''));
  if (!m) return { county: null, state: null };
  const twoWord = m[3] ? toValidStateAbbrev(`${m[2]} ${m[3]}`) : null;
  const state = twoWord || toValidStateAbbrev(m[2]);
  if (!state) return { county: null, state: null };
  return { county: normalizeText(m[1]) || null, state };
}

/**
 * Total price from a detail page's schema.org Product JSON-LD block
 * (offers.price). Structured data is the only trustworthy price source here —
 * the visible "$N" figures belong to the page's price-filter dropdown. Scans
 * every ld+json script, JSON-parses each defensively, and walks it for the
 * first positive Offer price. Returns null when none is present or parseable.
 */
function extractJsonLdOfferPrice(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch (err) {
      continue; // a malformed block must not abort the scan
    }
    const price = findOfferPrice(data);
    if (price) return price;
  }
  return null;
}

/** Depth-first search of parsed JSON-LD for the first positive Offer price. */
function findOfferPrice(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const price = findOfferPrice(item);
      if (price) return price;
    }
    return null;
  }
  if (node.offers) {
    const price = findOfferPrice(node.offers);
    if (price) return price;
  }
  if (node.price !== undefined && node.price !== null) {
    const n = parseFloat(String(node.price).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Map a state token ("KY", "Kentucky", "kentucky") to its two-letter
 * abbreviation, but ONLY when it names a real US state — returns null for
 * anything else (stateAbbrev otherwise echoes unknown input back uppercased).
 */
function toValidStateAbbrev(token) {
  const abbrev = stateAbbrev(String(token || ''));
  return STATE_ABBREV_TO_FULL[abbrev] ? abbrev : null;
}

module.exports = LandflipParser;
