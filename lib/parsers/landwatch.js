'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

// Deepest page fetched in the large-tract (/acres-over-N) series. LandWatch
// shows 25 cards a page; 5 pages covers 125 large tracts in one county, far
// above the ~28 seen in the busiest target counties. Empty pages end the
// series early, so a small county costs one extra (empty) fetch, not four.
const LARGE_TRACT_MAX_PAGES = 5;
// Cards on a full LandWatch results page (Pittsburg OK acres-over-150 page 1,
// 2026-10-05 capture). A FULL last page means the series may continue past
// LARGE_TRACT_MAX_PAGES, so scrapeAll records a coverage warning for it.
const RESULTS_PER_PAGE = 25;

/**
 * LandWatch — the largest CoStar-network rural-land marketplace and CCL's
 * single highest-volume source. Behind Imperva/Incapsula bot management and
 * client-rendered (React): a plain node-fetch is refused on its TLS
 * fingerprint (HTTP 403), and even when a page is returned the initial HTML
 * is an empty JS skeleton with no listing cards. Both facts drive this
 * parser's two defining settings:
 *
 *   - requiresBrowserRender = true — scrapeAll routes every fetch straight to
 *     the real browser (lib/browser-fetch.js). On the production Mac's
 *     residential IP a headed Chrome clears Imperva and renders the grid; from
 *     a datacenter IP the wall does not open, which is why CI stays dry-run
 *     only with the browser fallback disabled.
 *   - extractByDetailLinks — the class-name-agnostic engine, NOT hand-picked
 *     CSS classes. LandWatch reskins its listing cards regularly; the previous
 *     selector-based parser (.listing-card / .price / .acres) silently
 *     returned zero after one such reskin. The engine keys off the one stable
 *     thing on the page — the detail-link href — so a cosmetic redesign no
 *     longer breaks extraction, and a genuine markup change trips the
 *     _lastCardCount drift alert with an HTML snapshot instead of a silent
 *     zero.
 *
 * URL shape (canonical LandWatch search + detail formats):
 *   /{state}/{county}-county/land-for-sale        — county search page
 *   /{county}-{state}-...-for-sale/pid/{id}        — listing detail page
 *   /pid/{id}                                      — bare detail page
 * Detail links always carry "/pid/{digits}", so that is the extraction anchor.
 */
const LANDWATCH_COUNTY_SLUG_OVERRIDES = {
  leflore: 'le-flore',
};

class LandWatchParser extends BaseParser {
  constructor() {
    super('LandWatch');
    this.baseUrl = 'https://www.landwatch.com';
    // No confirmed sort segment in the current URL scheme (the old
    // ?sort=date_desc query form is 400-rejected), so page order is the
    // site's default and a newer listing could sit on page 2:
    // resultsSortedNewestFirst stays false (base default) — NOT eligible for
    // incremental early-stop until a sort path segment is proven.
    //
    // CoStar/Imperva site: plain fetch is 403'd and the page is client-rendered,
    // so route fetches through the real browser. A zero-card plain fetch here
    // is a bot wall / empty skeleton, NOT markup drift — requiresBrowserRender
    // keeps scrapeAll from mis-diagnosing it.
    this.requiresBrowserRender = true;
  }

  /**
   * Current LandWatch URL scheme (verified from indexed pages, Aug 2026 —
   * the pre-2026 /{state}/{county}-county/land-for-sale?minAcreage=&sort=
   * query form now returns an HTTP 400 error shell for every request, which
   * is what killed this source):
   *   /{state}-land-for-sale/{county}-county            — county search page
   *   /{state}-land-for-sale/{county}-county/page-2     — pagination
   *   /{state}-land-for-sale/acres-over-500             — filters are PATH
   *     segments (acres-over-N, acres-11-50, auctions, owner-financing, ...)
   *   /{state}-land-for-sale/{county}-county/acres-over-150/page-2
   *                                                     — filtered pagination
   *   /{seo-slug}-for-sale/pid/{digits}                 — listing detail page
   */
  /**
   * LandWatch spells a few counties differently from the Airtable County
   * table. The generic slug for "Leflore" (leflore-county) returns HTTP 400,
   * so Le Flore County OK was never searched until 2026-10-05; LandWatch uses
   * le-flore-county. Verified by probing all 189 target counties: this is the
   * only mismatch.
   */
  countySlug(county) {
    const override = LANDWATCH_COUNTY_SLUG_OVERRIDES[String(county == null ? '' : county).trim().toLowerCase()];
    return override || super.countySlug(county);
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      const countyBase = `${this.baseUrl}/${stateSlug}-land-for-sale/${countySlug}-county`;
      // Pass 1: the plain county page (all listings, site-default order).
      // No acreage segment here — the confirmed-indexed form only. Sub-40ac
      // listings are dropped downstream by lib/filter.js, and 3 pages ≈ 60
      // cards covers the fresh inventory of even the busiest target county.
      for (let page = 1; page <= 3; page++) {
        urls.push({
          url: page === 1 ? countyBase : `${countyBase}/page-${page}`,
          county,
          state,
          page,
        });
      }
      // Pass 2: large tracts — catches older big listings pushed off the
      // main pages. /acres-over-{N} is confirmed server-side filtering on
      // county pages (test/fixtures/landwatch-search-acres-over-150*.html).
      // Paginated like the plain series: /acres-over-N/page-2 ... page-N.
      // Live evidence (2026-10-05): Pittsburg County, OK acres-over-150
      // lists 28 properties — 25 cards on page 1, 3 more on page-2
      // (including a 560-acre tract), 0 on page-3 — so reading page 1 only
      // silently dropped big tracts. paginationSeriesKey strips "/page-N",
      // giving this pass ONE series key of its own (distinct from the plain
      // county series), and scrapeAll ends the series at its first empty
      // page; only page 1 can raise a markup-drift alert.
      const largeTractBase = `${countyBase}/acres-over-${largeTractMin}`;
      for (let page = 1; page <= LARGE_TRACT_MAX_PAGES; page++) {
        const item = {
          url: page === 1 ? largeTractBase : `${largeTractBase}/page-${page}`,
          county,
          state,
          page,
        };
        // The cap is a cost bound, not "all pages": if the last page we read
        // is still full, say so in the report instead of silently stopping.
        if (page === LARGE_TRACT_MAX_PAGES) item.warnIfFullAtCards = RESULTS_PER_PAGE;
        urls.push(item);
      }
    }
    return urls;
  }

  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    const listings = this.extractByDetailLinks($, {
      // Every LandWatch listing detail URL ends in "/pid/{digits}" — the one
      // stable marker across reskins. Bare /pid/123 and the SEO-slug form
      // (/wayne-county-kentucky-...-for-sale/pid/123) both match.
      hrefPattern: /\/pid\/\d+/i,
      // County search pages can surface a few nearby-county listings; keep
      // only cards whose own location text matches the target county (cards
      // that name no county at all still pass — see extractByDetailLinks).
      county,
      state,
      verifyCounty: true,
    });
    // LandWatch card headlines ROUND acreage ("10.2 acres", "241 acres");
    // the page's JSON-LD ItemList carries each listing's description, which
    // usually states the surveyed figure ("10.17 acres", "240.65 +/- acre").
    // Prefer that precise figure when it rounds to the headline — the
    // rounded value is what would otherwise be written, and at the 40-acre
    // floor a 39.96-acre tract headlined "40 acres" must not pass as 40.
    const descriptions = jsonLdDescriptionsByUrl($);
    for (const listing of listings) {
      const description = descriptions.get(canonicalListingUrl(listing.url));
      if (description) listing.acres = this.refineAcresFromText(listing.acres, description);
    }
    return listings;
  }

}

/** Listing URL without fragment, query, or trailing slash — the map key. */
function canonicalListingUrl(url) {
  return String(url || '').split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
}

/**
 * url -> description for every JSON-LD node on the page that has both
 * (LandWatch's search ItemList: ListItem.item = RealEstateListing). Each
 * script is parsed defensively; a malformed block is skipped, not fatal.
 */
function jsonLdDescriptionsByUrl($) {
  const map = new Map();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const url = typeof node.url === 'string' ? node.url : (typeof node['@id'] === 'string' ? node['@id'] : null);
    if (url && typeof node.description === 'string' && /\/pid\/\d+/i.test(url)) {
      const key = canonicalListingUrl(url);
      if (!map.has(key)) map.set(key, node.description);
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).contents().text()), 0);
    } catch (_) {
      // malformed JSON-LD block — ignore
    }
  });
  return map;
}

module.exports = LandWatchParser;
module.exports.LARGE_TRACT_MAX_PAGES = LARGE_TRACT_MAX_PAGES;
module.exports.RESULTS_PER_PAGE = RESULTS_PER_PAGE;
