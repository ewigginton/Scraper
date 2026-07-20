'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const settings = require('../../config/settings.json');
const browserFetch = require('../browser-fetch');
const { persistSourceIssue, persistHtmlSnapshot } = require('../local-store');

// Cap on a detail page's extracted description (lib/scraper.js enrichment).
// Long enough to carry the dealbreaker language the ~400-char search-card
// blurb misses; short enough to keep Scraper Notes readable.
const MAX_DETAIL_DESCRIPTION_CHARS = 2000;
// cheerio's parse cost grows superlinearly with element nesting — a malformed
// or hostile detail page (tens of thousands of nested tags) can stall the
// single-threaded nightly run for minutes. Documents over either bound skip
// the DOM parse entirely and fall back to a bounded regex scan for meta
// descriptions.
const MAX_DETAIL_PARSE_BYTES = 1000000;
const MAX_DETAIL_PARSE_TAGS = 15000;
// Block-level tags the descent walks through when finding the largest
// contiguous prose block. Class-name agnostic so it survives redesigns.
const DETAIL_BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'li', 'td', 'blockquote', 'main']);
// A child block that holds at least this fraction of its parent's prose IS
// the content — the rest of the parent is chrome, so descend into the child.
// Below it, the node holds a multi-block description we keep whole.
const DETAIL_BLOCK_DOMINANCE = 0.65;

// Full modern-Chrome header set — WAF rules score missing sec-* headers as
// bot signals. (The TLS fingerprint still gives node-fetch away to the
// stricter vendors; the browser fallback below handles those.)
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const { isBlockedHtml } = require('../block-markers');

// Phrases sites use on genuinely empty result pages. If a page parses to
// zero listings and has none of these, the markup probably changed.
const EMPTY_RESULTS_MARKERS = [
  'no results',
  'no properties',
  'no listings',
  'no land for sale',
  '0 results',
  '0 properties',
  'nothing matched',
  'try adjusting',
  'no matches',
];

// After this many blocked pages in one run, stop hitting the site entirely —
// continuing just feeds the bot-detector hundreds more identical requests
const BLOCKED_PAGES_ABORT_THRESHOLD = 5;
// After this many NON-bot-wall error pages (404s, timeouts, parse throws) in
// one run, stop hitting the site: a systematic error storm — e.g. a site that
// changed its URL structure and now 404s every county — won't heal this run,
// so walking the remaining county URLs is pure waste. Higher than the blocked
// threshold because scattered one-off fetch errors are more normal than blocks.
const ERROR_PAGES_ABORT_THRESHOLD = 10;
// Cap HTML evidence snapshots per source per run; a site-wide outage would
// otherwise write hundreds of ~500KB files in one night
const MAX_SNAPSHOTS_PER_RUN = 3;

class BaseParser {
  constructor(name) {
    this.name = name;
    this.stats = { checked: 0, parsed: 0, errors: 0, blockedPages: 0, errorPages: 0, driftPages: 0, snapshotsSaved: 0, browserFetches: 0, abortedByBotWall: false, abortedAt: null, earlyStoppedSeries: 0 };
    this.sourceIssues = [];
    // parseSearchPage implementations set this to the raw count of card
    // elements matched, BEFORE filtering — it distinguishes "selectors match
    // nothing (markup drift)" from "cards found but none passed filters"
    this._lastCardCount = null;
    // True ONLY for parsers whose buildSearchUrls requests newest-first
    // results (subclasses set it in their constructor with per-site
    // evidence). Gates incremental early-stop in scrapeAll — a series can
    // only be truncated when deeper pages are guaranteed older inventory.
    this.resultsSortedNewestFirst = false;
    // Predicate the orchestrator installs via setKnownUrlPredicate before
    // scrapeAll: url => true when the pipeline has already seen that URL.
    // null when unset (incremental disabled, or a caller that never installs
    // it) — early-stop then never fires.
    this._isKnownUrl = null;
  }

  /**
   * Install the orchestrator's known-URL predicate for incremental
   * early-stop. The orchestrator (lib/scraper.js) owns the known-URL
   * knowledge (dedup index + URLs added earlier this run) and hands the
   * parser a predicate rather than the raw set, keeping URL-normalization on
   * one side. Must be called before scrapeAll to take effect this pass.
   */
  setKnownUrlPredicate(fn) {
    this._isKnownUrl = fn;
  }

  /**
   * Fetch a URL with retries and delay.
   */
  async fetchPage(url) {
    const maxRetries = parsePositiveInt(process.env.SCRAPER_MAX_RETRIES, settings.scraper.maxRetries);
    const requestTimeoutMs = parsePositiveInt(process.env.SCRAPER_REQUEST_TIMEOUT_MS, settings.scraper.requestTimeoutMs);
    const retryDelayMs = parsePositiveInt(process.env.SCRAPER_RETRY_DELAY_MS, settings.scraper.retryDelayMs);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(url, {
          headers: this.getHeaders(),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = new Error(`HTTP ${response.status} for ${url}`);
          err.status = response.status;
          throw err;
        }

        return await response.text();
      } catch (err) {
        // 4xx (except 429) fails identically every time — retrying a 404
        // county URL just burns time, and retrying a 403 with the same
        // fingerprint amplifies block signals
        const retryable = typeof err.status !== 'number' || err.status === 429 || err.status >= 500;
        if (!retryable || attempt === maxRetries - 1) throw err;

        // Exponential backoff with jitter; back off harder when rate-limited
        const base = retryDelayMs * Math.pow(2, attempt) * (err.status === 429 ? 2 : 1);
        await this.sleep(base + Math.floor(Math.random() * retryDelayMs));
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * Fetch a URL, falling back to a real browser when the plain client is
   * refused outright with a bot-wall status (400/403/429/503). Challenge
   * pages served with HTTP 200 are handled separately in scrapeAll (they're
   * only detectable after parsing).
   */
  async fetchPageSmart(url) {
    try {
      return await this.fetchPage(url);
    } catch (err) {
      if (!browserFetch.isBotWallStatus(err.status) || !browserFetch.isEnabled()) throw err;
      try {
        const html = await this.browserFetch(url);
        console.log(`[${this.name}] Plain fetch got HTTP ${err.status} — browser fallback succeeded for ${url}`);
        return html;
      } catch (browserErr) {
        if (browserErr.browserUnavailable) {
          browserFetch.warnUnavailableOnce(this.name);
        } else {
          console.error(`[${this.name}] Browser fallback failed for ${url}: ${browserErr.message.split('\n')[0]}`);
        }
        // Always rethrow the ORIGINAL bot-wall error: it keeps the
        // blocked-page accounting (and the per-site circuit breaker) working
        // even when the browser itself is flaky
        throw err;
      }
    }
  }

  /** Browser fetch with stats accounting; overridable in tests. */
  async browserFetch(url) {
    const html = await browserFetch.fetchPageWithBrowser(url);
    this.stats.browserFetches++;
    return html;
  }

  /**
   * Override in subclasses to add site-specific headers.
   */
  getHeaders() {
    return { ...DEFAULT_HEADERS };
  }

  /**
   * Build search URLs for all target counties in a state.
   * Override in each site parser.
   */
  buildSearchUrls(counties) {
    throw new Error(`${this.name}: buildSearchUrls not implemented`);
  }

  /**
   * Parse a search results page into an array of raw listings.
   * Override in each site parser.
   */
  parseSearchPage(html, county, state) {
    throw new Error(`${this.name}: parseSearchPage not implemented`);
  }

  /**
   * Parse a single listing detail page for additional data.
   * Optional override — not all sites need this.
   */
  parseDetailPage(html) {
    return {};
  }

  /**
   * Extract a fuller listing description from a detail page's HTML, for the
   * NEW-lead detail-page enrichment step (lib/scraper.js). Generic and
   * class-name agnostic: og:description + meta[name=description] + the largest
   * contiguous prose block in main/article/body (after stripping non-content
   * elements), whitespace-normalized and capped. Site parsers may override
   * with precise selectors.
   *
   * MUST NOT throw on weird/garbage HTML — enrichment is a non-fatal
   * best-effort step, so any failure returns '' and the caller keeps the
   * search-card blurb.
   */
  extractDetailDescription(html) {
    try {
      if (!html || typeof html !== 'string') return '';
      if (html.length > MAX_DETAIL_PARSE_BYTES || countTags(html) > MAX_DETAIL_PARSE_TAGS) {
        return metaDescriptionByRegex(html);
      }
      const $ = cheerio.load(html);

      // Strip elements that carry lots of text but never listing prose — a
      // fat nav menu or cookie banner would otherwise beat the real
      // description as the "largest" block.
      $('script, style, noscript, nav, header, footer, aside, svg, form, template').remove();

      // Meta descriptions are a reliable, junk-free summary when present.
      const candidates = [];
      const og = $('meta[property="og:description"]').attr('content');
      if (og) candidates.push(normalizeWhitespace(og));
      const metaDesc = $('meta[name="description"]').attr('content');
      if (metaDesc) candidates.push(normalizeWhitespace(metaDesc));

      const rootEl = $('main').get(0) || $('article').get(0) || $('body').get(0);
      if (rootEl) candidates.push(largestTextBlock($, rootEl));

      // Drop empties and any candidate wholly contained in a longer one (the
      // meta description is often the truncated head of the body prose).
      const parts = candidates.filter(Boolean);
      const kept = parts.filter((part, i) =>
        !parts.some((other, j) => j !== i && other.length > part.length && other.includes(part))
      );

      return normalizeWhitespace(kept.join(' ')).slice(0, MAX_DETAIL_DESCRIPTION_CHARS);
    } catch (err) {
      // Defensive: enrichment must never break a scrape. Swallow and yield ''.
      return '';
    }
  }

  /**
   * True when the HTML is a bot-management challenge page rather than
   * site content.
   */
  isBlockedPage(html) {
    return isBlockedHtml(html);
  }

  /**
   * True when a zero-listing page looks like a genuinely empty results page
   * (site said "no results") rather than changed markup.
   */
  looksLikeEmptyResults(html) {
    if (!html) return false;
    const lower = html.toLowerCase();
    return EMPTY_RESULTS_MARKERS.some(marker => lower.includes(marker));
  }

  /**
   * Main scrape loop: fetch all pages for all counties, return parsed listings.
   */
  async scrapeAll(counties) {
    this._counties = counties; // some parsers need the target list at parse time
    const listings = [];
    const maxPage = parsePositiveInt(process.env.SCRAPER_MAX_PAGE, null);
    const requestDelayMs = parsePositiveInt(process.env.SCRAPER_REQUEST_DELAY_MS, settings.scraper.requestDelayMs);
    const searchUrls = this.buildSearchUrls(counties)
      .filter(item => !maxPage || !item.page || item.page <= maxPage);
    const exhaustedSeries = new Set();

    for (const { url, county, state, page } of searchUrls) {
      const seriesKey = this.paginationSeriesKey(url, county, state);
      if (exhaustedSeries.has(seriesKey)) {
        continue;
      }

      // Circuit breaker: a site serving block pages will keep serving them —
      // abandoning the run beats feeding the detector 300 more requests
      if (this.stats.blockedPages >= BLOCKED_PAGES_ABORT_THRESHOLD) {
        // Flag + timestamp let the orchestrator (lib/scraper.js) give this site
        // one post-cooldown retry — bot walls are often transient rate-penalties
        this.stats.abortedByBotWall = true;
        this.stats.abortedAt = Date.now();
        this.recordSourceIssue({
          type: 'site_abandoned',
          url: null,
          county: null,
          state: null,
          page: null,
          error: `Aborted after ${this.stats.blockedPages} blocked pages — remaining counties skipped this run`,
        });
        console.error(`[${this.name}] Aborting run: ${this.stats.blockedPages} blocked pages`);
        break;
      }

      // Circuit breaker (non-bot-wall errors): a site returning systematic
      // fetch/parse errors — most often a 404 storm after its URL structure
      // changed — won't recover mid-run, so stop after the threshold instead
      // of hammering every remaining county URL. Deliberately does NOT set
      // abortedByBotWall: unlike a transient bot wall, a 404 storm won't clear
      // in an hour, so no post-cooldown retry is queued for this abort.
      if (this.stats.errorPages >= ERROR_PAGES_ABORT_THRESHOLD) {
        const dominantError = this.dominantErrorLabel();
        this.recordSourceIssue({
          type: 'site_abandoned',
          url: null,
          county: null,
          state: null,
          page: null,
          error: `Aborted after ${this.stats.errorPages} error pages (mostly ${dominantError}) — remaining counties skipped this run`,
        });
        console.error(`[${this.name}] Aborting run: ${this.stats.errorPages} error pages (mostly ${dominantError})`);
        break;
      }

      try {
        // Jittered delay — a metronomic request cadence is an easy bot signature
        await this.sleep(requestDelayMs * (0.75 + Math.random() * 1.25));
        let html = await this.fetchPageSmart(url);
        this.stats.checked++;

        this._lastCardCount = null;
        let parsed = this.parseSearchPage(html, county, state);
        let rawCards = this._lastCardCount;

        // Challenge pages arrive as HTTP 200 and parse to zero listings —
        // give the browser one shot at the page before writing it off
        if (parsed.length === 0 && this.isBlockedPage(html) && browserFetch.isEnabled()) {
          try {
            html = await this.browserFetch(url);
            this._lastCardCount = null;
            parsed = this.parseSearchPage(html, county, state);
            rawCards = this._lastCardCount;
            if (parsed.length > 0) {
              console.log(`[${this.name}] Challenge page bypassed via browser for ${url}`);
            }
          } catch (browserErr) {
            if (browserErr.browserUnavailable) browserFetch.warnUnavailableOnce(this.name);
            // fall through — the original challenge HTML is handled below
          }
        }

        this.stats.parsed += parsed.length;

        for (const listing of parsed) {
          listing.source = this.name;
          listings.push(listing);
        }

        // Incremental early-stop: newest-first parsers yield pages in
        // descending recency, so once an entire page is listings we've
        // already seen, every deeper page of this county series is
        // guaranteed older, already-known inventory — stop the series here
        // instead of walking its remaining pages. The page's listings are
        // already pushed above, so downstream dupe accounting stays truthful;
        // we only skip FETCHING deeper pages. Gated on resultsSortedNewestFirst
        // (unsorted sites could hide a new listing on page 2) and on the
        // orchestrator having installed a predicate (kill switch:
        // SCRAPER_INCREMENTAL=false withholds it).
        if (
          this.resultsSortedNewestFirst &&
          this._isKnownUrl &&
          parsed.length > 0 &&
          parsed.every(listing => listing.url && this._isKnownUrl(listing.url))
        ) {
          this.stats.earlyStoppedSeries++;
          exhaustedSeries.add(seriesKey);
          continue;
        }

        if (parsed.length === 0) {
          // The block check runs only on zero-parse pages: challenge pages
          // never contain parseable listings, and real pages that merely
          // mention a bot-vendor string (Imperva injects its script into
          // every page it fronts) must not kill the county series.
          if (this.isBlockedPage(html)) {
            this.stats.errors++;
            this.stats.blockedPages++;
            const savedTo = this.recordSourceIssue({
              type: 'blocked',
              url,
              county,
              state,
              page: page || null,
              error: 'Bot-block/challenge page served with HTTP 200',
            }, html);
            console.error(`[${this.name}] BLOCKED at ${url}${savedTo ? ` (evidence: ${savedTo})` : ''}`);
            exhaustedSeries.add(seriesKey);
            continue;
          }

          // Zero CARD ELEMENTS on page 1 with no "no results" text is the
          // signature of changed markup. Cards that matched but were all
          // filtered out (wrong county, no price) are NOT drift — that's
          // normal for state-wide searches like LivingTheDream.
          const cardsMatched = typeof rawCards === 'number' ? rawCards : 0;
          if ((page || 1) === 1 && cardsMatched === 0 && !this.looksLikeEmptyResults(html)) {
            this.stats.driftPages++;
            const savedTo = this.recordSourceIssue({
              type: 'markup_drift',
              url,
              county,
              state,
              page: page || null,
              error: 'Page fetched OK but zero listing cards matched and no "no results" marker found — selectors may be stale',
            }, html);
            console.warn(`[${this.name}] Possible markup drift at ${url}${savedTo ? ` (evidence: ${savedTo})` : ''}`);
          }
          exhaustedSeries.add(seriesKey);
        }
      } catch (err) {
        this.stats.errors++;
        const issueType = browserFetch.isBotWallStatus(err.status) ? 'blocked' : 'fetch_or_parse_error';
        if (issueType === 'blocked') {
          this.stats.blockedPages++;
          exhaustedSeries.add(seriesKey); // don't walk deeper pages of a blocked series
        } else {
          // Any fetch/parse error exhausts the series too: if page 1 of a
          // county 404s, its deeper pages 404 identically — walking them is
          // waste. errorPages feeds the non-bot-wall circuit breaker above.
          this.stats.errorPages++;
          exhaustedSeries.add(seriesKey);
        }
        const savedTo = this.recordSourceIssue({
          type: issueType,
          url,
          county,
          state,
          page: page || null,
          error: err.message,
        });
        console.error(`[${this.name}] Error fetching ${url}: ${err.message}${savedTo ? ` (saved: ${savedTo})` : ''}`);
      }
    }

    return listings;
  }

  /**
   * Reset only the counters that gate the per-run circuit breaker so scrapeAll
   * can run a second time on this same instance after a cooldown without the
   * stale blockedPages count instantly re-tripping it. First-pass stats and
   * sourceIssues must already be in the report (processScrapedListings copies
   * them) — the retry pass records fresh issues into the cleared array.
   */
  prepareForRetry() {
    this.stats.blockedPages = 0;
    this.stats.errorPages = 0;
    this.stats.abortedByBotWall = false;
    this.stats.abortedAt = null;
    this.sourceIssues = [];
  }

  /**
   * Name the most common non-bot-wall error recorded so far, for the
   * site_abandoned issue text ("mostly HTTP 404"). Tallies fetch/parse-error
   * issues by HTTP status parsed from their message; failures with no status
   * (timeouts, parse throws) fall into a generic bucket. Reads the issues
   * already recorded — the breaker fires at the top of the next loop iteration,
   * after the triggering error's issue is persisted.
   */
  dominantErrorLabel() {
    const counts = new Map();
    for (const issue of this.sourceIssues) {
      if (issue.type !== 'fetch_or_parse_error') continue;
      const match = /HTTP (\d{3})/.exec(issue.error || '');
      const label = match ? `HTTP ${match[1]}` : 'fetch/parse errors';
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    let dominant = 'fetch/parse errors';
    let max = 0;
    for (const [label, count] of counts) {
      if (count > max) { max = count; dominant = label; }
    }
    return dominant;
  }

  recordSourceIssue(issue, html = null) {
    const fullIssue = {
      source: this.name,
      ...issue,
    };
    let savedTo = null;
    try {
      savedTo = persistSourceIssue(fullIssue);
      if (html && this.stats.snapshotsSaved < MAX_SNAPSHOTS_PER_RUN) {
        const snapshotPath = persistHtmlSnapshot(this.name, html);
        if (snapshotPath) {
          this.stats.snapshotsSaved++;
          fullIssue.snapshot = snapshotPath;
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to save source issue evidence: ${err.message}`);
    }
    this.sourceIssues.push({ ...fullIssue, savedTo });
    return savedTo;
  }

  paginationSeriesKey(url, county, state) {
    return [
      county || '',
      state || '',
      url
        .replace(/([?&])page=\d+/i, '$1page=*')
        .replace(/([?&])pg=\d+/i, '$1pg=*')
        .replace(/\/page-\d+/i, '/page-*'),
    ].join('|');
  }

  /**
   * Generic card extraction for sites whose exact markup hasn't been
   * fixture-verified yet: find detail-page anchors, then treat the nearest
   * ancestor containing both a dollar amount and an acreage figure as the
   * listing card. Class-name agnostic, so it survives cosmetic redesigns;
   * markup-drift detection still applies via _lastCardCount.
   *
   * opts: { hrefPattern, excludePattern?, county, state, verifyCounty? }
   */
  extractByDetailLinks($, opts) {
    const { hrefPattern, excludePattern, county, state, verifyCounty } = opts;
    const listings = [];

    const anchors = $('a[href]').toArray().filter(el => {
      const href = $(el).attr('href') || '';
      if (!hrefPattern.test(href)) return false;
      if (excludePattern && excludePattern.test(href)) return false;
      return true;
    });

    // Group anchors by normalized href before anything else — a card's photo
    // overlay and its title link often point at the same detail page, and
    // the group (not just the first anchor) is what naming picks from below.
    // Map preserves first-appearance order, so both card counting and
    // listing order stay in first-appearance-of-href order.
    const hrefGroups = new Map();
    for (const el of anchors) {
      const href = ($(el).attr('href') || '').split('#')[0].split('?')[0];
      if (!href) continue;
      if (!hrefGroups.has(href)) hrefGroups.set(href, []);
      hrefGroups.get(href).push(el);
    }

    // Unique detail links count as "cards" for drift detection
    this._lastCardCount = hrefGroups.size;

    for (const [href, group] of hrefGroups) {
      // Walk up to the smallest ancestor that carries price + acreage text —
      // this is the card boundary. Anchors nest at different depths (a photo
      // overlay can sit too deep to reach the card in 4 hops), so each anchor
      // in the group gets a walk attempt until one finds the card.
      let $container = null;
      let text = '';
      for (const el of group) {
        let $candidate = $(el);
        for (let depth = 0; depth < 4; depth++) {
          $candidate = $candidate.parent();
          if (!$candidate.length) break;
          const candidateText = ($candidate.text() || '').replace(/\s+/g, ' ').trim();
          if (/\$\s?[\d,]{4,}/.test(candidateText) && /acres?/i.test(candidateText)) {
            $container = $candidate;
            text = candidateText;
            break;
          }
        }
        if (text) break;
      }
      if (!text) continue;

      const price = this.extractTotalPrice(text);
      const acres = this.extractAcres(text);
      if (!price || !acres) continue;

      // On sites whose county pages mix in nearby-county inventory, only
      // keep cards whose own location text matches the target county.
      // Rule: if the card mentions "<somewhere> county" at all, the target
      // county (st/saint variants included) must be among the mentions —
      // "county road"-style phrases are excluded from the check.
      if (verifyCounty && county) {
        const normText = ` ${String(text).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
        const mentionsACounty = /\b[a-z]+ county\b(?! road)/.test(normText);
        if (mentionsACounty) {
          const target = normalizeCountyText(county);
          const variants = new Set([
            target,
            target.replace(/^saint /, 'st '),
            target.replace(/^sainte /, 'ste '),
            target.replace(/^st /, 'saint '),
            target.replace(/^ste /, 'sainte '),
          ]);
          const matchesTarget = [...variants].some(v => normText.includes(` ${v} county `));
          if (!matchesTarget) continue;
        }
      }

      const name = this.bestListingName($, group, $container, county, state);
      const url = href.startsWith('http') ? href : `${this.baseUrl}${href}`;

      listings.push({
        name: name.slice(0, 200),
        price,
        acres,
        pricePerAcre: null,
        county,
        state,
        url,
        description: text.slice(0, 400),
        coordinates: null,
        daysOnMarket: null,
      });
    }

    return listings;
  }

  /**
   * Pick a listing name for a group of anchors that share one detail-page
   * href: the longest non-junk anchor text in the group (a photo overlay's
   * "Click to View More Photos" must not beat the real title anchor next to
   * it), else the card's first heading, else the county fallback.
   */
  bestListingName($, anchorGroup, $container, county, state) {
    let name = '';
    for (const el of anchorGroup) {
      const candidate = ($(el).text() || '').replace(/\s+/g, ' ').trim();
      if (candidate.length > name.length && !isJunkAnchorText(candidate)) {
        name = candidate;
      }
    }
    if (!name) {
      const heading = ($container.find('h1,h2,h3,h4,h5,h6').first().text() || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!isJunkAnchorText(heading)) name = heading;
    }
    return name || `${county || state} Land`;
  }

  /**
   * Total price from card text: take the LARGEST dollar amount — a card's
   * total price always exceeds any $/acre figure it also displays.
   */
  extractTotalPrice(text) {
    const amounts = (String(text).match(/\$\s?[\d,]+(?:\.\d+)?/g) || [])
      .map(s => parseFloat(s.replace(/[^0-9.]/g, '')))
      .filter(n => Number.isFinite(n) && n >= 10000);
    return amounts.length ? Math.max(...amounts) : null;
  }

  /**
   * Acreage from card text: handles "160 acres", "155± Acres", "30+/- acres".
   */
  extractAcres(text) {
    const m = String(text).match(/([\d,]+(?:\.\d+)?)\s*(?:±|\+\/-)?\s*acres?\b/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * URL slug for a county name. Strips punctuation ("St. Clair" → "st-clair",
   * "O'Brien" → "obrien") — leaving it in produces 404s on every page.
   */
  countySlug(county) {
    return String(county)
      .toLowerCase()
      .replace(/[.'’]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  }

  /**
   * Parse price string like "$1,250,000" or "1250000" into a number.
   */
  parsePrice(priceStr) {
    if (!priceStr) return null;
    const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  /**
   * Parse acreage string like "160 acres" or "160.5" into a number.
   */
  parseAcres(acresStr) {
    if (!acresStr) return null;
    const cleaned = String(acresStr).replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) || num <= 0 ? null : num;
  }

  /**
   * Extract coordinates from text (lat, lng format).
   */
  parseCoordinates(text) {
    if (!text) return null;
    const match = text.match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/);
    if (!match) return null;
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    if (lat < 24 || lat > 50 || lng > -65 || lng < -125) return null; // Continental US bounds
    return `${lat}, ${lng}`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Anchor text that is never a real listing title: photo-overlay / CTA
// anchors frequently share a card's detail-page href with the actual title
// link, and their text must lose to it (or to a heading, or to the fallback).
const JUNK_ANCHOR_PATTERNS = [
  /^(click|tap)\b/i,
  /\b(view|see)\s+(more|photos?|details?|listing)/i,
  /^\d+\s+photos?$/i,
];
const JUNK_ANCHOR_WORDS = new Set([
  'photos', 'photo', 'gallery', 'video', 'map', 'tour', 'virtual tour',
  'save', 'share', 'details', 'more', 'learn more', 'read more',
]);

/**
 * True if anchor text is a photo-overlay / call-to-action label rather than
 * a listing title: too short to be a title, an exact junk word, or matching
 * a known CTA phrasing.
 */
function isJunkAnchorText(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 3) return true;
  if (JUNK_ANCHOR_WORDS.has(trimmed.toLowerCase())) return true;
  return JUNK_ANCHOR_PATTERNS.some(re => re.test(trimmed));
}

/** Collapse all runs of whitespace to single spaces and trim. */
/**
 * Count '<' occurrences with an early exit just past the parse-guard
 * threshold — O(n) with no allocation, unlike String.match on a huge page.
 */
function countTags(html) {
  let count = 0;
  let i = -1;
  while ((i = html.indexOf('<', i + 1)) !== -1) {
    if (++count > MAX_DETAIL_PARSE_TAGS) break;
  }
  return count;
}

/**
 * DOM-free meta-description extraction for documents the parse guard
 * rejects. Scans only the leading slice (meta tags live in <head>), handles
 * both attribute orders, and decodes the entities meta content commonly
 * carries. Returns '' when neither tag is present.
 */
function metaDescriptionByRegex(html) {
  const head = html.slice(0, 200000);
  const patterns = [
    /<meta\s[^>]*(?:property=["']og:description["']|name=["']description["'])[^>]*content=["']([^"']*)/gi,
    /<meta\s[^>]*content=["']([^"']*)["'][^>]*(?:property=["']og:description["']|name=["']description["'])/gi,
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(head)) !== null) {
      const decoded = m[1]
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const cleaned = normalizeWhitespace(decoded);
      if (cleaned) found.push(cleaned);
    }
  }
  // Same containment rule as the DOM path: drop candidates wholly inside a
  // longer one.
  const kept = found.filter((part, i) =>
    !found.some((other, j) => j !== i && other.length > part.length && other.includes(part))
  );
  return normalizeWhitespace(kept.join(' ')).slice(0, MAX_DETAIL_DESCRIPTION_CHARS);
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Text of the largest contiguous prose block under rootEl. Starts at the root
 * and descends into the single child block that holds most of the current
 * node's prose (DETAIL_BLOCK_DOMINANCE) — that child IS the content and the
 * rest is chrome. Descent stops at the tightest node whose prose is split
 * across several blocks (a multi-paragraph description), returning that whole
 * node's text rather than one paragraph. Guard-bounded so malformed, deeply
 * self-nesting HTML can't loop forever.
 */
function largestTextBlock($, rootEl) {
  let node = rootEl;
  for (let depth = 0; depth < 100; depth++) {
    const nodeLen = normalizeWhitespace($(node).text()).length;
    if (nodeLen === 0) break;

    let bestChild = null;
    let bestLen = 0;
    $(node).children().each((_, child) => {
      const tag = child.tagName && child.tagName.toLowerCase();
      if (!tag || !DETAIL_BLOCK_TAGS.has(tag)) return;
      const len = normalizeWhitespace($(child).text()).length;
      if (len > bestLen) { bestLen = len; bestChild = child; }
    });

    if (bestChild && bestLen >= nodeLen * DETAIL_BLOCK_DOMINANCE) {
      node = bestChild;
      continue;
    }
    break;
  }
  return normalizeWhitespace($(node).text());
}

/**
 * Loose county-name comparison for card-level verification:
 * "St. Francois" ≡ "Saint Francois" ≡ "st francois".
 */
function normalizeCountyText(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^st\.?\s+/, 'saint ')
    .replace(/^ste\.?\s+/, 'sainte ')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = BaseParser;
