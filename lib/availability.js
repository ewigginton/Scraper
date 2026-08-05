'use strict';

/**
 * Availability-status phrases and the whole-word matcher used to find them.
 *
 * Canonical, single source of truth — lib/review.js (flags them for Emma,
 * never auto-rejects), lib/intake.js (flags newly-submitted URLs), and
 * lib/scraper.js (skips them entirely before the Airtable write, so a fresh
 * lead never arrives already under contract) all import from here instead of
 * keeping their own copies. IMPORTANT: every consumer must read matches
 * through findAvailabilityMatches (not by filtering AVAILABILITY_FLAGS
 * itself) — that array alone doesn't carry the anchored 'sold' detection
 * below.
 *
 * Only SPECIFIC availability phrases — the bare word 'contingent' was left
 * out because it false-positives on ordinary closing prose ("access
 * contingent upon a survey"), which describes a closing condition, not THIS
 * listing's own status. 'sold' has the same comp-prose problem ("similar
 * tracts have sold for $3,000/acre") but Emma still needs it detected, so
 * it's handled separately below by SOLD_PATTERNS instead of as a bare word.
 */
const AVAILABILITY_FLAGS = [
  'under contract', 'sale pending', 'pending sale',
  'no longer available', 'off market', 'off-market',
];

/**
 * 'sold' cannot be a plain AVAILABILITY_FLAGS entry — a bare \bsold\b would
 * also catch ordinary comp/closing prose ("similar tracts have sold for
 * $3,000/acre", "sold comps support this price", "we sold 3 tracts nearby
 * last year"), which describes NEIGHBORING sales, not this listing's own
 * status. These patterns instead anchor "sold" to the listing announcing its
 * OWN status:
 *   - the scanned text (name first, per every caller's convention of putting
 *     the listing name/title at the front) STARTS with a "SOLD -" / "SOLD
 *     OUT -" status prefix — the hyphen is load-bearing: it's what separates
 *     "SOLD - Big Ranch" (a status tag) from "sold comps support this price"
 *     (ordinary prose that also happens to start with the word "sold").
 *   - "Status: Sold"
 *   - "has been sold"
 *   - "now sold" / "just sold"
 * None of these match "tracts HAVE sold for...", "we sold 3 tracts...", or
 * "sold comps...".
 */
const SOLD_PATTERNS = [
  /^\s*sold(?:\s+out)?\s*-/i,
  // The ENTIRE scanned text is just "SOLD"/"SOLD OUT" — the residue left when
  // an upstream title cleaner (lib/intake.js cleanTitle) strips a
  // "SOLD - <name>" status prefix at its hyphen. Anchored on both ends, so
  // prose that merely contains or starts with "sold" can never match.
  /^\s*sold(?:\s+out)?\s*$/i,
  /\bstatus\s*:\s*sold\b/i,
  /\bhas\s+been\s+sold\b/i,
  /\b(?:now|just)\s+sold\b/i,
];

const keywordRegexCache = new Map();

/**
 * Whole-word keyword match, tolerant of hyphen/whitespace variants between
 * a multi-word keyword's own words ('under contract' also matches
 * 'under-contract' and 'Under  contract' — a double space) since listing
 * copy is inconsistent about the separator. Plain substring matching
 * produced false alarms like "Shoal Creek" tripping the "hoa" flag; the
 * whole-word boundary still applies at each end so "open pasture with no
 * restrictions" never matches "under contract".
 */
function matchesKeyword(text, keyword) {
  let regex = keywordRegexCache.get(keyword);
  if (!regex) {
    const pattern = keyword
      .split(/\s+/)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s-]+');
    regex = new RegExp(`\\b${pattern}\\b`, 'i');
    keywordRegexCache.set(keyword, regex);
  }
  return regex.test(text);
}

/** True when any of SOLD_PATTERNS anchors "sold" to the listing's own status. */
function matchesSold(text) {
  return SOLD_PATTERNS.some(re => re.test(text));
}

/**
 * Which availability-status phrases (if any) appear in the given text, as
 * the raw matched phrases (e.g. ['under contract', 'sold']) — callers format
 * them as needed ('listed as under contract' in review.js, a skip reason in
 * scraper.js). The sole entry point every consumer must use — filtering
 * AVAILABILITY_FLAGS directly skips the anchored 'sold' detection.
 */
function findAvailabilityMatches(text) {
  const matches = AVAILABILITY_FLAGS.filter(kw => matchesKeyword(text, kw));
  if (matchesSold(text)) matches.push('sold');
  return matches;
}

module.exports = { AVAILABILITY_FLAGS, matchesKeyword, findAvailabilityMatches };
