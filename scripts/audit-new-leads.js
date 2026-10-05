#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------
// READ-ONLY AUDIT. This script re-fetches each Land record's live listing
// page and REPORTS what it finds (price/acreage/county/state/availability
// vs. what Airtable holds) — it never writes to Airtable. It must never
// import or call any of lib/airtable.js's Airtable-mutating helpers (its
// batch-create writer, its single-record updater, or either intake-writing
// path in lib/intake.js). Emma reviews data/audit/.../audit.csv and decides
// what to remove or fix by hand (or via a separate, explicit write step
// later) — this tool only gathers evidence.
// ---------------------------------------------------------------------

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const airtable = require('../lib/airtable');
const { initFilter, getCPATarget } = require('../lib/filter');
const BaseParser = require('../lib/parsers/base-parser');
const browserFetch = require('../lib/browser-fetch');
const { extractListingDetails, extractCountyState } = require('../lib/intake');
const { extractPriceFromStructuredData } = require('../lib/price-extractor');
const { assertPublicUrl } = require('../lib/url-guard');
const { isEmptyAppShellHtml } = require('../lib/block-markers');
const { resolveMinAcres } = require('../lib/scraper');
const { auditLead } = require('../lib/lead-audit');
const { findAvailabilityMatches } = require('../lib/availability');
const { stateAbbrev } = require('../lib/states');
const { ACREAGE_NUMBER, parseAcreageNumber } = require('../lib/acreage');

const DEFAULT_DELAY_MS = 1500;

function parseArgs(argv) {
  const args = {
    stage: airtable.STAGES.newLead,
    limit: null,
    idsPath: null,
    out: null,
    delayMs: DEFAULT_DELAY_MS,
    replayDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') args.stage = argv[++i];
    else if (a === '--limit') {
      const raw = argv[++i];
      const n = Number.parseInt(raw, 10);
      // A missing/zero/non-numeric --limit must never SILENTLY fall back to
      // "audit everything" (`args.limit ? ... : records` would do exactly
      // that on a typo like `--limit 0` or a shell-swallowed value) — that's
      // a ~2-hour live-fetch run from a fat-fingered flag. Fail loud instead.
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--limit must be a positive integer, got "${raw}"`);
        process.exit(1);
      }
      args.limit = n;
    }
    else if (a === '--ids') args.idsPath = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--delay-ms') args.delayMs = Number.parseInt(argv[++i], 10);
    else if (a === '--replay') args.replayDir = argv[++i];
    else {
      console.error(`Unknown argument: ${a}\nUsage: node scripts/audit-new-leads.js [--stage "New Lead"] [--limit N] [--ids path.json] [--out dir] [--delay-ms 1500] [--replay dir]`);
      process.exit(1);
    }
  }
  return args;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'stage';
}

function defaultOutDir(stage) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join('data', 'audit', `${today}-${slugify(stage)}`);
}

/** Airtable singleSelect values arrive as strings via the SDK; be tolerant of objects. */
function scalarField(value) {
  return typeof value === 'object' && value !== null ? value.name : value;
}

function leadName(record) {
  return record.fields.Name || record.fields[airtable.FIELDS.propertyName] || record.id;
}

/**
 * Every <script type="application/ld+json"> on the page, first non-null
 * price wins — same convention lib/price-checker.js's own extractPrice()
 * uses, reused here via the shared lib/price-extractor.js chokepoint rather
 * than re-implemented.
 */
function extractLdPrice(html) {
  const $ = cheerio.load(html);
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(script).text();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const price = extractPriceFromStructuredData(data);
      if (price !== null) return price;
    } catch (_) {
      // Malformed JSON-LD on a real site is common (trailing commas, HTML
      // entities); skip it and keep looking at the next script tag.
    }
  }
  return null;
}

/**
 * Acreage parsed ONLY from the page's own title/heading (og:title, h1, or
 * <title> — the exact same three sources lib/intake.js's rawTitle tries, in
 * the same order), never the full body text. Fallback signal, used when
 * extractPageLoadAcreage (below) finds nothing — most sources don't carry a
 * page-load analytics payload, but many still state the acreage once in
 * their title/heading.
 */
function extractTitleAcres(html) {
  const $ = cheerio.load(html);
  const titleText = (
    $('meta[property="og:title"]').attr('content')
    || $('h1').first().text()
    || $('title').text()
    || ''
  );
  const re = new RegExp(`(${ACREAGE_NUMBER})\\s*(?:±|\\+\\/-|\\+-)?\\s*[- ]?acres?\\b`, 'i');
  const match = re.exec(titleText);
  return match ? parseAcreageNumber(match[1]) : null;
}

/**
 * Acreage from the page's own single-listing "page_load" analytics event —
 * `<... data-track-event="page_load" data-track-data="{...}">`'s JSON
 * payload's `listing_acreage` key. Whitetail Properties' CMS stamps this
 * exactly once, describing the CURRENT listing, near the top of the body —
 * well before any "Nearby Related Properties" widget. Confirmed against a
 * real page (record rec0gIpbWbIkp9Ly5): the subject's own 7.094 appears (as
 * this same attribute, repeated by several analytics scripts) starting at
 * character ~16,000; the nearby widget's unrelated listings — including one
 * that happens to ALSO read "8", same as the body-text mode-vote result —
 * don't start until ~95,000 characters in. Most sources don't carry this
 * attribute at all, in which case this returns null and the caller falls
 * back to extractTitleAcres.
 */
function extractPageLoadAcreage(html) {
  const $ = cheerio.load(html);
  const raw = $('[data-track-event="page_load"][data-track-data]').first().attr('data-track-data');
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return typeof data.listing_acreage === 'number' && data.listing_acreage > 0 ? data.listing_acreage : null;
  } catch (_) {
    return null; // malformed/unexpected payload shape — fall through to the title fallback
  }
}

/**
 * The single best "narrow scope, can't be confused with a nearby listing"
 * acreage reading available for this page, WITH provenance — passed into
 * auditLead as `structuredAcres: { value, source }`. lib/lead-audit.js
 * treats the two sources differently on disagreement with the body-text
 * reading: a 'page_load' reading wins outright (it can't be polluted by a
 * nearby-listings widget), but a 'title' reading never overrides the body
 * value — titles round ("40 Acres" for a 39.6-acre tract), so a title-vs-body
 * disagreement is surfaced as a reason only, never proposed as a correction.
 */
function extractStructuredAcres(html) {
  const pageLoadAcres = extractPageLoadAcreage(html);
  if (pageLoadAcres != null) return { value: pageLoadAcres, source: 'page_load' };
  const titleAcres = extractTitleAcres(html);
  return titleAcres != null ? { value: titleAcres, source: 'title' } : null;
}

/**
 * The subject listing's own structured status field, when a page carries
 * one — currently just LandWatch's inline page-state payload
 * (`<script id="__SERVER_STATE__" type="application/json">`), which embeds
 * the CURRENT listing's `"marketStatus"` alongside (not inside) its
 * `"otherListings"` sibling array. Deliberately keyed on the distinct
 * `marketStatus` name (not the bare `status` field each entry in
 * `otherListings` also carries) so this can never accidentally read a
 * NEARBY listing's status instead of the subject's own — passed into
 * auditLead as corroborating signal alongside whatever availability phrase
 * scanning found. Returns null on any other source (most pages don't carry
 * this at all) or a malformed/missing value.
 */
function extractStructuredStatus(html) {
  const match = /"marketStatus"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(html);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? { field: 'marketStatus', value } : null;
}

// Boundary keywords for a nearby/similar/related/"more listings" widget —
// matched against a heading's own text, an element's class/id attribute, or
// a JSON-embedded "other listings" widget payload key (LandWatch carries its
// nearby-listings widget as inline page-state JSON rather than rendered
// cards). Deliberately NOT matched against arbitrary body prose — "access to
// nearby public recreation" describing the subject property itself must
// never trip this.
const BOUNDARY_KEYWORDS_RE = /nearby|similar|related|recommended|also-?\s*like|other-?\s*listings/i;

/** Blanks out <style>...</style> block contents (same length, so offsets into
 * the ORIGINAL html stay valid) — a CSS selector like `.rs-nearby-block` or
 * `.message-related` sitting in a <head> stylesheet must never be mistaken
 * for the real nearby-listings widget markup further down the page. */
function blankStyleBlocks(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, m => ' '.repeat(m.length));
}

/** First index (in `region`) of a heading tag whose own text names a
 * nearby/similar/related section, or -1. */
function findHeadingBoundary(region) {
  const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, ' ');
    if (BOUNDARY_KEYWORDS_RE.test(text)) return m.index;
  }
  return -1;
}

/** First index (in `region`) of an element whose class or id attribute names
 * a nearby/similar/related section, or -1. Style blocks must already be
 * blanked out of `region` before calling this — a CSS selector isn't an
 * element's class/id attribute, but the regex below can't tell the
 * difference on its own. */
function findAttrBoundary(region) {
  const re = /<[a-z][a-z0-9]*\b[^>]*\b(?:class|id)\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    if (BOUNDARY_KEYWORDS_RE.test(m[1])) return m.index;
  }
  return -1;
}

/** Matches the START of an inline JSON "otherListings"/"nearbyListings"/etc.
 * widget-payload key (the key name plus its colon) — used by
 * excludeJsonWidgetSpans below to find where each such array begins. */
const JSON_WIDGET_KEY_RE = /"(?:other|nearby|related|similar)[-_]?listings"\s*:/i;

/**
 * Finds the index of the closing bracket that matches the opening
 * '['/'{' at `openIndex`, via a small bracket-depth scan that respects
 * quoted strings and backslash escapes (so a literal "]" or "}" inside a
 * JSON string value — e.g. an address or title — never miscounts as a real
 * closing bracket). Returns -1 on malformed/truncated JSON rather than
 * scanning past the end of the string.
 */
function findMatchingBracketEnd(str, openIndex) {
  const openChar = str[openIndex];
  if (openChar !== '[' && openChar !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Removes every "otherListings"/"nearbyListings"/"relatedListings"/
 * "similarListings" JSON key:value span — from the key through its
 * MATCHING closing bracket only (via findMatchingBracketEnd), not
 * everything after it — from `html`, searching from <body> onward.
 *
 * DEFECT 2: a LandWatch detail page embeds its own subject-listing fields
 * (marketStatus, formattedDescription, listhubListingStatus) AFTER its
 * "otherListings" sibling array in the same inline __SERVER_STATE__
 * payload (confirmed against real saved LandWatch pages). The previous
 * approach — truncate everything from the "otherListings" key onward —
 * discarded those subject fields along with the widget array. Excising
 * just the array's own span leaves the subject's later fields intact while
 * still keeping every OTHER listing's title/status text (a real false-
 * REMOVE source) out of scope.
 *
 * Returns { html, found }. On malformed/truncated JSON (no matching
 * bracket found), that occurrence is left in place rather than mis-spliced
 * — found only reflects spans actually removed.
 */
function excludeJsonWidgetSpans(html) {
  const bodyMatch = /<body[^>]*>/i.exec(html);
  const searchStart = bodyMatch ? bodyMatch.index + bodyMatch[0].length : 0;
  let result = html;
  let found = false;

  // Re-run the search against the (shrinking) result each pass, since a
  // splice shifts every index after it — simplest way to stay correct
  // across more than one widget key on the same page.
  for (;;) {
    const region = result.slice(searchStart);
    const m = JSON_WIDGET_KEY_RE.exec(region);
    if (!m) break;

    const keyStart = searchStart + m.index;
    let valueStart = keyStart + m[0].length;
    while (valueStart < result.length && /\s/.test(result[valueStart])) valueStart++;

    const valueEnd = findMatchingBracketEnd(result, valueStart);
    if (valueEnd === -1) break; // malformed/truncated — leave the rest alone

    result = result.slice(0, keyStart) + result.slice(valueEnd + 1);
    found = true;
  }

  return { html: result, found };
}

/**
 * Cuts `html` at the first boundary that starts a nearby/similar/related/
 * "more listings" HTML section (a heading or a class/id-named block), so
 * availability-phrase scanning (findAvailabilityMatches) never picks up a
 * badge or phrase that belongs to a DIFFERENT listing shown elsewhere on
 * the same page (real case: a "Nearby Properties Around Winston County"
 * widget's "Under Contract" card badge, on a MossyOak listing, was read as
 * the SUBJECT property's own status). An inline JSON widget payload
 * ("otherListings" etc.) is handled separately, and differently, by
 * excludeJsonWidgetSpans above — see DEFECT 2 — since truncating there
 * would also discard the subject's own later fields. Only searches from
 * <body> onward, with <style> blocks blanked out first, so a CSS selector
 * name containing "nearby"/"related" in a <head> stylesheet is never
 * mistaken for the real widget boundary. Returns the full (JSON-excised)
 * html unchanged when no HTML-section boundary is found (most pages have no
 * such widget at all).
 */
function scopeHtmlToSubjectListing(html) {
  if (!html) return { scopedHtml: html, boundaryFound: false };

  const { html: excised, found: jsonBoundaryFound } = excludeJsonWidgetSpans(html);

  const cleaned = blankStyleBlocks(excised);
  const bodyMatch = /<body[^>]*>/i.exec(cleaned);
  const searchStart = bodyMatch ? bodyMatch.index + bodyMatch[0].length : 0;
  const region = cleaned.slice(searchStart);

  const candidates = [findHeadingBoundary(region), findAttrBoundary(region)].filter(i => i >= 0);
  if (candidates.length === 0) return { scopedHtml: excised, boundaryFound: jsonBoundaryFound };

  const cutIndex = searchStart + Math.min(...candidates);
  return { scopedHtml: excised.slice(0, cutIndex), boundaryFound: true };
}

/**
 * Per-source URL-slug county/state derivation, in each parser's OWN known
 * URL scheme (lib/parsers/*.js's documented URL shapes) — deliberately
 * separate from lib/intake.js's extractCountyState, whose URL-vs-text
 * priority isn't observable from its return value alone. Returns the raw
 * (title-cased county, full-name state) pair the URL names, or null when
 * the host isn't one of the schemes below (landflip/nationalland: no
 * reliable per-listing county in the URL) or the URL doesn't match the
 * expected shape.
 */
// Every full state name, hyphenated ("south carolina" -> "south-carolina"),
// longest first — needed because LandWatch/MossyOak cram county AND state
// into ONE hyphenated slug segment with no delimiter between them, so a
// naive "one hyphen-word" capture truncates a two-word state ("South
// Carolina", "North Dakota", "New Mexico", ...) down to just its first
// word. Sorted longest-first defensively (no full state name is actually a
// prefix of another, but this stays correct even if that ever changes).
const STATE_SLUGS = Object.keys(require('../lib/states').STATE_FULL_TO_ABBREV)
  .map(full => full.replace(/\s+/g, '-'))
  .sort((a, b) => b.length - a.length);
const STATE_SLUG_ALTERNATION = STATE_SLUGS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

function deriveCountyFromUrlSlug(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = decodeURIComponent(u.pathname).toLowerCase();
  const titleCase = slug => slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  // LandWatch: /{county}-county-{state}-...-for-sale/pid/{id} — county and
  // state share one slug segment with no delimiter, so the state half is
  // matched against the known full-state-name list (STATE_SLUG_ALTERNATION)
  // rather than "one hyphen-word", which would truncate "South Carolina" to
  // just "south".
  if (host.endsWith('landwatch.com')) {
    const m = new RegExp(`/([a-z]+(?:-[a-z]+)*)-county-(${STATE_SLUG_ALTERNATION})(?:-|/|$)`).exec(path);
    return m ? { county: titleCase(m[1]), state: m[2] } : null;
  }
  // Whitetail Properties: /hunting-land/{state}/{county}/{slug} — state and
  // county are each their OWN path segment (slash-delimited), so a
  // multi-word state slug is captured correctly with no special-casing.
  if (host.endsWith('whitetailproperties.com')) {
    const m = /\/hunting-land\/([^/]+)\/([^/]+)\//.exec(path);
    return m ? { county: titleCase(m[2]), state: m[1] } : null;
  }
  // Mossy Oak Properties detail page: /property/{slug}-{county}-{state}/{id}/
  // — county and state again share one slug segment; state is matched
  // against the known full-state-name list, then county is the LAST
  // hyphen-token of whatever's left before it.
  if (host.endsWith('mossyoakproperties.com')) {
    const m = new RegExp(`/property/(.+)-(${STATE_SLUG_ALTERNATION})/\\d+/?$`).exec(path);
    if (!m) return null;
    const tokens = m[1].split('-').filter(Boolean);
    if (tokens.length === 0) return null;
    return { county: titleCase(tokens[tokens.length - 1]), state: m[2] };
  }
  // Tutt Land & Co: /land-sale/{state}/{county}-county/{slug} — state is its
  // own path segment; county is everything in its segment before "-county".
  if (host.endsWith('tuttland.com')) {
    const m = /\/land-sale\/([^/]+)\/([^/]+)-county\//.exec(path);
    return m ? { county: titleCase(m[2]), state: m[1] } : null;
  }
  // landflip / nationalland: no reliable per-listing county in the URL.
  return null;
}

/**
 * Resolves a raw {county, state (full name or abbreviation)} guess to the
 * Airtable County table's own canonical spelling/abbreviation — ONLY when
 * it's actually one of Emma's counties. Returns null on no match rather
 * than falling back to the raw guess (DEFECT 3): deriveCountyFromUrlSlug's
 * slug-splitting is a best-effort guess (MossyOak's "last hyphen-token
 * before the state" rule, for instance, misreads
 * "/property/timber-tract-alabama/12345/" as county "Tract" — the slug's
 * own last word, not a real county), and promoting an unmatched guess to
 * 'url' provenance would let lib/lead-audit.js REMOVE a lead over a county
 * that was never actually read off the page. The caller (main, below)
 * falls through to text/record provenance on a null return, exactly as it
 * already does when deriveCountyFromUrlSlug itself finds no county at all.
 */
function normalizeCountyAgainstAirtable(county, state) {
  if (!county) return null;
  // deriveCountyFromUrlSlug's state strings are hyphenated ("south-carolina");
  // stateAbbrev's lookup table is keyed by the space-separated full name.
  const abbrev = state ? stateAbbrev(String(state).replace(/-/g, ' ')) : null;
  const counties = airtable.listAllCounties();
  const match = counties.find(c => c.county.toLowerCase() === county.toLowerCase()
    && (!abbrev || String(c.state).toUpperCase() === abbrev));
  return match ? { county: match.county, state: match.state } : null;
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(values) {
  return values.map(csvField).join(',') + '\n';
}

const CSV_HEADER = [
  'id', 'name', 'stage', 'source', 'url',
  'recorded_price', 'recorded_acres', 'recorded_county', 'recorded_state',
  'live_price', 'ld_price', 'page_price', 'live_acres', 'live_county', 'live_state',
  'cpa_target', 'live_price_per_acre', 'flags',
  'verdict', 'reasons',
  'proposed_price', 'proposed_acres', 'proposed_county_record_id',
];

/**
 * Buckets a reason string into a short category for summary.txt — matched
 * against the exact reason phrasings lib/lead-audit.js produces.
 */
function reasonCategory(reason) {
  if (reason.startsWith('fetch failed')) return 'fetch-failed';
  if (reason.startsWith('could not extract')) return 'unextractable';
  if (reason.startsWith('listing gone')) return 'listing-gone';
  if (reason.startsWith('now ')) return 'now-unavailable';
  if (reason.startsWith('below ') && reason.includes('-acre floor')) return 'below-acre-floor';
  if (reason.startsWith('county has no CPA Target in Airtable')) return 'county-no-cpa-target';
  if (reason.startsWith('county not a target')) return 'county-not-target';
  if (reason.startsWith('county (from page text) not a target')) return 'county-not-target-unconfirmed';
  if (reason.startsWith('availability phrase outside subject listing')) return 'availability-outside-scope';
  if (reason.startsWith('corroborating page data')) return 'status-corroboration';
  if (reason.startsWith('page data disagrees with phrase')) return 'status-disagreement';
  if (reason.startsWith('page data:')) return 'status-unmapped';
  if (reason.startsWith('$/ac over threshold')) return 'over-threshold';
  if (reason.startsWith('price sources disagree')) return 'price-source-disagreement';
  if (reason.startsWith('price:')) return 'price-mismatch';
  if (reason.startsWith('acres sources disagree')) return 'acres-source-disagreement';
  if (reason.startsWith('acres:')) return 'acres-mismatch';
  if (reason.startsWith('county link missing')) return 'county-link-missing';
  if (reason.startsWith('county mismatch')) return 'county-mismatch';
  if (reason.startsWith('county could not be determined')) return 'county-unresolved';
  if (reason.startsWith('watch zone')) return 'watch-zone';
  return 'other';
}

async function loadTargetRecords(args) {
  if (args.idsPath) {
    const raw = fs.readFileSync(args.idsPath, 'utf8');
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) throw new Error(`--ids file must contain a JSON array of record ids: ${args.idsPath}`);
    const records = [];
    for (const id of ids) {
      records.push(await airtable.getRecordById(id));
    }
    return records;
  }
  return airtable.getRecordsByStage(args.stage);
}

/**
 * Runs the CURRENT extraction pipeline (extractListingDetails, JSON-LD
 * price, structured acres/status, subject-scoped availability flags)
 * against already-in-hand HTML — pulled out of the per-record loop in
 * main() so BOTH the live-fetch path and --replay (which skips the network
 * entirely and feeds this the same page saved by an earlier run) recompute
 * a record's extraction with TODAY's code, not whatever logic captured the
 * original snapshot. Throws on a blocked/empty-shell page, exactly as the
 * inline code used to — callers catch it the same way fetch errors are
 * caught.
 */
function extractFromHtml(html, url, fetcher) {
  if (fetcher.isBlockedPage(html)) {
    throw new Error('Site served a bot-challenge page (even to the browser)');
  }

  const extracted = extractListingDetails(html, url);
  // A content-free HTTP-200 app shell yields no signal — "nothing found" on
  // it is a failed fetch, not a verified-empty listing. Checked only when
  // extraction found nothing (mirrors lib/lead-recheck.js's identical
  // guard).
  const informative = extracted.availabilityFlags.length > 0
    || extracted.acres != null || extracted.price != null;
  if (!informative && isEmptyAppShellHtml(html)) {
    throw new Error('Site served an empty app shell (no rendered content)');
  }

  const ldPrice = extractLdPrice(html);
  const structuredAcres = extractStructuredAcres(html);
  const structuredStatus = extractStructuredStatus(html);

  // Availability flags MUST be derived from HTML scoped to the subject
  // listing (see scopeHtmlToSubjectListing) — a bare full-body scan
  // (extracted.availabilityFlags, from extractListingDetails above) can
  // pick up a status badge that belongs to a DIFFERENT listing in a
  // nearby/similar-listings widget elsewhere on the page.
  const { scopedHtml } = scopeHtmlToSubjectListing(html);
  const scopedBodyText = cheerio.load(scopedHtml)('body').text();
  const $full = cheerio.load(html);
  const rawTitle = (
    $full('meta[property="og:title"]').attr('content')
    || $full('h1').first().text()
    || $full('title').text()
    || ''
  ).trim();
  const ogDescription = ($full('meta[property="og:description"]').attr('content')
    || $full('meta[name="description"]').attr('content')
    || '').trim();
  const scopedFlags = findAvailabilityMatches(`${rawTitle} ${ogDescription} ${scopedBodyText}`);
  // Real text, just not necessarily about THIS listing — Emma reviews it by
  // hand; never grounds to REMOVE on its own (see lib/lead-audit.js's
  // reviewOnlyFlags handling).
  const reviewOnlyFlags = (extracted.availabilityFlags || []).filter(f => !scopedFlags.includes(f));

  return { extracted, ldPrice, structuredAcres, structuredStatus, scopedFlags, reviewOnlyFlags, scopedBodyText };
}

/**
 * Loads --replay's per-record fetch metadata (httpStatus, fetchError,
 * fetchMs) from `<replayDir>/audit.json`, keyed by record id. Returns an
 * empty Map when the file is missing — every record then falls through to
 * loadReplaySnapshot's "no saved page in replay dir" case unless it has an
 * HTML snapshot on disk.
 */
function loadReplayMeta(replayDir) {
  const metaPath = path.join(replayDir, 'audit.json');
  if (!fs.existsSync(metaPath)) return new Map();
  const rows = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const map = new Map();
  for (const row of rows) {
    if (row && row.id) {
      map.set(row.id, {
        httpStatus: row.httpStatus ?? null,
        fetchError: row.fetchError ?? null,
        fetchMs: row.fetchMs ?? null,
      });
    }
  }
  return map;
}

/**
 * Loads one record's saved page for --replay instead of fetching it live.
 * Returns { html, httpStatus, fetchMs, fetchError }. `html` is null when
 * there's no saved snapshot for this record at
 * `<replayDir>/html/<recordId>.html`; `fetchError` then carries either the
 * ORIGINAL run's own recorded failure (from audit.json, when present — a
 * record that 404'd, for instance, never had a page to save) or, when
 * nothing was recorded either, the fixed 'no saved page in replay dir'
 * reason (auditLead turns that into an UNVERIFIED verdict, same as any
 * other fetch failure).
 */
function loadReplaySnapshot(replayDir, recordId, replayMeta) {
  const htmlPath = path.join(replayDir, 'html', `${recordId}.html`);
  const meta = replayMeta.get(recordId) || {};
  if (fs.existsSync(htmlPath)) {
    return {
      html: fs.readFileSync(htmlPath, 'utf8'),
      httpStatus: meta.httpStatus ?? null,
      fetchMs: meta.fetchMs ?? null,
      fetchError: null,
    };
  }
  return {
    html: null,
    httpStatus: meta.httpStatus ?? null,
    fetchMs: meta.fetchMs ?? null,
    fetchError: meta.fetchError || 'no saved page in replay dir',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out || defaultOutDir(args.stage);
  const htmlDir = path.join(outDir, 'html');

  airtable.init();

  // Same guard the nightly job relies on: a county-target load that fell
  // back to the bundled local list (stale, and the cause of the Sept 1
  // incident) must never be treated as authoritative for an audit either —
  // every "county not a target" / "$/ac over threshold" verdict below is
  // only as good as this list.
  const targets = await airtable.loadCountyTargets();
  if (targets.source !== 'airtable') {
    console.error(`[Audit] County targets did not load from Airtable (${targets.warning || 'unknown reason'}). Refusing to audit against the local fallback list.`);
    process.exit(2);
  }
  initFilter(targets.countyMap);

  // Only created once the run is actually going to proceed — a refused run
  // (above) must leave no stray output directory behind.
  fs.mkdirSync(htmlDir, { recursive: true });

  const records = await loadTargetRecords(args);
  const toAudit = args.limit != null ? records.slice(0, args.limit) : records;
  console.log(`[Audit] ${records.length} record(s) loaded${args.limit ? `, auditing first ${toAudit.length}` : ''} — output: ${outDir}`);

  const fetcher = new BaseParser('LeadAudit');
  const minAcres = resolveMinAcres();
  const { FIELDS } = airtable;

  // --replay: no network fetches at all — every record's HTML (and
  // recorded httpStatus/fetchError/fetchMs) is loaded from an EARLIER run's
  // output directory instead; see loadReplaySnapshot / extractFromHtml.
  // Airtable is still read above for the record fields and county targets
  // (read-only, same as a live run).
  let replayMeta = null;
  if (args.replayDir) {
    replayMeta = loadReplayMeta(args.replayDir);
    console.log(`[Audit] --replay ${args.replayDir}: recomputing extraction + verdicts from saved pages, no live fetches`);
  }

  const results = [];
  const csvLines = [csvRow(CSV_HEADER)];
  const verdictCounts = {};
  const reasonCounts = {};
  const sourceCounts = {};
  let fetchFailures = 0;
  const startTime = Date.now();

  for (let i = 0; i < toAudit.length; i++) {
    const record = toAudit[i];
    const fields = record.fields;
    const name = leadName(record);
    const stage = scalarField(fields[FIELDS.stage]);
    const source = fields[FIELDS.source] || null;
    const url = fields[FIELDS.url];

    let html = null;
    let extracted = null;
    let ldPrice = null;
    let structuredAcres = null;
    let scopedFlags = [];
    let reviewOnlyFlags = [];
    let scopedBodyText = '';
    let structuredStatus = null;
    let fetchError = null;
    let httpStatus = null;
    let fetchMs = null;

    if (!url) {
      fetchError = 'no listing URL on record';
    } else {
      const fetchStart = Date.now();
      try {
        if (args.replayDir) {
          // --replay: no network at all. Load whatever an EARLIER run saved
          // for this record and recompute extraction + verdict with the
          // CURRENT code — see loadReplaySnapshot and extractFromHtml.
          const snapshot = loadReplaySnapshot(args.replayDir, record.id, replayMeta);
          httpStatus = snapshot.httpStatus;
          fetchMs = snapshot.fetchMs;
          if (snapshot.html == null) {
            throw Object.assign(new Error(snapshot.fetchError), { status: snapshot.httpStatus });
          }
          html = snapshot.html;
        } else {
          // Stored listing URLs, not user-submitted ones, but the same SSRF
          // guard intake.js applies is cheap and keeps every outbound fetch
          // in this codebase behind one gate.
          if (process.env.SCRAPER_ALLOW_LOOPBACK_FETCH !== 'true') {
            await assertPublicUrl(url);
          }
          await fetcher.sleep(args.delayMs * (0.75 + Math.random() * 1.25));

          html = await fetcher.fetchPageSmart(url);
          if (fetcher.isBlockedPage(html) && browserFetch.isEnabled()) {
            html = await fetcher.browserFetch(url); // challenge page served with HTTP 200 — one browser attempt
          }
          fetchMs = Date.now() - fetchStart;
        }

        // Save whatever we have BEFORE the validity checks inside
        // extractFromHtml, so a blocked/empty-shell page is still on disk
        // for Emma or a reviewer to look at without refetching — same as
        // before, now also true of a --replay run's own output directory.
        fs.writeFileSync(path.join(htmlDir, `${record.id}.html`), html);

        ({
          extracted, ldPrice, structuredAcres, structuredStatus,
          scopedFlags, reviewOnlyFlags, scopedBodyText,
        } = extractFromHtml(html, url, fetcher));
      } catch (err) {
        fetchError = err.message;
        httpStatus = typeof err.status === 'number' ? err.status : null;
        extracted = null;
        fetchMs = fetchMs != null ? fetchMs : Date.now() - fetchStart;
      }
    }

    let verdictResult;
    try {
      const recordedFields = airtable.resolveCountyFields(fields);
      const recordedCounty = recordedFields ? recordedFields.county : null;
      const recordedState = recordedFields ? recordedFields.state : null;

      // County provenance, in trust order: (1) the listing URL's own path,
      // per-source and unambiguous; (2) the page text SCOPED to the subject
      // listing (a nearby-listings widget's county mentions are excluded);
      // (3) the record's existing County link. Only tiers (1) and (3) are
      // trusted enough for lib/lead-audit.js to REMOVE a lead over "county
      // not a target" — see DEFECT 3 / TRUSTED_COUNTY_PROVENANCE.
      let liveCounty = null;
      let liveState = null;
      let countyProvenance = null;
      const urlCounty = url ? deriveCountyFromUrlSlug(url) : null;
      const urlCountyNormalized = urlCounty ? normalizeCountyAgainstAirtable(urlCounty.county, urlCounty.state) : null;
      if (urlCountyNormalized) {
        liveCounty = urlCountyNormalized.county;
        liveState = urlCountyNormalized.state;
        countyProvenance = 'url';
      } else {
        const textPick = url ? extractCountyState(url, scopedBodyText) : { county: null, state: null };
        if (textPick.county) {
          liveCounty = textPick.county;
          liveState = textPick.state;
          countyProvenance = 'text';
        } else if (recordedCounty) {
          liveCounty = recordedCounty;
          liveState = recordedState;
          countyProvenance = 'record';
        }
      }

      const cpaTarget = getCPATarget(liveCounty, liveState);
      const countyRecordId = airtable.getCountyRecordId(liveCounty, liveState);

      // extracted.county/.state/.availabilityFlags, as extractListingDetails
      // returned them, are derived from the UNSCOPED page (full body text) —
      // never passed into auditLead directly; the provenance-aware county
      // above and the scoped availability flags replace them.
      const auditExtracted = extracted
        ? { ...extracted, county: liveCounty, state: liveState, availabilityFlags: scopedFlags }
        : null;

      verdictResult = auditLead({
        fields, extracted: auditExtracted, ldPrice, structuredAcres,
        reviewOnlyFlags, structuredStatus, countyProvenance,
        fetchError, httpStatus, cpaTarget, minAcres,
        countyRecordId, recordedCounty, recordedState,
      });
    } catch (err) {
      // A throw anywhere in this record's handling becomes UNVERIFIED, never
      // an aborted run — one bad record must not cost Emma the other 199.
      verdictResult = {
        verdict: 'UNVERIFIED',
        reasons: [`audit error: ${err.message}`],
        live: { price: null, ldPrice: null, pagePrice: null, acres: null, county: null, state: null, flags: [] },
        recorded: { price: fields[FIELDS.price] ?? null, acres: fields[FIELDS.acres] ?? null, county: null, state: null },
        cpaTarget: null,
        livePricePerAcre: null,
        proposed: {},
      };
    }

    if (fetchError) fetchFailures++;
    verdictCounts[verdictResult.verdict] = (verdictCounts[verdictResult.verdict] || 0) + 1;
    sourceCounts[source || 'unknown'] = (sourceCounts[source || 'unknown'] || 0) + 1;
    for (const reason of verdictResult.reasons) {
      const cat = reasonCategory(reason);
      reasonCounts[cat] = (reasonCounts[cat] || 0) + 1;
    }

    const shortReason = verdictResult.reasons[0] || '';
    console.log(`[Audit] ${i + 1}/${toAudit.length} ${verdictResult.verdict} — ${shortReason || '(no reasons)'} — ${name}`);

    const row = { id: record.id, name, stage, source, url, httpStatus, fetchMs, fetchError, ...verdictResult };
    results.push(row);

    csvLines.push(csvRow([
      record.id, name, stage, source, url,
      verdictResult.recorded.price, verdictResult.recorded.acres, verdictResult.recorded.county, verdictResult.recorded.state,
      verdictResult.live.price, verdictResult.live.ldPrice, verdictResult.live.pagePrice,
      verdictResult.live.acres, verdictResult.live.county, verdictResult.live.state,
      verdictResult.cpaTarget,
      verdictResult.livePricePerAcre != null ? Math.round(verdictResult.livePricePerAcre * 100) / 100 : '',
      verdictResult.live.flags.join('; '),
      verdictResult.verdict, verdictResult.reasons.join(' | '),
      verdictResult.proposed[FIELDS.price] ?? '', verdictResult.proposed[FIELDS.acres] ?? '',
      Array.isArray(verdictResult.proposed[FIELDS.county]) ? verdictResult.proposed[FIELDS.county][0] : '',
    ]));
  }

  const elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  fs.writeFileSync(path.join(outDir, 'audit.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, 'audit.csv'), csvLines.join(''));

  const summaryLines = [];
  summaryLines.push(`CCL Land Lead Audit — ${new Date().toISOString()}`);
  summaryLines.push(`Stage: ${args.idsPath ? `(--ids ${args.idsPath})` : args.stage}`);
  summaryLines.push(`Records audited: ${toAudit.length} of ${records.length} candidates`);
  summaryLines.push(`Elapsed: ${elapsedMinutes} minutes`);
  summaryLines.push(`Fetch failures: ${fetchFailures}`);
  summaryLines.push('');
  summaryLines.push('By verdict:');
  for (const [verdict, count] of Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])) {
    summaryLines.push(`  ${verdict}: ${count}`);
  }
  summaryLines.push('');
  summaryLines.push('Reason counts (a record can carry several):');
  for (const [cat, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    summaryLines.push(`  ${cat}: ${count}`);
  }
  summaryLines.push('');
  summaryLines.push('By source:');
  for (const [src, count] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    summaryLines.push(`  ${src}: ${count}`);
  }
  const summary = summaryLines.join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'summary.txt'), summary);

  console.log('');
  console.log(summary);
  console.log(`[Audit] Wrote ${path.join(outDir, 'audit.json')}, audit.csv, summary.txt, and ${toAudit.length} HTML snapshot(s) under ${htmlDir}`);
}

// Only run against real Airtable/network when executed directly (`node
// scripts/audit-new-leads.js ...`) — required so test/audit-new-leads.test.js
// can require() this module's pure helpers (csvField, parseArgs,
// reasonCategory, extractTitleAcres) without triggering a live run.
if (require.main === module) {
  main().catch(err => {
    console.error(`[Audit] Fatal error: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, csvField, csvRow, reasonCategory, extractLdPrice,
  extractTitleAcres, extractPageLoadAcreage, extractStructuredAcres,
  extractStructuredStatus, scopeHtmlToSubjectListing,
  deriveCountyFromUrlSlug, normalizeCountyAgainstAirtable,
  slugify, defaultOutDir, leadName, scalarField,
  extractFromHtml, loadReplayMeta, loadReplaySnapshot,
};
