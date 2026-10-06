'use strict';

const cheerio = require('cheerio');
const { findAvailabilityMatches } = require('./availability');
const { ACREAGE_NUMBER, parseAcreageNumber } = require('./acreage');
const { STATE_ABBREV_TO_FULL, STATE_FULL_TO_ABBREV } = require('./states');
const { extractPrice } = require('./price-checker');

/**
 * Reads the SUBJECT listing of a listing detail page: its own status, price,
 * acreage, county and state, never a value that belongs to a different
 * listing shown elsewhere on the same page.
 *
 * Why this exists: a whole-page text scan (the old lib/intake.js
 * extractListingDetails) attributed a "Nearby Properties" widget's
 * "Under Contract" badge or acreage to the subject listing, and on TuttLand
 * every page's search-filter menu lists "Under Contract Sold". Listing Intake
 * rejected and the nightly lead recheck reported listings on that basis.
 *
 * Each known site is read from the block that belongs to the listing itself.
 * These rules were verified by two adversarial reviewers on 420 real saved
 * pages (the 2026-10-05 New Lead cleanup):
 *   - LandWatch: the meta description "View N acres priced at $X in <City>,
 *     <County> County, ST" plus the status word shown right after
 *     "View all N pictures". A page without that meta description is an
 *     error shell (the listing is gone or the page did not render), so it is
 *     unreadable, never "available".
 *   - Whitetail Properties: the page header "Interactive Map <status> $P ·
 *     A± Acres <County> County". Sold/pending pages drop the price; their
 *     status comes from the details field "Status <word> Property For more
 *     information" and the acreage from the "Shop ... A± Acres" header.
 *   - Mossy Oak Properties: the details block "Status: <s> Price: $P
 *     Acres: A", "County: <c> Acres:" and "City, State: <city>, <State>".
 *   - National Land Realty: the header "<County> County, ST <title> ACTIVE N
 *     +/- Acres $P".
 *   - TuttLand: status from the property panel's own badge ("730 acres
 *     Active") and JSON-LD offers.availability; whichever says pending/sold
 *     wins. Never from the search-filter menu ("Under Contract Sold" is on
 *     every page) or the related-listing tiles.
 *   - LANDFLIP, LandAndFarm (and National Land without its header): status
 *     from JSON-LD offers.availability merged with a subject-scoped text read
 *     (title, h1, meta description, and the body cut before any Nearby/
 *     Similar/Related listings section) — the real LANDFLIP detail page has
 *     no availability field, so JSON-LD alone would never see "Under
 *     Contract". Whichever says pending/sold wins. Nothing found -> status
 *     null (unknown), never "available".
 *   - Any other site: the generic extraction, scoped to the subject (the HTML
 *     is cut at the first Nearby/Similar/Related listings section, and inline
 *     "otherListings" JSON arrays are removed) before phrases and acreage are
 *     read.
 *
 * Pure function of (html, url): no network, no Airtable.
 *
 * Returns {
 *   ok,          // true when the subject listing block was found and read
 *   source,      // which reader ran ('LandWatch', ..., 'generic')
 *   status,      // the status text as the page shows it ('Under Contract'), or null
 *   statusKind,  // 'active' | 'pending' | 'sold' | null (unknown: callers must
 *                //  not treat null as "available")
 *   unavailable, // statusKind is 'pending' or 'sold'
 *   price, acres, county, state, // subject values; null when not shown
 *   note,        // why ok is false, or a caveat
 * }
 * county is the bare county name ("Le Flore"); state is a 2-letter
 * abbreviation. Callers still match the county against the Airtable County
 * table themselves.
 */
function readListingSubject(html, url) {
  const source = detectSource(url);
  if (!html || typeof html !== 'string') {
    return finish({ ok: false, source, note: 'no page content' });
  }
  const reader = SOURCE_READERS[source] || readGeneric;
  try {
    return finish({ source, ...reader(html, url, source) });
  } catch (err) {
    return finish({ ok: false, source, note: `could not read the listing (${err.message})` });
  }
}

function finish(result) {
  const statusKind = result.ok ? classifyStatus(result.status) : null;
  return {
    ok: Boolean(result.ok),
    source: result.source || 'generic',
    status: result.ok && result.status ? String(result.status).trim() : null,
    statusKind,
    unavailable: statusKind === 'pending' || statusKind === 'sold',
    price: result.ok ? positiveOrNull(result.price) : null,
    acres: result.ok ? positiveOrNull(result.acres) : null,
    county: result.ok && result.county ? String(result.county).trim() : null,
    state: result.ok ? validStateAbbrev(result.state) : null,
    note: result.note || null,
  };
}

/** Which per-site reader applies to a URL, by hostname. */
function detectSource(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return 'generic';
  }
  if (host.endsWith('landwatch.com')) return 'LandWatch';
  if (host.endsWith('whitetailproperties.com')) return 'WhitetailProperties';
  if (host.endsWith('mossyoakproperties.com')) return 'MossyOakProperties';
  if (host.endsWith('nationalland.com')) return 'NationalLandRealty';
  if (host.endsWith('tuttland.com')) return 'TuttLand';
  if (host.endsWith('landflip.com')) return 'LANDFLIP';
  if (host.endsWith('landandfarm.com')) return 'LandAndFarm';
  return 'generic';
}

/**
 * Status text -> 'active' | 'pending' | 'sold' | null. Sold/off-market is
 * checked first ("Sold" never means pending), then pending/under contract
 * ("Pending Under Contract", "Sale Pending"), then the active words each site
 * uses ("Available", "For Sale", "New Listing", "Reduced", "Active").
 */
function classifyStatus(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (/\bsold\b|off[\s-]*market|no longer available|withdrawn|expired/.test(s)) return 'sold';
  if (/under[\s-]*contract|pending|contingent/.test(s)) return 'pending';
  if (/available|for sale|active|\bnew\b|reduced|auction|listing|price change/.test(s)) return 'active';
  return null;
}

// ---------------------------------------------------------------------------
// Per-site readers
// ---------------------------------------------------------------------------

function readLandWatch(html, url) {
  const $ = cheerio.load(html);
  const meta = String($('meta[name="description"]').attr('content') || '');
  const m = meta.match(/^\s*View ([\d,.]+) acres? priced at \$([\d,]+) in (.*)$/i);
  if (!m) return { ok: false, note: 'LandWatch page has no listing summary (error shell)' };
  const location = m[3];
  const cm = location.match(/([A-Za-z .'-]+?) County, ([A-Z]{2})\b/);
  const statusMatch = visibleText(html).match(/View all \d+ pictures? (Available|Under Contract|Off Market|Sold|Pending|Auction|New)\b/i);
  const slug = countyFromUrlSlug(url);
  return {
    ok: true,
    acres: parseAcreageNumber(m[1]),
    price: num(m[2]),
    county: cm ? cm[1].split(', ').pop().trim() : null,
    state: cm ? cm[2] : slug && slug.state,
    status: statusMatch ? statusMatch[1] : null,
    note: statusMatch ? null : 'LandWatch status word not shown',
  };
}

function readWhitetail(html, url) {
  const t = visibleText(html);
  const slug = countyFromUrlSlug(url);
  const slugState = slug && slug.state;
  // The details field is the listing's own status; sold/pending pages drop
  // the price header entirely.
  const detailStatus = (t.match(/Status ([A-Za-z ]{2,40}?) Property For more information/) || [])[1] || null;
  if (detailStatus && /sold|pending|under contract|off market/i.test(detailStatus)) {
    const h = t.match(/Shop (?:[A-Za-z ]{2,30}?) ([\d,.]+)± Acres ([A-Za-z .'-]+?) County/);
    return { ok: true, status: detailStatus, price: null, acres: h ? parseAcreageNumber(h[1]) : null, county: h ? h[2].trim() : (slug && slug.county), state: slugState };
  }
  let m = t.match(/Interactive Map (.{0,40}?)\$([\d,]+) · ([\d,.]+)± Acres(?: · \$[\d,]+ Price \/ Acre)? ([A-Za-z .'-]+?) County/);
  if (m) return { ok: true, status: m[1].trim() || 'For Sale', price: num(m[2]), acres: parseAcreageNumber(m[3]), county: m[4].trim(), state: slugState };
  m = t.match(/Interactive Map (Pending Under Contract|Under Contract|Pending|Sold)[^·]{0,20}· ([\d,.]+)± Acres ([A-Za-z .'-]+?) County/);
  if (m) return { ok: true, status: m[1], price: null, acres: parseAcreageNumber(m[2]), county: m[3].trim(), state: slugState };
  return { ok: false, note: 'Whitetail listing header not found' };
}

function readMossyOak(html, url) {
  const t = visibleText(html);
  const m = t.match(/Status: (.*?) Price: (\$[\d,]+|[A-Za-z ]+?) Acres: ([\d,.]+)/);
  if (!m) return { ok: false, note: 'Mossy Oak details block not found' };
  const c = t.match(/County: ([A-Za-z .'-]+?) Acres:/);
  const s = t.match(/City, State: [A-Za-z .'-]+, ([A-Za-z ]+?) County:/);
  const slug = countyFromUrlSlug(url);
  return {
    ok: true,
    status: m[1].trim(),
    price: num(m[2]),
    acres: parseAcreageNumber(m[3]),
    county: c ? c[1].trim() : (slug && slug.county),
    state: s ? fullStateToAbbrev(s[1]) : (slug && slug.state),
  };
}

function readNationalLand(html, url, source) {
  const t = visibleText(html);
  const header = /\b(ACTIVE|PENDING|UNDER CONTRACT|SOLD)\s+([\d,.]+)\s*\+\/-\s*Acres\s*\$([\d,]+)/.exec(t);
  if (!header) return readJsonLdSite(html, url, source);
  // County/state: the "<County> County, ST" line printed just above the
  // listing title, else the page title "... in <County> County, <State> (".
  let county = null;
  let state = null;
  const before = t.slice(Math.max(0, header.index - 300), header.index);
  const re = /([A-Z][a-z.'-]+(?: [A-Z][a-z.'-]+){0,2}) County, ([A-Z]{2})\b/g;
  let cm;
  while ((cm = re.exec(before)) !== null) { county = cm[1]; state = cm[2]; }
  if (!county) {
    const title = cheerio.load(html)('title').text();
    const tm = title.match(/ in ([A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,2}) County, ([A-Za-z ]+?)\s*(?:\(|\||$)/);
    if (tm) { county = tm[1]; state = fullStateToAbbrev(tm[2]) || tm[2]; }
  }
  return {
    ok: true,
    status: header[1],
    acres: parseAcreageNumber(header[2]),
    price: num(header[3]),
    county,
    state,
  };
}

/**
 * TuttLand / LANDFLIP / LandAndFarm (and National Land without its header):
 * status from JSON-LD offers.availability plus one more reading of the
 * subject's own status:
 *   - TuttLand: its property panel's status badge (readTuttLandHeaderStatus),
 *     NEVER free page text — its search-filter menu prints "Under Contract
 *     Sold" on every page.
 *   - the others: the subject-scoped text read (readSubjectTextStatus), the
 *     same one unknown sites get. LANDFLIP pages carry no JSON-LD
 *     availability at all, so without it a sold/under-contract LANDFLIP
 *     listing would read as unknown and be imported.
 * Whichever reading says pending/sold wins. No reading -> status null.
 */
function readJsonLdSite(html, url, source) {
  const ld = readJsonLd(html);
  const ldStatus = availabilityToStatus(ld.availability);
  let headerStatus = null;
  let textStatus = null;
  let price = ld.price;
  let acres = null;
  let county = null;
  let state = null;
  const slug = countyFromUrlSlug(url);

  if (source === 'TuttLand') {
    const t = visibleText(html);
    // Header: "Explore the Property <address> $1,995,000 730 acres Active"
    const h = t.match(/Explore the Property .{0,160}?\$([\d,]+) ([\d,.]+) acres/i);
    if (h) {
      if (price == null) price = num(h[1]);
      acres = parseAcreageNumber(h[2]);
    }
    if (acres == null && ld.name) {
      const n = ld.name.match(new RegExp(`(${ACREAGE_NUMBER})\\s*(?:\\+/-|±)?\\s*acres?`, 'i'));
      if (n) acres = parseAcreageNumber(n[1]);
    }
    // Breadcrumb: "Land for Sale in Alabama / Bibb County / Eoline"
    const b = t.match(/Land for Sale in ([A-Za-z ]+?) \/ ([A-Za-z .'-]+?) County\b/);
    if (b) {
      county = b[2].trim();
      state = fullStateToAbbrev(b[1]);
    }
    // The subject's own status badge in the property panel header
    // ("$1,995,000 | 730 acres | Active"). Read alongside JSON-LD; whichever
    // says pending/sold wins (see mergeStatus).
    headerStatus = readTuttLandHeaderStatus(html, t);
  } else if (source === 'LANDFLIP') {
    textStatus = readSubjectTextStatus(html);
    // LandflipParser.parseDetailPage reads price from JSON-LD and
    // acreage/county/state from the meta description — the listing's own.
    const LandflipParser = require('./parsers/landflip');
    const detail = new LandflipParser().parseDetailPage(html) || {};
    if (price == null && detail.price) price = detail.price;
    acres = detail.acres || null;
    county = detail.county || null;
    state = detail.state || null;
  } else {
    // LandAndFarm / National Land without its header: the subject-scoped
    // generic values; its status already merges JSON-LD with the
    // subject-scoped text read.
    const generic = readGeneric(html, url, source);
    if (price == null) price = generic.price;
    acres = generic.acres;
    textStatus = generic.status || null;
  }

  if (!county && slug) county = slug.county;
  if (!state && slug) state = slug.state;
  const status = mergeStatus(headerStatus, ldStatus, textStatus);
  if (price == null && acres == null && !status) {
    return { ok: false, note: 'listing price, acreage and status not found' };
  }
  return { ok: true, status, price, acres, county, state, note: status ? null : 'listing status not shown on the page' };
}

/**
 * TuttLand's property panel prints the subject's stats as
 * <div class="tl-property-stat"><strong>730 acres</strong></div>
 * <div class="tl-property-stat"><strong>Active</strong></div>. The status is
 * the stat that is not an acreage. Falls back to the same header in visible
 * text ("Explore the Property <address> $P N acres <Status>"). Never reads the
 * search-filter menu or the related-listing tiles.
 */
function readTuttLandHeaderStatus(html, text) {
  const $ = cheerio.load(html);
  const stats = $('aside.tl-property-panel .tl-property-stat strong')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(v => v && !/\bacres?\b/i.test(v));
  const fromPanel = stats.find(v => classifyStatus(v) !== null);
  if (fromPanel) return fromPanel;
  const m = String(text).match(/Explore the Property .{0,160}?\$[\d,]+ [\d,.]+ acres (Active|Under Contract|Contract Pending|Sale Pending|Pending|Contingent|Sold|Off Market|New|Reduced)\b/i);
  return m ? m[1] : null;
}

/**
 * Two readings of the same listing's status (a page header and JSON-LD, or
 * JSON-LD and subject-scoped page text): accurate data first, so whichever
 * says sold/pending wins (sold over pending); otherwise the first non-empty
 * reading.
 */
function mergeStatus(...readings) {
  const present = readings.filter(Boolean);
  const sold = present.find(r => classifyStatus(r) === 'sold');
  if (sold) return sold;
  const pending = present.find(r => classifyStatus(r) === 'pending');
  if (pending) return pending;
  return present.find(r => classifyStatus(r) === 'active') || present[0] || null;
}

/**
 * The subject listing's status as its own page text states it, or null.
 * Reads the availability phrases (lib/availability.js) in the page title,
 * og:title, the first h1, the meta/og descriptions, and the body cut before
 * any Nearby/Similar/Related listings section (scopeHtmlToSubjectListing).
 * Each title-like field is checked on its own so the anchored "SOLD - <name>"
 * prefix is seen wherever it appears. Sold beats pending (mergeStatus).
 */
function readSubjectTextStatus(html) {
  const { scopedHtml } = scopeHtmlToSubjectListing(html);
  const $ = cheerio.load(html);
  const scoped$ = cheerio.load(scopedHtml);
  const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
  const fields = [
    clean($('title').first().text()),
    clean($('meta[property="og:title"]').attr('content')),
    clean(scoped$('h1').first().text()),
    clean($('meta[name="description"]').attr('content')),
    clean($('meta[property="og:description"]').attr('content')),
  ].filter(Boolean);
  const bodyStart = scopedHtml.search(/<body[^>]*>/i);
  const scopedBody = visibleText(bodyStart >= 0 ? scopedHtml.slice(bodyStart) : '').trim();
  const matches = [];
  for (const text of [...fields, scopedBody]) {
    if (text) matches.push(...findAvailabilityMatches(text));
  }
  return mergeStatus(...matches);
}

/**
 * Any other site: the old whole-page extraction, but on HTML scoped to the
 * subject listing (see scopeHtmlToSubjectListing). Status from JSON-LD and
 * the subject-scoped text read (readSubjectTextStatus); whichever says
 * pending/sold wins. ok only when the page told us something (price, acreage
 * or status).
 */
function readGeneric(html, _url, _source) {
  const { scopedHtml } = scopeHtmlToSubjectListing(html);
  const $ = cheerio.load(html);
  const rawTitle = (
    $('meta[property="og:title"]').attr('content')
    || $('h1').first().text()
    || $('title').text()
    || ''
  ).trim();
  const description = ($('meta[property="og:description"]').attr('content')
    || $('meta[name="description"]').attr('content')
    || '').trim();
  // Tag boundaries become spaces (cheerio's .text() glues "<h1>Tract</h1><p>
  // Under Contract" into "TractUnder Contract", which no whole-word phrase
  // matches); script/style bodies are not page text.
  const bodyStart = scopedHtml.search(/<body[^>]*>/i);
  const scopedBody = visibleText(bodyStart >= 0 ? scopedHtml.slice(bodyStart) : scopedHtml);

  const ld = readJsonLd(html);
  // JSON-LD and the subject-scoped page text are both consulted; an on-page
  // "Under Contract" / "SOLD - " wins over a stale JSON-LD InStock.
  const status = mergeStatus(availabilityToStatus(ld.availability), readSubjectTextStatus(html));
  const price = extractPrice(scopedHtml);
  const acres = extractAcres(`${rawTitle} ${description} ${scopedBody}`);
  if (price == null && acres == null && !status) {
    return { ok: false, note: 'no price, acreage or status found on the page' };
  }
  return { ok: true, status, price, acres, county: null, state: null };
}

const SOURCE_READERS = {
  LandWatch: readLandWatch,
  WhitetailProperties: readWhitetail,
  MossyOakProperties: readMossyOak,
  NationalLandRealty: readNationalLand,
  TuttLand: readJsonLdSite,
  LANDFLIP: readJsonLdSite,
  LandAndFarm: readJsonLdSite,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Visible text: scripts/styles removed, common entities decoded, whitespace collapsed. */
function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&middot;|&#183;|&#xB7;/gi, '·')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ');
}

/** First JSON-LD offers.availability / price / name found on the page. */
function readJsonLd(html) {
  const out = { availability: null, price: null, name: null };
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch (_) {
      continue; // malformed JSON-LD is common on real sites
    }
    walkJsonLd(data, out, 0);
  }
  return out;
}

function walkJsonLd(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, out, depth + 1);
    return;
  }
  if (node.availability && !out.availability) out.availability = String(node.availability);
  if (node.price != null && out.price == null) {
    const p = num(node.price);
    if (p != null && p > 1000) out.price = p;
  }
  if (typeof node.name === 'string' && !out.name && /acre/i.test(node.name)) out.name = node.name;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walkJsonLd(value, out, depth + 1);
  }
}

/** schema.org availability -> a status word, or null when absent/unknown. */
function availabilityToStatus(availability) {
  if (!availability) return null;
  const a = String(availability);
  if (/SoldOut|Discontinued|OutOfStock/i.test(a)) return 'Sold';
  if (/InStock|OnlineOnly|InStoreOnly/i.test(a)) return 'Available';
  // PreOrder / LimitedAvailability / anything else: no saved page shows what a
  // site means by it, so the status stays unknown rather than guessed.
  return null;
}

/**
 * Acreage from free text: "160 acres", "155± Acres", "30 +/- acres",
 * "1,118-acre ranch". Detail pages usually repeat the property's own acreage
 * most often — the most frequent value wins, largest on ties. Callers should
 * pass subject-scoped text (nearby-listing widgets contribute stray figures).
 */
function extractAcres(text) {
  if (!text) return null;
  const candidates = [];
  const re = new RegExp(`(${ACREAGE_NUMBER})\\s*(?:±|\\+\\/-|\\+-)?\\s*[- ]?acres?\\b`, 'gi');
  let match;
  while ((match = re.exec(text)) !== null && candidates.length < 25) {
    const value = parseAcreageNumber(match[1]);
    if (value !== null && value < 100000) candidates.push(value);
  }
  if (candidates.length === 0) return null;
  const counts = new Map();
  for (const value of candidates) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))[0][0];
}

function num(value) {
  if (value == null) return null;
  const n = parseFloat(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function positiveOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function fullStateToAbbrev(name) {
  if (!name) return null;
  return STATE_FULL_TO_ABBREV[String(name).replace(/-/g, ' ').trim().toLowerCase()] || null;
}

function validStateAbbrev(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (s.length === 2 && STATE_ABBREV_TO_FULL[s.toUpperCase()]) return s.toUpperCase();
  return fullStateToAbbrev(s);
}

// Full state names, hyphenated and longest first, for URL slugs that put
// county and state in one hyphenated segment ("...-county-south-carolina-...").
const STATE_SLUG_ALTERNATION = Object.keys(STATE_FULL_TO_ABBREV)
  .map(full => full.replace(/\s+/g, '-'))
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * County/state named by a listing URL in each site's own scheme, or null.
 * Returns { county (title case), state (2-letter) }. Same schemes as
 * scripts/audit-new-leads.js deriveCountyFromUrlSlug.
 */
function countyFromUrlSlug(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path;
  try {
    path = decodeURIComponent(u.pathname).toLowerCase();
  } catch (_) {
    path = u.pathname.toLowerCase();
  }
  const titleCase = slug => slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  const make = (county, state) => ({ county: titleCase(county), state: fullStateToAbbrev(state) });
  let m;
  if (host.endsWith('landwatch.com')) {
    m = new RegExp(`/([a-z]+(?:-[a-z]+)*)-county-(${STATE_SLUG_ALTERNATION})(?:-|/|$)`).exec(path);
    return m ? make(m[1], m[2]) : null;
  }
  if (host.endsWith('whitetailproperties.com')) {
    m = /\/hunting-land\/([^/]+)\/([^/]+)\//.exec(path);
    return m ? make(m[2], m[1]) : null;
  }
  if (host.endsWith('mossyoakproperties.com')) {
    m = new RegExp(`/property/(.+)-(${STATE_SLUG_ALTERNATION})/\\d+/?$`).exec(path);
    if (!m) return null;
    const tokens = m[1].split('-').filter(Boolean);
    return tokens.length ? make(tokens[tokens.length - 1], m[2]) : null;
  }
  if (host.endsWith('tuttland.com')) {
    m = /\/land-sale\/([^/]+)\/([^/]+)-county\//.exec(path);
    return m ? make(m[2], m[1]) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subject scoping for the generic reader (moved from
// scripts/audit-new-leads.js scopeHtmlToSubjectListing)
// ---------------------------------------------------------------------------

// Nearby/similar/related/"more listings" widget keywords — matched against a
// heading's own text, an element's class/id attribute, or an inline JSON
// widget key. Never against body prose ("access to nearby public land").
const BOUNDARY_KEYWORDS_RE = /nearby|similar|related|recommended|also-?\s*like|other-?\s*listings/i;
const JSON_WIDGET_KEY_RE = /"(?:other|nearby|related|similar)[-_]?listings"\s*:/i;

/** Blanks <style> contents (same length, so offsets stay valid). */
function blankStyleBlocks(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, m => ' '.repeat(m.length));
}

function findHeadingBoundary(region) {
  const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    if (BOUNDARY_KEYWORDS_RE.test(m[1].replace(/<[^>]+>/g, ' '))) return m.index;
  }
  return -1;
}

function findAttrBoundary(region) {
  const re = /<[a-z][a-z0-9]*\b[^>]*\b(?:class|id)\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    if (BOUNDARY_KEYWORDS_RE.test(m[1])) return m.index;
  }
  return -1;
}

/** Index of the bracket matching the '['/'{' at openIndex (string-aware), or -1. */
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

/** Removes inline "otherListings"-style JSON arrays (key through matching bracket). */
function excludeJsonWidgetSpans(html) {
  const bodyMatch = /<body[^>]*>/i.exec(html);
  const searchStart = bodyMatch ? bodyMatch.index + bodyMatch[0].length : 0;
  let result = html;
  let found = false;
  for (;;) {
    const m = JSON_WIDGET_KEY_RE.exec(result.slice(searchStart));
    if (!m) break;
    const keyStart = searchStart + m.index;
    let valueStart = keyStart + m[0].length;
    while (valueStart < result.length && /\s/.test(result[valueStart])) valueStart++;
    const valueEnd = findMatchingBracketEnd(result, valueStart);
    if (valueEnd === -1) break;
    result = result.slice(0, keyStart) + result.slice(valueEnd + 1);
    found = true;
  }
  return { html: result, found };
}

/**
 * Cuts html at the first nearby/similar/related listings section (a heading
 * or a class/id-named block, searched from <body> with <style> blanked) after
 * removing inline JSON widget arrays. Returns { scopedHtml, boundaryFound }.
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

module.exports = {
  readListingSubject,
  detectSource,
  classifyStatus,
  scopeHtmlToSubjectListing,
  extractAcres,
  countyFromUrlSlug,
  visibleText,
};
