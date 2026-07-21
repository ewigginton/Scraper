'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

/**
 * Mossy Oak Properties — rural land brokerage franchise network, strong in
 * CCL's target states, independent of the CoStar inventory pool.
 *
 * URL shape (verified from indexed pages):
 *   /land-for-sale/{state}/                       — state page
 *   /land-for-sale/{state}/{county}-county/       — county page
 *   /land-for-sale/{state}/{county}-county/?pg=2  — pagination
 *
 * County pages advertise large "N listings" counts that suggest they mix in
 * nearby inventory, so extraction verifies each card's own county text and
 * drops mismatches (verifyCounty).
 */
// A few counties are stored in Airtable WITHOUT the internal capital that
// MossyOak's camel-case hyphenation rule keys off, so the general
// countySlug rule can't recover the site's hyphen. Map those explicitly.
// "Leflore" (Airtable spelling) -> "le-flore", proven by the le-flore-county
// href on data/evidence/www.mossyoakproperties.com-land-for-sale-oklahoma-*.html.
const COUNTY_SLUG_OVERRIDES = {
  leflore: 'le-flore',
};

class MossyOakParser extends BaseParser {
  constructor() {
    super('MossyOakProperties');
    this.baseUrl = 'https://www.mossyoakproperties.com';
    // Search URLs (see buildSearchUrls) carry NO sort param — page order is
    // the site's default (not date-sorted), so a newer listing could sit on
    // page 2. resultsSortedNewestFirst stays false (base default): NOT
    // eligible for incremental early-stop.
  }

  buildSearchUrls(counties) {
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      for (let page = 1; page <= 2; page++) {
        urls.push({
          url: page === 1
            ? `${this.baseUrl}/land-for-sale/${stateSlug}/${countySlug}-county/`
            : `${this.baseUrl}/land-for-sale/${stateSlug}/${countySlug}-county/?pg=${page}`,
          county,
          state,
          page,
        });
      }
    }
    return urls;
  }

  /**
   * MossyOak's county slugs hyphenate BEFORE an internal capital in a
   * camel-case county name: "McClain" -> "mc-clain", "McCurtain" ->
   * "mc-curtain", "McIntosh" -> "mc-intosh" (and, though not on the OK page,
   * "McNairy" -> "mc-nairy", "McCreary" -> "mc-creary"). Plain names with no
   * internal capital ("Lewis", "Logan") and space-separated names
   * ("Roger Mills", "Le Flore") are unaffected — the shared base slug already
   * turns spaces into hyphens. Proven by every county href on
   * data/evidence/www.mossyoakproperties.com-land-for-sale-oklahoma-d2ddfcda.html
   * (mc-clain-county, mc-curtain-county, mc-intosh-county, le-flore-county);
   * the plain base countySlug 404'd these nightly.
   */
  countySlug(county) {
    const raw = String(county == null ? '' : county).trim();
    const override = COUNTY_SLUG_OVERRIDES[raw.toLowerCase()];
    if (override) return override;
    // Insert a hyphen between a lowercase letter and an internal capital
    // (McClain -> Mc-Clain) so the base slug lowercases it to "mc-clain".
    return super.countySlug(raw.replace(/([a-z])([A-Z])/g, '$1-$2'));
  }

  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    return this.extractByDetailLinks($, {
      // Property detail links: /property/... , /listing/... , or a path
      // deeper than the county page under /land-for-sale/
      hrefPattern: /(\/property\/|\/listings?\/|\/land-for-sale\/[^/]+\/[^/]+\/[^/?#]+)/i,
      // Never treat other county/region pages as listings
      excludePattern: /-county\/?$|\/land-for-sale\/[^/]+\/?$/i,
      county,
      state,
      verifyCounty: true,
    });
  }
}

module.exports = MossyOakParser;
