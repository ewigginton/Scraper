'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

/**
 * Whitetail Properties — rural/hunting land brokerage, heavy in CCL's
 * target states, with inventory that never appears on the CoStar sites.
 *
 * URL shape (verified from indexed pages):
 *   /hunting-land/{state}/{county}          — county search page
 *   /hunting-land/{state}/{county}/{slug}   — listing detail page
 * County slugs spell out "saint" (saint-francois, not st-francois).
 *
 * Parsing uses the generic detail-link engine in BaseParser: exact card
 * markup is unverified, so extraction is class-name agnostic and markup
 * drift on page 1 raises a source-health alert with an HTML snapshot.
 */
class WhitetailParser extends BaseParser {
  constructor() {
    super('WhitetailProperties');
    this.baseUrl = 'https://www.whitetailproperties.com';
    // Search URLs (see buildSearchUrls) carry NO sort param — page order is
    // the site's default (not date-sorted), so a newer listing could sit on
    // page 2. resultsSortedNewestFirst stays false (base default): NOT
    // eligible for incremental early-stop.
    //
    // Client-rendered search page (verified 2026-10-05): a plain HTTP 200
    // fetch of /hunting-land/oklahoma/dewey returns a "Loading listings..."
    // skeleton with ZERO listing cards whose inline script contains "No
    // listings found for this search." — so the zero-parse path takes it as a
    // genuinely empty county and reports nothing (a silent zero, not even a
    // drift alert), while the same URL rendered in Chrome shows 9 cards.
    // Route fetches straight to the browser, as for LandWatch.
    this.requiresBrowserRender = true;
  }

  countySlug(county) {
    // Whitetail spells Airtable's "Leflore" OK as le-flore (verified
    // 2026-10-05: /oklahoma/leflore shows 0 listings, /oklahoma/le-flore 1).
    if (String(county == null ? '' : county).trim().toLowerCase() === 'leflore') return 'le-flore';
    const expanded = String(county)
      .replace(/^st\.?\s+/i, 'Saint ')
      .replace(/^ste\.?\s+/i, 'Sainte ');
    return super.countySlug(expanded);
  }

  /**
   * One URL per county. The search page has no server-side pagination: it
   * renders up to 24 cards and loads more by infinite scroll, and a ?page=2
   * query is ignored (verified live 2026-10-05: /hunting-land/oklahoma and
   * /hunting-land/oklahoma?page=2 rendered the SAME 24 listings, as did
   * /oklahoma/dewey?page=2) — so the old page-2 fetch cost one extra browser
   * render per county and counted every listing twice.
   */
  buildSearchUrls(counties) {
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      urls.push({
        url: `${this.baseUrl}/hunting-land/${stateSlug}/${countySlug}`,
        county,
        state,
        page: 1,
      });
    }
    return urls;
  }

  /**
   * Genuinely empty county vs a render that never filled in. The page's
   * inline <script> ALWAYS contains "No listings found for this search."
   * (it is the client-side template), so the base marker check on raw HTML
   * called every zero-card page "empty" and a broken render could never
   * raise a markup-drift alert. Judge only the rendered markup instead:
   * a real empty county renders "Showing 0-0 of 0 listings" plus the
   * visible "No listings found" text (live, Pittsburg County OK,
   * 2026-10-05); a stuck render shows only "Loading listings...".
   */
  looksLikeEmptyResults(html) {
    if (!html) return false;
    const rendered = stripScriptAndStyleBodies(html);
    const showing = /showing\s+[\d,]+\s*-\s*[\d,]+\s+of\s+([\d,]+)\s+listings?/i.exec(rendered);
    if (showing) return Number(showing[1].replace(/,/g, '')) === 0;
    return super.looksLikeEmptyResults(rendered);
  }

  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    return this.extractByDetailLinks($, {
      // Detail pages have 3+ path segments under /hunting-land/
      hrefPattern: /\/hunting-land\/[^/]+\/[^/]+\/[^/?#]+/i,
      county,
      state,
      verifyCounty: true,
    });
  }
}

function stripScriptAndStyleBodies(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

module.exports = WhitetailParser;
