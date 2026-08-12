'use strict';

const acquisitionCounties = require('../config/acquisition_counties.json');

/**
 * Canonical county-name spellings, keyed off the acquisition target list.
 *
 * Airtable's County table is hand-maintained, so a multi-word county can be
 * stored with its space collapsed — "LeFlore" for what the Census, and every
 * land site's URL scheme, calls "Le Flore". Nothing downstream re-derives the
 * official spelling, so that single character sank the whole county:
 * BaseParser#countySlug turned it into "leflore", and LandWatch answered
 * /oklahoma-land-for-sale/leflore-county with HTTP 400 on the Aug 6 and Aug 9
 * nightlies. Nine target counties are multi-word and carry the same risk.
 *
 * The fix belongs HERE — where county targets enter the run (lib/airtable.js)
 * — rather than in each parser's slug builder, because the parsers disagree
 * about slugs on purpose: LandWatch serves "mccreary-county" while MossyOak
 * serves "mc-creary-county" (both confirmed from captured HTML). Normalizing
 * the NAME once, at the source, fixes every parser without touching a single
 * site-specific rule.
 *
 * Deliberately an alias table derived from the real target list, NOT a
 * camel-case splitting rule: "McCreary" and "McDonald" are genuinely one word
 * and a general rule would corrupt them into "mc-creary"/"mc-donald" for the
 * sources that don't want that.
 */

/** Collapse a county name to a comparison key: letters and digits only. */
function collapseKey(county) {
  return String(county == null ? '' : county)
    .toLowerCase()
    .replace(/\bcounty\b/g, '')
    .replace(/\bparish\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const canonicalByStateKey = new Map(); // "collapsed|ST" -> canonical name
const canonicalByName = new Map();     // "collapsed" -> Set<canonical name>

for (const entry of acquisitionCounties.counties || []) {
  if (!entry || !entry.county || !entry.state) continue;
  const key = collapseKey(entry.county);
  if (!key) continue;
  canonicalByStateKey.set(`${key}|${String(entry.state).toUpperCase()}`, entry.county);
  if (!canonicalByName.has(key)) canonicalByName.set(key, new Set());
  canonicalByName.get(key).add(entry.county);
}

/**
 * The official spelling of a county name, or the input unchanged when the
 * name isn't a known target (never guess at a spelling we have no record of).
 *
 * State is matched when supplied, and it matters: Oklahoma's "Le Flore" and
 * Mississippi's "Leflore" are DIFFERENT counties whose names collapse to the
 * same key, and both states are in the target list. Without a state, the name
 * is only rewritten when exactly one canonical spelling exists across every
 * target state — an ambiguous name is left alone rather than resolved by
 * coin-flip.
 */
function canonicalCountyName(county, state) {
  const key = collapseKey(county);
  if (!key) return county;

  // When the state is known it is the ONLY authority: a name that isn't a
  // target in THAT state stays exactly as written. Falling back to the
  // name-only index here is what would rewrite Mississippi's "Leflore" into
  // Oklahoma's "Le Flore" — a different county in a different state.
  if (state) {
    return canonicalByStateKey.get(`${key}|${String(state).toUpperCase()}`) || county;
  }

  const candidates = canonicalByName.get(key);
  if (candidates && candidates.size === 1) return [...candidates][0];
  return county;
}

module.exports = { canonicalCountyName, collapseKey };
