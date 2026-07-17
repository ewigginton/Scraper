'use strict';

// Per-site county rotation: a site configured with countyRotation N sweeps
// 1/Nth of the target counties each night, covering every county across N
// consecutive nights. Purpose: shrink nightly footprint on bot-defended sites
// (the CoStar family behind Akamai) without dropping coverage.
//
// The partition is deterministic and stateless — no state files:
//   - group membership = stableHash(`${county}|${state}`) mod N (a county
//     always lands in the same group)
//   - tonight's group   = dayIndex(runDate) mod N
// So N consecutive nights cover every county exactly once, and a restart the
// same night re-selects the identical subset.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * FNV-1a hash of a string, returned as an unsigned 32-bit integer. Stable
 * across processes and Node versions — no reliance on Math.random or object
 * iteration order — so the same county key always maps to the same group.
 */
function stableHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function countyKey(target) {
  return `${target.county}|${target.state}`;
}

/**
 * Whole days between `date`'s local calendar day and the epoch. Local time so
 * the rotation flips at the operator's midnight, matching the 2 AM nightly run.
 */
function dayIndex(date) {
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(localMidnight.getTime() / MS_PER_DAY);
}

/**
 * Select the target counties a site sweeps tonight. rotationN absent, non-
 * integer, or < 2 → identity: every county, and rotation === null so callers
 * report nothing. Otherwise returns tonight's group plus a summary for the
 * report/email. `date` is the run's start Date.
 */
function selectRotationCounties(counties, rotationN, date) {
  const groupsTotal = Number(rotationN);
  if (!Number.isInteger(groupsTotal) || groupsTotal < 2) {
    return { counties, rotation: null };
  }

  const groupIndex = ((dayIndex(date) % groupsTotal) + groupsTotal) % groupsTotal;
  const selected = counties.filter(
    target => stableHash(countyKey(target)) % groupsTotal === groupIndex
  );

  return {
    counties: selected,
    rotation: {
      groupsTotal,
      groupIndex, // 0-based; reports render groupIndex + 1
      sweptCount: selected.length,
      totalCount: counties.length,
    },
  };
}

module.exports = { stableHash, dayIndex, selectRotationCounties };
