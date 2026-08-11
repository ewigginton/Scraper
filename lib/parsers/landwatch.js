'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

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
   *   /{seo-slug}-for-sale/pid/{digits}                 — listing detail page
   */
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
      // main pages. /acres-over-{N} on a county page is confirmed real
      // server-side filtering (test/fixtures/landwatch-search-acres-over-150.html,
      // captured Aug 5). Paginated like pass 1 rather than page-1-only: a
      // county with more than one page of big tracts silently lost the rest.
      // The composed /acres-over-N/page-M shape is NOT yet confirmed (Wayne's
      // capture had 6 results, one page), so it is queued in
      // config/evidence-requests.json — and it is safe to request meanwhile:
      // page 1 and its deeper pages share one pagination series key
      // (paginationSeriesKey strips /page-N), so a rejected or empty page-2
      // exhausts the series and skips page 3, and an HTTP 400 now costs only
      // this series instead of the site's whole run.
      const largeTractBase = `${countyBase}/acres-over-${largeTractMin}`;
      for (let page = 1; page <= 3; page++) {
        urls.push({
          url: page === 1 ? largeTractBase : `${largeTractBase}/page-${page}`,
          county,
          state,
          page,
        });
      }
    }
    return urls;
  }

  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    return this.extractByDetailLinks($, {
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
  }

}

module.exports = LandWatchParser;
