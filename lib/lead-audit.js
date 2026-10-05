'use strict';

// Pure verdict logic for the read-only lead audit (scripts/audit-new-leads.js).
// No I/O here on purpose — every fetch, Airtable lookup, and filter-target
// lookup happens in the caller; this file only turns already-gathered facts
// into a verdict + reasons + proposed corrections, so it can be exhaustively
// unit-tested without a network or an Airtable token.
//
// Only require('./airtable') for the FIELDS name map (a plain object, no
// I/O at require time) — never hardcode Airtable field names here.
const { FIELDS } = require('./airtable');
// Reuse the SAME recorded-vs-live acreage rule the nightly recheck already
// uses (10% relative swing, or crossing the minAcres floor in opposite
// directions) instead of re-implementing it here.
const { isAcreageMismatch } = require('./lead-recheck');

// "differs by more than 1%" for both price-source disagreement (page vs
// JSON-LD) and recorded-vs-live price mismatch.
const PRICE_RELATIVE_THRESHOLD = 0.01;

// Matches config/settings.json filtering.newLeadThreshold /
// .watchThreshold — the SAME 20%/30% boundaries lib/filter.js's
// filterListing() already applies when a fresh listing is first scraped, so
// an audited lead is judged by the identical rule that would have kept it
// out (or watched it) on day one.
const WATCH_ZONE_OVER_PERCENT = 0.20;
const REMOVE_OVER_PERCENT = 0.30;

// "differs by more than 1%" for the title-vs-body acreage disagreement
// check — same tolerance as the price-source check, for the same reason
// (two independent readings of the same number should match almost
// exactly; a real discrepancy means one of them is reading the wrong
// listing).
const ACRES_RELATIVE_THRESHOLD = 0.01;

// County provenance tiers that are trustworthy enough to REMOVE a lead for
// "county not a target". A county picked out of unscoped/scoped PAGE TEXT
// is never on this list — a nearby-listings widget or a comp paragraph can
// name a different county than the subject property's, so text-only picks
// only ever become a review-only reason (see auditLead below). Only a
// county read straight off the listing URL's own path (the parser's own,
// unambiguous URL scheme) or the record's existing County link are
// confident enough to remove a lead over.
const TRUSTED_COUNTY_PROVENANCE = new Set(['url', 'record']);

// LandWatch's own page-state marketStatus enum, and the ONLY structured
// status field this audit currently reads (extractStructuredStatus in
// scripts/audit-new-leads.js) — verified against real saved LandWatch
// detail pages captured during this audit: every page carrying
// marketStatus=1 also carried a listhubListingStatus of null or "Active"
// (1 = active/available, confirmed); the one page seen with marketStatus=2
// carried listhubListingStatus="Pending" (2 = pending, confirmed
// unavailable for a fresh offer). Every other value is deliberately left
// unmapped rather than guessed at — see DEFECT 4.
const MARKET_STATUS_MEANINGS = {
  1: { meaning: 'active', unavailable: false },
  2: { meaning: 'pending', unavailable: true },
};

/**
 * Words a structured-status corroboration reason based on whether the
 * mapped meaning (when known) indicates the listing is unavailable, agrees
 * with an "available" reading, or is simply unmapped (see DEFECT 4):
 *   - unavailable ("sold"/"pending"/etc.): "corroborating page data:
 *     <field>=<value> (<meaning>)" — genuinely backs up the availability
 *     flag it's alongside.
 *   - available ("active"): "page data disagrees with phrase: <field>=
 *     <value> (<meaning>)" — the structured field says this listing is
 *     still active even though an availability phrase matched; Emma should
 *     see the two sources disagree, not read it as corroboration.
 *   - unmapped: "page data: <field>=<value> (unmapped)" — neither confirms
 *     nor contradicts; just surfaced as-is.
 */
function describeStructuredStatus(field, value) {
  const mapping = field === 'marketStatus' ? MARKET_STATUS_MEANINGS[value] : undefined;
  if (!mapping) return `page data: ${field}=${value} (unmapped)`;
  if (mapping.unavailable) {
    return `corroborating page data: ${field}=${value} (${mapping.meaning})`;
  }
  return `page data disagrees with phrase: ${field}=${value} (${mapping.meaning})`;
}

/**
 * Recorded price is missing, or differs from the live price by more than
 * 1% relative. `livePrice == null` (nothing live to compare against) is
 * never a mismatch — that case is handled upstream as UNVERIFIED.
 */
function isPriceMismatch(recordedPrice, livePrice) {
  if (livePrice == null) return false;
  if (!(recordedPrice > 0)) return true;
  return Math.abs(recordedPrice - livePrice) / recordedPrice > PRICE_RELATIVE_THRESHOLD;
}

/**
 * Recorded acres is missing, or the pair disagrees per
 * lib/lead-recheck.js's isAcreageMismatch (>=10% relative, or opposite
 * sides of minAcres). `liveAcres == null` is never a mismatch — nothing to
 * propose a correction from.
 */
function isAcresMismatch(recordedAcres, liveAcres, minAcres) {
  if (liveAcres == null) return false;
  if (!(recordedAcres > 0)) return true;
  return isAcreageMismatch(recordedAcres, liveAcres, minAcres);
}

/**
 * Live county/state: what the page itself said, falling back to the
 * record's own County link / State lookup (resolveCountyFields in
 * lib/airtable.js) when the page didn't yield one — a listing that no
 * longer mentions its county by name still has a county on file.
 */
function resolveLiveLocation(extracted, recordedCounty, recordedState) {
  const ex = extracted || {};
  return {
    county: ex.county || recordedCounty || null,
    state: ex.state || recordedState || null,
  };
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLoc(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function money(n) {
  if (n == null || !Number.isFinite(n)) return '$0';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * Audit one Land record against what its listing page says right now.
 *
 * Verdict precedence is UNVERIFIED > REMOVE > FIX > OK (first applicable
 * category wins), but every reason within the winning category is
 * collected — a lead can be both "over threshold" and "below the acre
 * floor", and Emma should see both, not just the first one found.
 *
 * `extracted.availabilityFlags` MUST already be scoped to the subject
 * listing by the caller (scopeHtmlToSubjectListing + findAvailabilityMatches
 * in scripts/audit-new-leads.js) — a bare full-body scan can pick up a
 * "Under Contract" badge on a DIFFERENT listing inside a nearby/similar-
 * listings widget elsewhere on the page. `reviewOnlyFlags` carries any
 * availability phrase that matched the UNscoped body but not the scoped
 * one — real signal Emma should see, but never grounds to REMOVE on its
 * own (see the "availability phrase outside subject listing" reason below).
 *
 * `structuredAcres`, when given, is `{ value, source }` with
 * source `'page_load'` (a page's own single-listing analytics payload —
 * can't be polluted by a nearby-listings widget) or `'title'` (the page's
 * <h1>/og:title/<title> — narrower than the body-text mode-vote, but often
 * ROUNDED, e.g. "40 Acres" for a 39.6-acre tract). page_load wins outright
 * on disagreement with the body reading, same as before this distinction
 * existed. A title/body disagreement never overrides the body value — it's
 * surfaced as a reason and nothing more, since a rounded title must never
 * win out over a precise body-text reading.
 *
 * `countyProvenance` records where `extracted.county`/`.state` came from:
 * `'url'` (the listing URL's own path, per-source and unambiguous),
 * `'record'` (the record's existing County link, no page-text involved),
 * or `'text'` (picked out of page text — scoped or not, still just text a
 * nearby-listings widget or comp paragraph could have supplied). Only
 * `'url'`/`'record'` are trusted enough to REMOVE a lead for "county not a
 * target" — see TRUSTED_COUNTY_PROVENANCE above.
 *
 * `structuredStatus`, when given, is `{ field, value }` read from a page's
 * own structured/analytics payload for the SUBJECT listing (e.g.
 * LandWatch's page-state `marketStatus`) — corroborating signal alongside
 * whatever findAvailabilityMatches found, surfaced as a reason whenever
 * there's an availability flag (scoped or review-only) to corroborate.
 */
function auditLead({
  fields = {},
  extracted,
  ldPrice = null,
  structuredAcres = null,
  reviewOnlyFlags = [],
  structuredStatus = null,
  countyProvenance = null,
  fetchError = null,
  httpStatus = null,
  cpaTarget = null,
  minAcres,
  countyRecordId = null,
  recordedCounty = null,
  recordedState = null,
}) {
  const recorded = {
    price: numOrNull(fields[FIELDS.price]),
    acres: numOrNull(fields[FIELDS.acres]),
    county: recordedCounty || null,
    state: recordedState || null,
  };

  // A confirmed-gone listing (410, or 404 — treated the same: Airtable
  // holds an intake row and a page that isn't there any more) is a REMOVE,
  // never an UNVERIFIED, however fetchPage's error message reads.
  const isGone = httpStatus === 404 || httpStatus === 410;

  const ex = extracted || {};
  const pagePrice = numOrNull(ex.price);
  // Already scoped to the subject listing by the caller — see the
  // function-level comment above.
  const flags = Array.isArray(ex.availabilityFlags) ? ex.availabilityFlags : [];
  const bodyAcres = numOrNull(ex.acres);
  const { county: liveCounty, state: liveState } = resolveLiveLocation(ex, recordedCounty, recordedState);

  const reasons = [];
  // JSON-LD structured data wins when the two page-derived prices disagree
  // by more than 1% — it's machine-generated and far less prone to the
  // free-text mis-parses (a "$3,000/acre comp" caught as the listing price)
  // that the prose-scanning extractPrice() is vulnerable to.
  let livePrice = ldPrice != null ? ldPrice : pagePrice;
  if (ldPrice != null && pagePrice != null && pagePrice > 0) {
    const relDiff = Math.abs(ldPrice - pagePrice) / pagePrice;
    if (relDiff > PRICE_RELATIVE_THRESHOLD) {
      reasons.push(`price sources disagree: page ${money(pagePrice)} vs structured ${money(ldPrice)}`);
      livePrice = ldPrice;
    }
  }

  // extractAcres() (the body-text extraction behind ex.acres) picks the
  // MOST-FREQUENT acreage figure on the page, largest on ties — correct for
  // the common case (the subject property's acreage is repeated), but wrong
  // when a "Nearby Related Properties" widget mentions a different tract's
  // acreage more than once (real case: a 7.094ac subject listing lost to
  // "8 acres", which appeared twice across two unrelated nearby listings).
  // structuredAcres is a narrower-scope reading the caller pulls from a
  // single-listing source that widget can't pollute — the page's own
  // "page_load" analytics payload when present (scripts/audit-new-leads.js's
  // extractPageLoadAcreage) — which wins outright on disagreement, exactly
  // like ldPrice wins over pagePrice above. A 'title' reading is narrower
  // than the body-text vote too, but titles round ("40 Acres" for 39.6), so
  // it NEVER overrides the body value on disagreement — only the reason is
  // recorded, so Emma can see the two sources disagree without risking a
  // rounded-title correction getting proposed as truth.
  let liveAcres = structuredAcres != null ? structuredAcres.value : bodyAcres;
  if (structuredAcres != null && bodyAcres != null && bodyAcres > 0) {
    const relDiff = Math.abs(structuredAcres.value - bodyAcres) / bodyAcres;
    if (relDiff > ACRES_RELATIVE_THRESHOLD) {
      reasons.push(`acres sources disagree: ${structuredAcres.source} ${structuredAcres.value} ac vs page ${bodyAcres} ac`);
      liveAcres = structuredAcres.source === 'page_load' ? structuredAcres.value : bodyAcres;
    } else {
      // Within tolerance — prefer the body-text reading here (more
      // precise/decimal-friendly than a title's often-rounded figure)
      // rather than silently swap to a coarser number, unlike the price
      // case where ldPrice is exact currency either way.
      liveAcres = bodyAcres;
    }
  }

  // The record IS linked to a County, but the page itself names a
  // different one — the link could be stale or simply wrong. Surfaced
  // unconditionally (like the price/acres source-disagreement reasons
  // above), not only on a FIX/OK verdict — Emma needs to know her County
  // link is wrong on a record she's about to REMOVE for an unrelated
  // reason too, since it means whatever $/ac target that record was
  // originally screened against may have been the wrong county's.
  const countyLinked = Array.isArray(fields[FIELDS.county]) && fields[FIELDS.county].length > 0;
  let countyMismatchNote = null;
  if (countyLinked && ex.county && recorded.county && (
    normalizeLoc(ex.county) !== normalizeLoc(recorded.county)
    || (ex.state && recorded.state && normalizeLoc(ex.state) !== normalizeLoc(recorded.state))
  )) {
    countyMismatchNote = `county mismatch: recorded ${recorded.county}, ${recorded.state}, live ${ex.county}, ${ex.state || recorded.state}`;
    reasons.push(countyMismatchNote);
  }

  // A phrase that matched somewhere on the page but NOT within the
  // subject-listing-scoped region — real text, just not necessarily about
  // THIS listing (a nearby/similar-listings widget elsewhere on the page).
  // Never a REMOVE reason on its own; Emma reviews it by hand.
  const hasReviewOnlyFlags = Array.isArray(reviewOnlyFlags) && reviewOnlyFlags.length > 0;
  if (hasReviewOnlyFlags) {
    for (const flag of reviewOnlyFlags) {
      reasons.push(`availability phrase outside subject listing: ${flag}`);
    }
  }

  // A structured/analytics field carrying the SUBJECT listing's own status
  // (e.g. LandWatch's page-state marketStatus) — corroborating signal,
  // surfaced only when there's an availability flag (scoped or
  // review-only) for it to corroborate; on an otherwise-quiet record it's
  // just noise.
  if (structuredStatus && (flags.length > 0 || hasReviewOnlyFlags)) {
    reasons.push(describeStructuredStatus(structuredStatus.field, structuredStatus.value));
  }

  const live = { price: livePrice, ldPrice, pagePrice, acres: liveAcres, county: liveCounty, state: liveState, flags };
  const livePricePerAcre = (livePrice != null && liveAcres != null && liveAcres > 0)
    ? livePrice / liveAcres
    : null;
  const base = { recorded, cpaTarget, live, livePricePerAcre };

  // --- UNVERIFIED ---------------------------------------------------
  if (fetchError && !isGone) {
    return { verdict: 'UNVERIFIED', reasons: [...reasons, `fetch failed: ${fetchError}`], proposed: {}, ...base };
  }
  // A "successful" fetch that yielded neither a price nor an acreage is a
  // blocked page, an empty app shell, or markup drift the runner couldn't
  // classify — there's nothing here to compare against Airtable. BUT an
  // availability flag (sold/under contract/off-market) is still real
  // signal even when the price and acreage are gone from the page (sites
  // routinely strip both once a listing closes) — that case is a REMOVE
  // below, never an UNVERIFIED.
  if (!isGone && livePrice == null && liveAcres == null && flags.length === 0) {
    return {
      verdict: 'UNVERIFIED',
      reasons: [...reasons, 'could not extract price or acreage from the live page'],
      proposed: {},
      ...base,
    };
  }

  // Recorded-vs-live price/acres deltas — computed once, reused whether the
  // record ends up REMOVE (informational only — no proposed correction on a
  // record already being pulled) or FIX (proposes the live value).
  const priceMismatchFlag = isPriceMismatch(recorded.price, livePrice);
  const priceDeltaReason = priceMismatchFlag
    ? `price: recorded ${recorded.price != null ? money(recorded.price) : 'missing'}, live ${money(livePrice)}`
    : null;
  const acresMismatchFlag = isAcresMismatch(recorded.acres, liveAcres, minAcres);
  const acresDeltaReason = acresMismatchFlag
    ? `acres: recorded ${recorded.acres != null ? recorded.acres : 'missing'}, live ${liveAcres}`
    : null;

  // --- REMOVE ---------------------------------------------------------
  const removeReasons = [];
  if (isGone) removeReasons.push(`listing gone (HTTP ${httpStatus})`);
  if (flags.length > 0) removeReasons.push(`now ${flags[0]}`);
  if (liveAcres != null && liveAcres < minAcres) {
    removeReasons.push(`below ${minAcres}-acre floor: live ${liveAcres} ac`);
  }

  // cpaTarget is null both when the county genuinely isn't a target AND
  // when no county could be resolved at all (page didn't name one, no
  // County link on the record). Those are NOT the same finding: the first
  // is a confident "this county is off-target", the second is "we don't
  // know", and a "we don't know" must never read as grounds to remove a
  // lead. Only emit the REMOVE reason when a county/state actually
  // resolved from a TRUSTED source (the URL or the record's own County
  // link) — a county picked only out of page text (scoped or not) is
  // demoted to a review-only reason, since a comp paragraph or a
  // nearby-listings widget can name a county that isn't the subject
  // property's; otherwise fall through to UNVERIFIED below, but only when
  // nothing else already earned a real REMOVE (an unresolved county on an
  // otherwise-confirmed-gone or now-sold listing still removes it).
  //
  // Among trusted-provenance "not a target" REMOVEs, distinguish two
  // different underlying facts so Emma can tell them apart (policy ruling):
  // a county with NO row in the Airtable County table at all
  // (countyRecordId resolves to null — lib/filter.js's countyMap simply has
  // no entry, "County not in target list") vs. a county that DOES exist in
  // Airtable (countyRecordId resolves) but whose CPA Target field is
  // BLANK. lib/filter.js's countyMap is built only from rows that HAVE a
  // CPA Target — a blank-target county is therefore absent from countyMap
  // too, and filterListing() would have rejected a fresh listing there with
  // the exact same "County not in target list" reasoning. So the verdict is
  // REMOVE either way — a blank-target county is not a target on a normal
  // night — but the wording tells Emma WHICH case it is, since a
  // blank-target county is one she could turn into a target just by filling
  // in the field, where a county missing from Airtable entirely is not.
  let unresolvedCounty = false;
  if (cpaTarget == null) {
    if (liveCounty && liveState) {
      if (TRUSTED_COUNTY_PROVENANCE.has(countyProvenance)) {
        if (countyRecordId) {
          removeReasons.push(`county has no CPA Target in Airtable: ${liveCounty}, ${liveState} (rejected by the nightly filter)`);
        } else {
          removeReasons.push(`county not a target: ${liveCounty}, ${liveState}`);
        }
      } else {
        reasons.push(`county (from page text) not a target: ${liveCounty}, ${liveState}`);
      }
    } else {
      unresolvedCounty = true;
    }
  }

  let overPercent = null;
  if (cpaTarget != null && livePricePerAcre != null) {
    overPercent = (livePricePerAcre - cpaTarget) / cpaTarget;
    if (overPercent > REMOVE_OVER_PERCENT) {
      removeReasons.push(
        `$/ac over threshold: ${money(livePricePerAcre)}/ac vs ${money(cpaTarget)}/ac target (+${Math.round(overPercent * 100)}%)`
      );
    }
  }

  if (removeReasons.length > 0) {
    // Emma can still see what's corrupted on a record that's being removed
    // anyway — but REMOVE never proposes a correction.
    if (priceDeltaReason) removeReasons.push(priceDeltaReason);
    if (acresDeltaReason) removeReasons.push(acresDeltaReason);
    return { verdict: 'REMOVE', reasons: [...reasons, ...removeReasons], proposed: {}, ...base };
  }

  if (unresolvedCounty) {
    return {
      verdict: 'UNVERIFIED',
      reasons: [...reasons, 'county could not be determined from the page or the record'],
      proposed: {},
      ...base,
    };
  }

  // --- FIX / OK ---------------------------------------------------------
  const proposed = {};
  const fixReasons = [];
  let forceFix = false;

  if (priceMismatchFlag) {
    fixReasons.push(priceDeltaReason);
    proposed[FIELDS.price] = livePrice;
    forceFix = true;
  }

  if (acresMismatchFlag) {
    fixReasons.push(acresDeltaReason);
    proposed[FIELDS.acres] = liveAcres;
    forceFix = true;
  }

  if (!countyLinked && countyRecordId) {
    const resolvedCounty = liveCounty || recorded.county;
    const resolvedState = liveState || recorded.state;
    fixReasons.push(`county link missing; resolvable to ${resolvedCounty}, ${resolvedState}`);
    proposed[FIELDS.county] = [countyRecordId];
    forceFix = true;
  } else if (countyMismatchNote) {
    // Already pushed into `reasons` unconditionally above (REMOVE/UNVERIFIED
    // records need the flag too); here we only add the proposed correction
    // and force the verdict up to FIX for a record that would otherwise be
    // OK. Only propose a link change when countyRecordId actually resolved
    // (the caller looks it up against the LIVE county).
    if (countyRecordId) proposed[FIELDS.county] = [countyRecordId];
    forceFix = true;
  }

  // Watch zone (20-30% over target) is informational only — it rides along
  // in `reasons` but never forces FIX by itself; see filterListing()'s
  // identical 20%/30% split in lib/filter.js.
  if (overPercent != null && overPercent > WATCH_ZONE_OVER_PERCENT && overPercent <= REMOVE_OVER_PERCENT) {
    fixReasons.push(`watch zone: ${money(livePricePerAcre)}/ac is ${Math.round(overPercent * 100)}% over ${money(cpaTarget)}/ac target`);
  }

  return {
    verdict: forceFix ? 'FIX' : 'OK',
    reasons: [...reasons, ...fixReasons],
    proposed,
    ...base,
  };
}

module.exports = {
  auditLead,
  isPriceMismatch,
  isAcresMismatch,
  resolveLiveLocation,
  describeStructuredStatus,
  TRUSTED_COUNTY_PROVENANCE,
};
