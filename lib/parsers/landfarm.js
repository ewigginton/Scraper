'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateSlugLower } = require('../states');

/**
 * Land and Farm (CoStar network) — rebuilt against a real captured county
 * search page (test/fixtures/landfarm-wayne-county-search.html, Wayne County
 * KY, 25 placards).
 *
 * URL shape (verified from the capture's own rel=canonical / rel=next and its
 * sibling-county links):
 *   /search/{state-slug}/{county-slug}-county-land-for-sale/         — page 1
 *   /search/{state-slug}/{county-slug}-county-land-for-sale/page-N/  — page N
 *   /search/{state-slug}/{county-slug}-county-land-for-sale/acres-101-200/
 *                                                                    — acreage band
 * The old `?minAcres=40&sort=newest&page=N` query string appears NOWHERE in
 * real markup — it was invented, and it is gone.
 *
 * IMPORTANT — the engine is the page's schema.org JSON-LD, NOT CSS selectors
 * and NOT extractByDetailLinks. Three measured facts force that choice:
 *
 *   1. Every card class is a build-hashed CSS-module token (price is
 *      `<span class="sBMpXMAWt">`, acreage `<span class="sm2jCIZ3E">`). Those
 *      rotate on every frontend build — exactly how the old
 *      `.result-price`/`.listing-card` selectors died (the old parser extracts
 *      ZERO listings from this capture). Only `id="placard-container"`,
 *      `id="placard-image"` and the `data-qa-placard*` attributes are stable.
 *   2. extractByDetailLinks measurably fails here: each card embeds its own
 *      `<script type="application/ld+json">` blob and cheerio's `.text()`
 *      includes script content, so the ancestor-walk card text starts with JSON
 *      and the acreage regex reads description prose; `.text()` also
 *      concatenates siblings without separators ("8.11 acres22 Buck Run Ridge
 *      Road"), which defeats extractAcres' word boundary. It recovers 9 of 25
 *      cards and corrupts most of them.
 *   3. The page ships ONE `application/ld+json` CollectionPage whose
 *      `mainEntity.itemListElement` names all 25 listings with `item.url`,
 *      `item.offers.price`, `item.name` (acreage is the name's prefix:
 *      "342 acres, 21 Clubhouse Drive, Monticello, KY 42633") and
 *      `contentLocation.address.addressRegion`. It agrees exactly with the
 *      visible placards on all 25 rows, and it is SEO-load-bearing: CoStar will
 *      not casually drop it, while it renames `.sBMpXMAWt` every build.
 *
 * The JSON-LD carries no county and no sale status, so the placard DOM supplies
 * both, keyed by listing path: county from the placard's own address line
 * ("22 Buck Run Ridge Road, Monticello, KY, 42633, Wayne County") and status
 * from the badge scoped to `id="placard-image"` (so a description containing
 * "sold" cannot be misread). Pending/sold/under-contract cards are skipped but
 * still counted for markup-drift detection, the same convention nationalland.js
 * and tuttland.js use.
 *
 * IMPORTANT — losing the placard layer is markup drift, not a silent upgrade.
 * `placard-container` and `placard-image` are independent ids — either can be
 * renamed without the other — so BOTH are coverage-tracked separately against
 * MIN_PLACARD_COVERAGE. Container loss makes county AND status unknowable;
 * image-only loss makes status alone unknowable (county still resolves off
 * the container's own address line), and status unknowable is exactly as
 * dangerous as status missing entirely — an unvetted Pending card is a
 * buyable New Lead. Either coverage collapse reports the page through the
 * REAL drift mechanism in base-parser.scrapeAll (zero listings +
 * `_lastCardCount = 0` on page 1) rather than emitting unvetted rows. Below
 * that page-level threshold, a per-card image miss is handled the same way a
 * per-card container miss always was: the card is counted (it participates in
 * `_lastCardCount`) but never emitted, because its status cannot be vetted.
 * See MIN_PLACARD_COVERAGE for the partial-loss threshold.
 *
 * IMPORTANT — NOT newest-first: there is no crawlable sort parameter, and cards
 * render in paid-placement order (diamond, then signature, standard, free), so
 * deeper pages are NOT guaranteed older inventory. resultsSortedNewestFirst
 * stays false (base default) — incremental early-stop must not fire here or new
 * listings sitting on page 2 would be skipped.
 */
class LandAndFarmParser extends BaseParser {
  constructor() {
    super('LandAndFarm');
    this.baseUrl = 'https://www.landandfarm.com';
    // Paid-placement card order, no crawlable newest-first parameter (see class
    // doc): incremental early-stop stays OFF. resultsSortedNewestFirst is left
    // at the base default (false) deliberately.
  }

  /**
   * Per county: the first COUNTY_SEARCH_PAGES pages of the county series, plus
   * FIVE extra large-acreage band URLs.
   *
   * Why the five extras: the county series is ordered by paid placement, not by
   * acreage or recency, and Wayne County alone has 151 listings against a
   * 3-page sweep. Tracts above the 40-acre floor in config/settings.json
   * (`filtering.minAcres`) — the only ones that can become leads, and the ones
   * `filtering.largeTractMinAcres` (150) cares about most — would otherwise be
   * invisible whenever they fall past page 3. The site's own facet links give a
   * narrow, crawlable path to exactly those: acres-51-100, acres-101-200,
   * acres-201-500, acres-501-1000 and acres-over-1000 are the bands that lie
   * wholly above the 40-acre floor (acres-11-50 is dominated by sub-40 parcels,
   * and page 1-3 of the county series already covers the small end).
   *
   * Page 1 is the bare canonical county URL, WITH the trailing slash: the
   * capture's own `rel=canonical` on page 1 is
   * `.../wayne-county-land-for-sale/`, and its `rel=next` plus every in-page
   * pagination link for pages 2-7 is `.../page-N/` — also WITH a trailing
   * slash. Both shapes are read directly off the capture; neither is a
   * `/page-1` segment, because the capture never links one anywhere.
   * `npm run test-browser -- --live` on the production Mac fetches this exact
   * page-1 URL (see the landfarm special-case in
   * scripts/test-browser-fallback.js / test/browser-fallback-probe.test.js),
   * so a wrong shape shows up as an HTTP error in that probe — which is the
   * precondition for re-enabling this source at all.
   */
  buildSearchUrls(counties) {
    const urls = [];
    for (const { county, state } of counties) {
      const stateSlug = stateSlugLower(state);
      const countySlug = this.countySlug(county);
      const seriesBase = `${this.baseUrl}/search/${stateSlug}/${countySlug}-county-land-for-sale`;

      urls.push({ url: `${seriesBase}/`, county, state, page: 1 });
      for (let page = 2; page <= COUNTY_SEARCH_PAGES; page++) {
        urls.push({ url: `${seriesBase}/page-${page}/`, county, state, page });
      }
      for (const segment of LARGE_TRACT_ACREAGE_SEGMENTS) {
        // Page 1 of each band only — these are a safety net for deep inventory,
        // not a second full crawl of a bot-wall-sensitive source.
        urls.push({ url: `${seriesBase}/${segment}/`, county, state, page: 1 });
      }
    }
    return urls;
  }

  /**
   * Parse a county search page into raw listings.
   *
   * Primary source: the CollectionPage JSON-LD ItemList (price, acreage, url,
   * name, state). Secondary source: the placard DOM, keyed by listing path, for
   * the two fields the JSON-LD lacks — county and sale status.
   *
   * `_lastCardCount` is the JSON-LD listing count, so it stays truthful when
   * every card is status-skipped, and drops to 0 (raising markup drift in
   * base-parser.scrapeAll) when either structural layer is lost.
   */
  parseSearchPage(html, county, state) {
    const $ = cheerio.load(html);
    const fallbackCounty = county || null;
    const fallbackState = state ? String(state).toUpperCase() : null;

    const items = collectionPageListings($);
    if (items.length === 0) {
      // No ItemList at all: either this is not a search page or CoStar dropped
      // the SEO block. Zero cards on page 1 raises markup_drift with an HTML
      // snapshot instead of being reported as an empty county.
      this._lastCardCount = 0;
      return [];
    }

    const placards = placardsByListingPath($);
    const matchedItems = items.filter(item => placards.has(item.path));

    // The placard container carries county AND is the scope for sale status.
    // Losing it silently would turn every Pending card into a buyable New
    // Lead, so treat a structural loss as drift rather than emitting unvetted
    // rows.
    if (matchedItems.length < items.length * MIN_PLACARD_COVERAGE) {
      this._lastCardCount = 0;
      console.warn(`[${this.name}] Placard container lost: ${matchedItems.length}/${items.length} JSON-LD listings had a placard-container — reporting as markup drift`);
      return [];
    }

    // `placard-container` and `placard-image` are independent ids (see class
    // doc): a container can resolve while its image — the sole source of sale
    // status — does not. That is coverage-tracked exactly like the container
    // itself, because a page-wide image loss is just as unknowable a status
    // signal as a page-wide container loss.
    const imageResolvedCount = matchedItems.reduce(
      (count, item) => count + (placards.get(item.path).imageFound ? 1 : 0), 0);
    if (imageResolvedCount < matchedItems.length * MIN_PLACARD_COVERAGE) {
      this._lastCardCount = 0;
      console.warn(`[${this.name}] Placard image lost: ${imageResolvedCount}/${matchedItems.length} matched listings had a placard-image — reporting as markup drift`);
      return [];
    }

    // Every JSON-LD listing counts as a card — including status-skipped ones —
    // so a page of all-Pending inventory is not mistaken for changed markup.
    this._lastCardCount = items.length;

    const listings = [];
    for (const item of matchedItems) {
      const placard = placards.get(item.path);
      // No placard-image resolved for this card: sale status is unknowable,
      // not merely absent. An unknowable status is never emitted — same "a
      // Pending row is worse than a missed one" rule as an unmatched
      // container, just scoped to one card instead of the whole page.
      if (!placard.imageFound) continue;
      if (placard.unavailable) continue;

      const acres = acresFromListingName(item.name);
      const price = this.parsePrice(item.price);
      // A row missing either number cannot be filtered or valued downstream.
      if (!price || !acres) continue;

      listings.push({
        name: item.name.slice(0, 200),
        price,
        acres,
        pricePerAcre: null,
        county: placard.county || fallbackCounty,
        state: item.region || fallbackState,
        url: item.url,
        description: item.description.slice(0, 400),
        coordinates: null,
        daysOnMarket: null,
      });
    }

    return listings;
  }
}

// Pages of the county series swept per county. The series is paid-placement
// ordered (not newest-first), so this is coverage depth, not recency depth.
const COUNTY_SEARCH_PAGES = 3;

// The site's own acreage-facet segments that lie wholly above the 40-acre floor
// in config/settings.json (`filtering.minAcres`). Verified present as links in
// the captured Wayne County page. See buildSearchUrls for why these five exist.
const LARGE_TRACT_ACREAGE_SEGMENTS = [
  'acres-51-100',
  'acres-101-200',
  'acres-201-500',
  'acres-501-1000',
  'acres-over-1000',
];

// Fraction of listings that must still resolve their structural anchor before
// the page is trusted — checked TWICE, independently, because
// `placard-container` and `placard-image` are two separate ids that can be
// renamed one at a time: once for JSON-LD listings vs `placard-container`
// (county AND the status-lookup scope), and again for matched listings vs
// `placard-image` (sale status alone). Chosen so that ordinary partial loss
// (a lazily rendered tile, one malformed card) does NOT nuke a real page — on
// the 25-card capture up to 5 missing placards/images are tolerated — while a
// structural loss (an id renamed page-wide takes its coverage to 0) is
// reported as drift. Items above both thresholds that still lack a container
// or an image are counted but not emitted: their sale status is unknown
// (unmatched container) or unknowable (container found, image missing), and
// a Pending row is worse than a missed one either way.
const MIN_PLACARD_COVERAGE = 0.8;

// Acreage lives in the JSON-LD name PREFIX ("8.11 acres, 22 Buck Run Ridge
// Road, ..."). The ^ anchor is what makes street addresses safe: without it,
// "5 acres, 5 acres Bridleway Road" and house numbers would be up for grabs.
// Handles singular ("1 acre, 39 Shepperd Road") and sub-acre decimals
// ("0.29 acres, 33 Old Beaver Loop").
const ACRES_IN_LISTING_NAME_RE = /^\s*([\d,]+(?:\.\d+)?)\s*(?:±|\+\/-)?\s*acres?\b/i;

// The placard address line ends with the county:
// "22 Buck Run Ridge Road, Monticello, KY, 42633, Wayne County".
const COUNTY_IN_ADDRESS_RE = /,\s*([A-Za-z][A-Za-z.'\-\s]*?)\s+County\s*$/i;

// Placard badge values that mean a listing is NOT a buyable lead. The capture
// badges 7 of its 25 cards "Pending". Matched as a substring so "Sale Pending"
// drops too; the badge text is read from `id="placard-image"` only, so a
// description mentioning "sold" cannot trigger it.
const UNAVAILABLE_STATUS_RE = /\b(pending|sold|under contract|off market|contingent)\b/i;

/**
 * Listings from the page's ONE CollectionPage JSON-LD block. Entries without a
 * /property/ listing path are dropped, which is also what filters out the
 * BreadcrumbList (its itemListElement entries carry `@id` category URLs, not
 * listing urls) and the per-card Residence blobs (no ItemList at all).
 */
function collectionPageListings($) {
  const items = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    if (items.length > 0) return; // first ItemList wins
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch (err) {
      return; // a malformed block must never break the page
    }
    if (!data || data['@type'] !== 'CollectionPage') return;
    const entries = data.mainEntity && data.mainEntity.itemListElement;
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const item = entry && entry.item;
      if (!item) continue;
      const url = cleanListingUrl(item.url);
      const path = listingPath(url);
      if (!path) continue;
      const address = (item.contentLocation && item.contentLocation.address) || {};
      items.push({
        path,
        url,
        name: normalizeText(item.name),
        description: normalizeText(item.description),
        price: item.offers ? item.offers.price : null,
        region: normalizeText(address.addressRegion).toUpperCase() || null,
      });
    }
  });
  return items;
}

/**
 * County + sale status per visible card, keyed by listing path. Both come from
 * the two stable structural ids (`placard-container`, `placard-image`) — every
 * class name on these cards is a build-hashed CSS-module token. The two ids
 * are independent — renaming one does not rename the other — so each entry
 * also carries `imageFound`: whether `placard-image` resolved to anything
 * inside this container. When it does not, `unavailable` is meaningless (it
 * was computed off an empty string) and the caller must treat status as
 * unknowable rather than "not Pending".
 *
 * Only <p> text is read for the address: cheerio's `.text()` on a container
 * would swallow the card's own embedded ld+json script.
 */
function placardsByListingPath($) {
  const placards = new Map();
  $('[id="placard-container"]').each((_, el) => {
    const $card = $(el);
    const href = $card.find('a[href*="/property/"]').first().attr('href');
    const path = listingPath(cleanListingUrl(href));
    if (!path || placards.has(path)) return;

    let county = null;
    $card.find('p').each((__, p) => {
      if (county) return;
      const match = COUNTY_IN_ADDRESS_RE.exec(normalizeText($(p).text()));
      if (match) county = normalizeText(match[1]);
    });

    // NOT cheerio .text(): as the class doc's point 2 already names, .text()
    // concatenates sibling elements with no separator. A Pending badge next to
    // the VIDEO/MAP media chips ("<span>Pending</span><span>VIDEO</span>")
    // reads as "PendingVIDEOMAP" — a letter-to-letter junction UNAVAILABLE_STATUS_RE's
    // \b boundaries cannot match — so a Pending listing would leak through as
    // a buyable New Lead. Stripping tags to spaces before collapsing
    // whitespace keeps a boundary at every element edge ("Pending VIDEO MAP").
    const $img = $card.find('[id="placard-image"]').first();
    const imageFound = $img.length > 0;
    // An empty status read from a FOUND placard-image is the normal
    // not-Pending case (an empty badge area) and must resolve unavailable to
    // false, same as always. Only a placard-image that resolves to ZERO
    // elements is unknowable — that is imageFound, handled by the caller, not
    // a special case of `status`.
    const status = normalizeText(($img.html() || '').replace(/<[^>]+>/g, ' '));
    placards.set(path, { county, imageFound, unavailable: UNAVAILABLE_STATUS_RE.test(status) });
  });
  return placards;
}

/** Acreage from a JSON-LD listing name's anchored prefix; null when absent. */
function acresFromListingName(name) {
  const match = ACRES_IN_LISTING_NAME_RE.exec(String(name || ''));
  if (!match) return null;
  const acres = parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(acres) && acres > 0 ? acres : null;
}

/** Drop any query string / fragment; '' for a missing url. */
function cleanListingUrl(url) {
  return String(url || '').split('#')[0].split('?')[0];
}

/**
 * The stable key shared by a JSON-LD entry and its placard: the
 * "/property/{slug}" path segment, lower-cased and without a trailing slash
 * (the JSON-LD carries absolute urls, the placard anchors relative ones).
 */
function listingPath(url) {
  const match = /\/property\/[^/?#]+/i.exec(url);
  return match ? match[0].toLowerCase() : null;
}

/** Collapse whitespace and trim. */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

module.exports = LandAndFarmParser;
