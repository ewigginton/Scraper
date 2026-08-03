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
    // Search URLs carry sort=date_desc (see buildSearchUrls) → newest first,
    // so deeper pages are strictly older inventory: eligible for early-stop.
    this.resultsSortedNewestFirst = true;
    // CoStar/Imperva site: plain fetch is 403'd and the page is client-rendered,
    // so route fetches through the real browser. A zero-card plain fetch here
    // is a bot wall / empty skeleton, NOT markup drift — requiresBrowserRender
    // keeps scrapeAll from mis-diagnosing it.
    this.requiresBrowserRender = true;
  }

  buildSearchUrls(counties) {
    const settings = require('../../config/settings.json');
    const largeTractMin = settings.filtering.largeTractMinAcres || 150;
    const urls = [];
    for (const { county, state, maxCPA } of counties) {
      // LandWatch URL format: /STATE/COUNTY-county/land-for-sale
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      // Pass 1: all 40+ acre listings, sort by newest
      for (let page = 1; page <= 5; page++) {
        urls.push({
          url: `${this.baseUrl}/${stateSlug}/${countySlug}-county/land-for-sale?minAcreage=40&sort=date_desc&page=${page}`,
          county,
          state,
          page,
        });
      }
      // Pass 2: large tracts (150+ acres) — catches older listings pushed off the main pages
      for (let page = 1; page <= 3; page++) {
        urls.push({
          url: `${this.baseUrl}/${stateSlug}/${countySlug}-county/land-for-sale?minAcreage=${largeTractMin}&sort=date_desc&page=${page}`,
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
