'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateFullName } = require('../states');

// Cards per results page: the page's script requests the listing API with
// per_page=50 and labels the first page "Showing 1-50 of N" (live
// 2026-10-05, state-level Oklahoma/Tennessee/Texas/Missouri searches).
const RESULTS_PER_PAGE = 50;

// Airtable county names Whitetail spells differently in its county filter.
// The filter value must match Whitetail's own county name (case-insensitive,
// verified live 2026-10-05: "mcintosh" and "McIntosh" return the same 5
// listings), and a wrong spelling silently returns "Showing 0-0 of 0" —
// "Leflore" and "LeFlore" both return 0 while "Le Flore" returns the
// county's 80-acre listing.
const WHITETAIL_COUNTY_NAME_OVERRIDES = {
  leflore: 'Le Flore',
};

/**
 * Whitetail Properties — rural/hunting land brokerage, heavy in CCL's
 * target states, with inventory that never appears on the CoStar sites.
 *
 * URL shape (the site's own search form, verified live 2026-10-05):
 *   /hunting-land?state[]={State}&county[{State}][]={County}&acreage_min=40
 *                                           — county search, 40+ acres only
 *   /hunting-land/{state}/{county}/{slug}   — listing detail page
 * The county filter is keyed by state (county[Oklahoma][]=Dewey), exactly as
 * the page's filter checkboxes submit it.
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
    // the site's default (not date-sorted). resultsSortedNewestFirst stays
    // false (base default): NOT eligible for incremental early-stop.
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

  /**
   * Path slug used in listing detail URLs (/hunting-land/{state}/{slug}/...).
   * County slugs spell out "saint" (saint-francois, not st-francois), and
   * Airtable's "Leflore" OK is le-flore.
   */
  countySlug(county) {
    return super.countySlug(this.countyFilterValue(county));
  }

  /**
   * Whitetail's own county name, as its search form's county filter submits
   * it: "Le Flore" for Airtable's "Leflore"; "St."/"Ste." spelled out
   * ("Saint Francois", "Sainte Genevieve" — the Missouri filter's names,
   * live 2026-10-05); every other name as Airtable spells it (Roger Mills,
   * Van Buren, San Saba, McCurtain, McIntosh all verified live).
   */
  countyFilterValue(county) {
    const name = String(county == null ? '' : county).trim();
    const override = WHITETAIL_COUNTY_NAME_OVERRIDES[name.toLowerCase()];
    if (override) return override;
    return name
      .replace(/^st\.?\s+/i, 'Saint ')
      .replace(/^ste\.?\s+/i, 'Sainte ');
  }

  /**
   * The county's search URL, filtered to the acreage floor. Live 2026-10-05,
   * Owsley KY: the old /hunting-land/kentucky/owsley page showed 9 listings
   * (7 of them under 40 acres); this URL shows the 2 that are 40+ acres. The
   * unfiltered query form returned exactly the path page's listings for
   * Owsley, Dewey, Le Flore and McIntosh (same URLs, same order).
   */
  searchUrlFor(county, state, minAcres = acreageFloorForUrl()) {
    const stateName = stateFullName(state);
    const encodedState = encodeURIComponent(stateName);
    const encodedCounty = encodeURIComponent(this.countyFilterValue(county));
    return `${this.baseUrl}/hunting-land?state%5B%5D=${encodedState}` +
      `&county%5B${encodedState}%5D%5B%5D=${encodedCounty}` +
      `&acreage_min=${minAcres}`;
  }

  /**
   * One render per county. The page shows the first 50 results ("Showing
   * 1-50 of N") and loads further pages only through its own JavaScript
   * pagination buttons; a &page=2 URL parameter is ignored (verified live
   * 2026-10-05: ?state[]=Oklahoma&acreage_min=40 with and without &page=2
   * rendered the same 50 listings in the same order). A county with more
   * than 50 qualifying listings is therefore reported as coverage_truncated
   * (scrapeAll reads the "Showing X-Y of N" line via parseSearchPage) rather
   * than silently cut short.
   */
  buildSearchUrls(counties) {
    const minAcres = acreageFloorForUrl();
    return counties.map(({ county, state }) => ({
      url: this.searchUrlFor(county, state, minAcres),
      county,
      state,
      page: 1,
      // Fallback for a page without a readable "Showing" line: a full page
      // of cards may have more results behind it.
      warnIfFullAtCards: RESULTS_PER_PAGE,
    }));
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
    const range = showingRange(html);
    if (range) return range.total === 0;
    return super.looksLikeEmptyResults(stripScriptAndStyleBodies(html));
  }

  parseSearchPage(html, county, state) {
    // "Showing 1-50 of 143 listings": tell scrapeAll how many results the
    // search has and how far this page reached, so a county with results
    // beyond the rendered page is reported as coverage_truncated.
    const range = showingRange(html);
    this._lastTotalCount = range ? range.total : null;
    this._lastRangeEnd = range ? range.to : null;
    const $ = cheerio.load(html);
    const listings = this.extractByDetailLinks($, {
      // Detail pages have 3+ path segments under /hunting-land/
      hrefPattern: /\/hunting-land\/[^/]+\/[^/]+\/[^/?#]+/i,
      county,
      state,
      verifyCounty: true,
    });
    if (this._lastCardCount === 0) this.checkCountyNameMatchesSite($, county, state);
    return listings;
  }

  /**
   * A misspelled county filter value returns "Showing 0-0 of 0" — exactly
   * what a genuinely empty county looks like. The rendered page also lists
   * every county in the state that HAS listings (its county[{State}][]
   * filter checkboxes), so when this county came back empty but the site
   * lists a county whose name differs only in spacing, punctuation or
   * "St."/"Saint", report it: the county is being silently missed and needs
   * an entry in WHITETAIL_COUNTY_NAME_OVERRIDES. No extra request.
   */
  checkCountyNameMatchesSite($, county, state) {
    const stateName = stateFullName(state);
    const searched = this.countyFilterValue(county);
    const siteNames = $(`input[name="county[${stateName}][]"]`)
      .map((_, el) => $(el).attr('value'))
      .get()
      .filter(Boolean);
    if (siteNames.length === 0) return;
    if (siteNames.some(name => name.toLowerCase() === searched.toLowerCase())) return;
    const key = looseCountyKey(searched);
    const nearMatch = siteNames.find(name => looseCountyKey(name) === key);
    if (!nearMatch) return; // the county simply has no listings on the site
    this.recordSourceIssue({
      type: 'county_name_mismatch',
      url: this.searchUrlFor(county, state),
      county,
      state,
      page: 1,
      error: `Searched county "${searched}" returned 0 listings, but Whitetail lists this county as "${nearMatch}" — its listings are being missed; add "${String(county).trim().toLowerCase()}": "${nearMatch}" to WHITETAIL_COUNTY_NAME_OVERRIDES in lib/parsers/whitetail.js`,
    });
  }
}

/** "Showing 1-50 of 143 listings" on the rendered page -> { to, total }. */
function showingRange(html) {
  if (!html) return null;
  const match = /showing\s+([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)\s+listings?/i.exec(stripScriptAndStyleBodies(html));
  if (!match) return null;
  const to = Number(match[2].replace(/,/g, ''));
  const total = Number(match[3].replace(/,/g, ''));
  return Number.isInteger(to) && Number.isInteger(total) ? { to, total } : null;
}

/** County name with case, spacing, punctuation and St./Saint differences removed. */
function looseCountyKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^st\.?\s+/, 'saint ')
    .replace(/^ste\.?\s+/, 'sainte ')
    .replace(/[^a-z]/g, '');
}

/** settings.filtering.minAcres as a whole-acre URL value (rounded down). */
function acreageFloorForUrl() {
  const settings = require('../../config/settings.json');
  // Same precedence as lib/scraper.js resolveMinAcres (a SCRAPER_MIN_ACRES
  // override must widen the server-side filter too).
  const override = process.env.SCRAPER_MIN_ACRES;
  const parsedOverride = override !== undefined && override !== '' ? Number.parseFloat(override) : NaN;
  const value = Number.isFinite(parsedOverride) && parsedOverride >= 0 ? parsedOverride : Number(settings.filtering.minAcres);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 40;
}

function stripScriptAndStyleBodies(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

module.exports = WhitetailParser;
module.exports.RESULTS_PER_PAGE = RESULTS_PER_PAGE;
module.exports.WHITETAIL_COUNTY_NAME_OVERRIDES = WHITETAIL_COUNTY_NAME_OVERRIDES;
