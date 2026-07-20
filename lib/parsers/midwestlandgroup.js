'use strict';

const cheerio = require('cheerio');
const BaseParser = require('./base-parser');
const { stateAbbrev } = require('../states');

/**
 * Midwest Land Group — rural/recreational land brokerage strong across the
 * Plains and Midwest, with inventory that never appears on the CoStar sites.
 *
 * URL shape (verified from captured HTML):
 *   /listings/                     — ONE national listings index (grid of cards)
 *   /listings/{slug}/              — a listing detail page (e.g. /listings/barron-80/)
 *   /listings/feed/                — a WordPress RSS feed to EXCLUDE
 *
 * IMPORTANT — no per-county/per-state URL: unlike the other brokerage parsers
 * (Whitetail, MossyOak) whose buildSearchUrls loops target counties, this site
 * exposes a SINGLE national index with no location filter in the URL. So this
 * parser CANNOT query by county. buildSearchUrls returns only the index page;
 * parseSearchPage pulls EVERY card; the normal downstream county filter
 * (lib/filter.js) keeps just the target-county listings.
 *
 * IMPORTANT — pagination is JS-only: the index's pager renders as
 * `<a href="#" class="pagination__button">` / `data-page` buttons that fetch
 * deeper pages via client-side JS — there is NO crawlable /page/N/ or ?pg=N
 * URL. So only page 1 is reachable with a plain fetch, and buildSearchUrls
 * returns exactly one URL. (A future upgrade could reverse-engineer the AJAX
 * endpoint, but that is out of scope and undocumented in the captured HTML.)
 *
 * Extraction reads the search cards directly rather than the shared
 * extractByDetailLinks engine: the index cards carry precise, labeled fields
 * (`.item--price`, `.item--acre`, `.item--county`, `.item--state`), so exact
 * selectors give correct price/acreage/county/state without the heuristic
 * "largest dollar amount + acres regex" walk — and, critically, the bare
 * acreage value ("80", no "acres" word) would make extractByDetailLinks drop
 * every card. The rich DETAIL pages carry the same labeled fields, so
 * parseDetailPage mirrors the same label→value read.
 */
class MidwestLandGroupParser extends BaseParser {
  constructor() {
    super('MidwestLandGroup');
    this.baseUrl = 'https://midwestlandgroup.com';
    // Only page 1 is crawlable (JS-only pagination, see class doc), so there is
    // no deeper page to early-stop into. resultsSortedNewestFirst stays false
    // (base default): incremental early-stop is a no-op for a single page.
  }

  /**
   * The site has no per-county URL, so `counties` is unused — every target
   * county is served from the one national index and separated later by
   * lib/filter.js. Returns the single crawlable index page.
   */
  buildSearchUrls(_counties) {
    return [{ url: `${this.baseUrl}/listings/`, county: null, state: null, page: 1 }];
  }

  /**
   * Parse the national index into raw listings. county/state come from each
   * card (not from buildSearchUrls, which passes null), so the passed args are
   * ignored. Cards without a valid detail href are skipped; the hidden JS
   * card template (empty href) drops out naturally.
   */
  parseSearchPage(html, _county, _state) {
    const $ = cheerio.load(html);
    const listings = [];
    let cardCount = 0;

    $('div.listings-archive.row').each((_, el) => {
      const $card = $(el);
      // The site ships a hidden card as a JS clone template — empty href,
      // class "...row hidden". Skip it so it is neither a listing nor a card.
      if ($card.hasClass('hidden')) return;

      const href = this.firstListingHref($, $card);
      if (!href) return;

      cardCount++;

      const url = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
      const name = normalizeText($card.find('.listings-archive__title').first().text())
        || `${cardText($, $card, 'county') || 'Midwest Land Group'} Land`;

      // Precise labeled fields; any missing one stays null for detail
      // enrichment / parseDetailPage to fill rather than guessed from prose.
      const price = this.parsePrice(cardText($, $card, 'price'));
      const acres = this.parseAcres(cardText($, $card, 'acre'));
      const countyText = normalizeText(cardText($, $card, 'county')) || null;
      const stateText = normalizeText(cardText($, $card, 'state'));

      listings.push({
        name: name.slice(0, 200),
        price,
        acres,
        pricePerAcre: null,
        county: countyText,
        // Store the two-letter abbreviation the rest of the pipeline expects:
        // lib/airtable.js getCountyRecordId keys the county index on the
        // uppercased abbreviation, and lib/filter.js matches on it too.
        state: stateText ? stateAbbrev(stateText) : null,
        url,
        description: normalizeText($card.find('.listings-archive__description').first().text()).slice(0, 400),
        coordinates: null,
        daysOnMarket: null,
      });
    });

    // Non-template cards seen, for markup-drift detection in scrapeAll.
    this._lastCardCount = cardCount;
    return listings;
  }

  /**
   * Pull price/acreage/county/state from a DETAIL page's labeled info rows
   * (`.listings-detail__item` = "<label>: <value>"). Same label→value shape as
   * the index cards. Returns whatever it finds; never throws on garbage HTML.
   */
  parseDetailPage(html) {
    if (!html || typeof html !== 'string') return {};
    try {
      const $ = cheerio.load(html);
      const byLabel = {};
      $('.listings-detail__item').each((_, el) => {
        const $item = $(el);
        const label = normalizeText($item.find('span').first().text()).replace(/:\s*$/, '').toLowerCase();
        const value = normalizeText($item.find('.listings-detail__info').first().text());
        if (label && value) byLabel[label] = value;
      });

      const result = {};
      if (byLabel.price) result.price = this.parsePrice(byLabel.price);
      if (byLabel.acreage) result.acres = this.parseAcres(byLabel.acreage);
      if (byLabel.county) result.county = byLabel.county;
      if (byLabel.state) result.state = stateAbbrev(byLabel.state);

      const description = this.extractDetailDescription(html);
      if (description) result.description = description;

      return result;
    } catch (err) {
      // Detail parsing is best-effort enrichment — never break a scrape.
      return {};
    }
  }

  /**
   * Prefer the detail-page description block (`.listing-description`) over the
   * generic largest-prose heuristic: the block is the property's own copy,
   * prefixed with a "Property Description" heading we strip.
   */
  extractDetailDescription(html) {
    try {
      if (!html || typeof html !== 'string') return '';
      const $ = cheerio.load(html);
      const block = normalizeText($('.listing-description').first().text());
      if (block) {
        return block.replace(/^property description\s*/i, '').slice(0, 2000);
      }
    } catch (err) {
      // fall through to the generic extractor
    }
    return super.extractDetailDescription(html);
  }

  /**
   * The card's detail-page href: the title anchor's href when it points at a
   * /listings/{slug}/ page, else the first such anchor in the card. Excludes
   * the bare /listings/ index and the /listings/feed/ RSS URL.
   */
  firstListingHref($, $card) {
    const anchors = [
      ...$card.find('h3.listings-archive__title a[href]').toArray(),
      ...$card.find('a[href]').toArray(),
    ];
    for (const el of anchors) {
      const href = ($(el).attr('href') || '').trim();
      if (isListingDetailHref(href)) return href.split('#')[0].split('?')[0];
    }
    return null;
  }
}

/** Collapse whitespace and trim. */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Value text of a card's labeled item span (price/acre/county/state). */
function cardText($, $card, kind) {
  return $card.find(`.listings-archive__item.item--${kind}`).first().text();
}

/**
 * True for a listing DETAIL href (/listings/{slug}/) and false for the bare
 * index (/listings/) and the RSS feed (/listings/feed/). Accepts absolute and
 * root-relative forms.
 */
function isListingDetailHref(href) {
  if (!href) return false;
  const path = href.replace(/^https?:\/\/[^/]+/i, '').split('#')[0].split('?')[0];
  const m = /^\/listings\/([^/]+)\/?$/.exec(path);
  if (!m) return false;
  return m[1].toLowerCase() !== 'feed';
}

module.exports = MidwestLandGroupParser;
