'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

// Deepest page fetched per county. LandWatch shows 25 cards a page, so 10
// pages reads up to 250 listings of 40+ acres in one county — well above the
// busiest target county seen live (Le Flore OK: 99, 2026-10-05). A county that
// still has more listings past the cap gets a coverage_truncated warning in
// the report instead of a silent stop.
const MAX_PAGES_PER_COUNTY = 10;
// Cards on a full LandWatch results page (25 on every full page seen live,
// 2026-10-05). The series stops after the last page the page's own total
// implies; without a readable total, at the first page with fewer cards.
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
 *   /{state}-land-for-sale/{county}-county/acres-over-40 — county search
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
   *   /{state}-land-for-sale/{county}-county/acres-over-40/page-2
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

  /**
   * ONE series per county: the county page filtered to the acreage floor,
   * `/{state}-land-for-sale/{county}-county/acres-over-{minAcres}`, then
   * `/page-2` ... `/page-N`. `acres-over-N` is LandWatch's own server-side
   * acreage filter (a path segment, like pagination). Live 2026-10-05:
   * Pittsburg OK's plain county page totals 365 listings (15 pages, mostly
   * under 40 acres — the old 3-page read saw only the first 75), while
   * acres-over-40 totals 61 with zero sub-40-acre cards (Wayne KY 152 vs 21;
   * Pushmataha OK 200 vs 81). Reading the filtered series to its end sees
   * every qualifying listing with FEWER requests than the old plain p1-3 +
   * acres-over-150 p1-5 pair, which also made the large-tract pass redundant.
   *
   * Every page carries `pageSize`, so scrapeAll stops the series after the
   * last page the page's own total (__SERVER_STATE__ totalCount, read in
   * parseSearchPage) implies — page 4 of a 61-listing county is never
   * requested. The last planned page carries `warnIfFullAtCards`, so a
   * county with listings beyond the cap is reported, not silently cut.
   */
  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const minAcres = acreageFloorForUrl(effectiveMinAcres(settings.filtering.minAcres));
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      const seriesBase = `${this.baseUrl}/${stateSlug}-land-for-sale/${countySlug}-county/acres-over-${minAcres}`;
      for (let page = 1; page <= MAX_PAGES_PER_COUNTY; page++) {
        const item = {
          url: page === 1 ? seriesBase : `${seriesBase}/page-${page}`,
          county,
          state,
          page,
          pageSize: RESULTS_PER_PAGE,
        };
        if (page === MAX_PAGES_PER_COUNTY) item.warnIfFullAtCards = RESULTS_PER_PAGE;
        urls.push(item);
      }
    }
    return urls;
  }

  /**
   * LandWatch's own count of results for the whole search (all pages). Two
   * sources, both live-verified 2026-10-05:
   *   1. The server-rendered state blob (plain HTTP fetch):
   *        <script id="__SERVER_STATE__" type="application/json">
   *          {..."searchPage":{"searchResults":{..."totalCount":61}}}
   *   2. The page's meta description, which survives client rendering —
   *      in the browser-rendered DOM production reads, the state blob is
   *      EMPTY (<script id="__SERVER_STATE__" ...></script>):
   *        <meta name="description" content="[Page 2 - ]LandWatch has 61
   *          land listings for sale in Pittsburg County, OK. ...">
   * null when neither is readable (the caller then falls back to "a short
   * page is the last page").
   */
  searchTotalCount(html) {
    const text = String(html || '');
    const stateBlob = /<script[^>]*\bid=["']__SERVER_STATE__["'][^>]*>([\s\S]*?)<\/script>/i.exec(text);
    if (stateBlob && stateBlob[1].trim()) {
      try {
        const state = JSON.parse(stateBlob[1]);
        const total = state && state.searchPage && state.searchPage.searchResults
          ? state.searchPage.searchResults.totalCount
          : undefined;
        if (Number.isInteger(total) && total >= 0) return total;
      } catch (_) {
        // malformed blob — try the meta description
      }
    }
    for (const tag of text.match(/<meta\b[^>]*>/gi) || []) {
      if (!/\bname=["']description["']/i.test(tag)) continue;
      const content = /\bcontent=["']([^"']*)["']/i.exec(tag);
      const count = content && /\bLandWatch has ([\d,]+) land listings? for sale\b/i.exec(content[1]);
      if (count) return Number(count[1].replace(/,/g, ''));
    }
    return null;
  }

  /**
   * A county with no 40+ acre listings renders a results page whose total is
   * an explicit 0 ("No Listings" header) padded with other-county "similar
   * properties" cards (live 2026-10-05, robertson-county/acres-over-1000:
   * totalCount 0, 16 similar cards). That is a genuinely empty county, not
   * markup drift.
   */
  looksLikeEmptyResults(html) {
    if (this.searchTotalCount(html) === 0) return true;
    return super.looksLikeEmptyResults(html);
  }

  parseSearchPage(html, county, state) {
    // Tell scrapeAll how many results the whole search has, so it can stop
    // the series at the last page instead of requesting an empty one.
    this._lastTotalCount = this.searchTotalCount(html);
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

/**
 * The acreage floor as a LandWatch path value. LandWatch's acres-over-N
 * segment takes whole acres; round DOWN so the server filter never excludes
 * a listing the scraper's own floor (lib/filter.js, lib/scraper.js) would
 * keep. Falls back to 40 if the setting is missing or invalid.
 */
// Same precedence as lib/scraper.js resolveMinAcres (not imported: scraper.js
// requires the parsers). A SCRAPER_MIN_ACRES override below the configured
// floor must widen the server-side filter too, or those listings never load.
function effectiveMinAcres(configured) {
  const override = process.env.SCRAPER_MIN_ACRES;
  if (override !== undefined && override !== '') {
    const parsed = Number.parseFloat(override);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return configured;
}

function acreageFloorForUrl(minAcres) {
  const value = Number(minAcres);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 40;
}

module.exports = LandWatchParser;
module.exports.MAX_PAGES_PER_COUNTY = MAX_PAGES_PER_COUNTY;
module.exports.RESULTS_PER_PAGE = RESULTS_PER_PAGE;
