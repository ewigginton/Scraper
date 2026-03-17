'use strict';

const settings = require('../config/settings.json');

// County map is loaded dynamically from Airtable at startup
let countyMap = null; // Map<"county|state", maxCPA>

/**
 * Initialize the filter with county targets loaded from Airtable.
 * Must be called before filterListing().
 */
function initFilter(airtableCountyMap) {
  countyMap = airtableCountyMap;
  console.log(`[Filter] Initialized with ${countyMap.size} county targets`);
}

/**
 * Validate and classify a parsed listing.
 *
 * Returns an object with:
 *   - passed: boolean (whether it should be written to Airtable)
 *   - stage: 'New Lead' | 'Watch For Price Drop' | null
 *   - reason: human-readable explanation of the decision
 *   - validationErrors: array of data quality issues found
 *   - cpaTarget: the county's max $/acre
 *   - overPercent: how far over target (0.15 = 15%)
 */
function filterListing(listing) {
  if (!countyMap) {
    throw new Error('Filter not initialized — call initFilter(countyMap) first');
  }

  const result = {
    passed: false,
    stage: null,
    reason: '',
    validationErrors: [],
    cpaTarget: null,
    overPercent: null,
  };

  // --- Data quality checks ---
  if (!listing.price || listing.price <= 0) {
    result.validationErrors.push('Missing or invalid price');
  }
  if (!listing.acres || listing.acres <= 0) {
    result.validationErrors.push('Missing or invalid acreage');
  }
  if (!listing.county) {
    result.validationErrors.push('Missing county');
  }
  if (!listing.state) {
    result.validationErrors.push('Missing state');
  }
  if (!listing.url) {
    result.validationErrors.push('Missing listing URL');
  }

  if (result.validationErrors.length > 0) {
    result.reason = `Data validation failed: ${result.validationErrors.join('; ')}`;
    return result;
  }

  // --- Acreage check ---
  if (listing.acres < settings.filtering.minAcres) {
    result.reason = `Below minimum acreage: ${listing.acres}ac < ${settings.filtering.minAcres}ac`;
    return result;
  }

  // --- County check ---
  const countyKey = `${listing.county.toLowerCase()}|${listing.state.toUpperCase()}`;
  const maxCPA = countyMap.get(countyKey);

  if (maxCPA === undefined) {
    result.reason = `County not in target list: ${listing.county}, ${listing.state}`;
    return result;
  }

  result.cpaTarget = maxCPA;

  // --- Compute and validate $/acre ---
  const computedCPA = listing.price / listing.acres;

  // Sanity check: if listing already has $/acre, verify it matches our calculation
  if (listing.pricePerAcre) {
    const diff = Math.abs(computedCPA - listing.pricePerAcre);
    if (diff > 50) {
      // More than $50/acre discrepancy — flag it but use our calculation
      result.validationErrors.push(
        `$/acre discrepancy: site says $${listing.pricePerAcre.toFixed(0)}, ` +
        `computed $${computedCPA.toFixed(0)} (using computed)`
      );
    }
  }

  const cpa = computedCPA;
  listing.computedCPA = Math.round(cpa * 100) / 100;

  // --- Price threshold check ---
  const overPercent = (cpa - maxCPA) / maxCPA;
  result.overPercent = overPercent;

  const { newLeadThreshold, watchThreshold } = settings.filtering;

  if (cpa <= maxCPA) {
    // At or below target — great deal
    result.passed = true;
    result.stage = 'New Lead';
    result.reason = `At/below target: $${Math.round(cpa)}/ac vs $${maxCPA}/ac target (${Math.round(overPercent * 100)}%)`;
    return result;
  }

  if (overPercent <= newLeadThreshold) {
    // Up to 20% over — still a lead
    result.passed = true;
    result.stage = 'New Lead';
    result.reason = `Within threshold: $${Math.round(cpa)}/ac is ${Math.round(overPercent * 100)}% over $${maxCPA}/ac target`;
    return result;
  }

  if (overPercent <= watchThreshold) {
    // 20-30% over — watch for price drop
    result.passed = true;
    result.stage = 'Watch For Price Drop';
    result.reason = `Watch zone: $${Math.round(cpa)}/ac is ${Math.round(overPercent * 100)}% over $${maxCPA}/ac target`;
    return result;
  }

  // Over 30% — reject
  result.reason = `Over threshold: $${Math.round(cpa)}/ac is ${Math.round(overPercent * 100)}% over $${maxCPA}/ac target (max ${Math.round(watchThreshold * 100)}%)`;
  return result;
}

/**
 * Look up the CPA target for a county.
 */
function getCPATarget(county, state) {
  if (!countyMap) return null;
  const key = `${(county || '').toLowerCase()}|${(state || '').toUpperCase()}`;
  return countyMap.get(key) || null;
}

/**
 * Check if a county+state is in our target list.
 */
function isTargetCounty(county, state) {
  return getCPATarget(county, state) !== null;
}

module.exports = {
  initFilter,
  filterListing,
  getCPATarget,
  isTargetCounty,
};
