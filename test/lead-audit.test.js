'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const airtable = require('../lib/airtable');
const { extractListingDetails } = require('../lib/intake');
const { auditLead, isPriceMismatch, isAcresMismatch } = require('../lib/lead-audit');

const { FIELDS } = airtable;
const MIN_ACRES = 40;

/** A fully "clean" baseline: recorded fields match a live extraction that
 * has nothing wrong with it, in a target county, well under the CPA target.
 * Individual tests override only the fields relevant to what they check. */
function baseInput(overrides = {}) {
  return {
    fields: {
      [FIELDS.price]: 500000,
      [FIELDS.acres]: 100,
      [FIELDS.county]: ['recCounty1'],
    },
    extracted: {
      name: 'Test Tract', description: '', price: 500000, acres: 100,
      county: 'Taney', state: 'MO', availabilityFlags: [],
    },
    ldPrice: null,
    fetchError: null,
    httpStatus: null,
    cpaTarget: 6000, // 500000/100 = 5000/ac, comfortably under target
    minAcres: MIN_ACRES,
    countyRecordId: 'recCounty1',
    recordedCounty: 'Taney',
    recordedState: 'MO',
    ...overrides,
  };
}

test('auditLead: OK when recorded matches live and price/ac is under target', () => {
  const result = auditLead(baseInput());
  assert.equal(result.verdict, 'OK');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.proposed, {});
  assert.equal(result.livePricePerAcre, 5000);
});

// --- REMOVE ------------------------------------------------------------

test('auditLead: REMOVE when the listing is gone (404)', () => {
  const result = auditLead(baseInput({
    extracted: null,
    fetchError: 'HTTP 404 for https://example.com/listing/1',
    httpStatus: 404,
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.some(r => r.includes('listing gone (HTTP 404)')), result.reasons.join('; '));
});

test('auditLead: REMOVE when the listing is gone (410)', () => {
  const result = auditLead(baseInput({
    extracted: null,
    fetchError: 'HTTP 410 for https://example.com/listing/1',
    httpStatus: 410,
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.some(r => r.includes('listing gone (HTTP 410)')));
});

test('auditLead: REMOVE when the page now says under contract', () => {
  const result = auditLead(baseInput({
    extracted: {
      price: 500000, acres: 100, county: 'Taney', state: 'MO',
      availabilityFlags: ['under contract'],
    },
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('now under contract'), result.reasons.join('; '));
});

test('auditLead: REMOVE when live acreage is below the min-acre floor', () => {
  const result = auditLead(baseInput({
    extracted: { price: 175000, acres: 35, county: 'Taney', state: 'MO', availabilityFlags: [] },
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.some(r => r.includes('below 40-acre floor: live 35 ac')), result.reasons.join('; '));
});

test('auditLead: live acres exactly at the min-acre floor is NOT below it', () => {
  const result = auditLead(baseInput({
    // Price/acres chosen (200000/40 = 5000/ac) to stay under the default
    // 6000 cpaTarget, isolating the floor check from the $/ac-over-target
    // check.
    fields: { [FIELDS.price]: 200000, [FIELDS.acres]: 40, [FIELDS.county]: ['recCounty1'] },
    extracted: { price: 200000, acres: 40, county: 'Taney', state: 'MO', availabilityFlags: [] },
  }));
  assert.ok(!result.reasons.some(r => r.includes('below 40-acre floor')), result.reasons.join('; '));
  assert.notEqual(result.verdict, 'REMOVE');
});

test('auditLead: REMOVE when the resolved county is not a target (no Airtable County row at all) and came from the URL', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    countyProvenance: 'url',
    countyRecordId: null, // no Airtable County row resolves for this county at all
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('county not a target: Nowhere, TX'), result.reasons.join('; '));
});

test('auditLead: REMOVE when the resolved county is not a target (no Airtable County row at all) and came from the record\'s County link', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: 'Nowhere',
    recordedState: 'TX',
    countyProvenance: 'record',
    countyRecordId: null,
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('county not a target: Nowhere, TX'), result.reasons.join('; '));
});

// --- POLICY (2026-09-16 orchestrator ruling): county exists in Airtable but
// its CPA Target is BLANK. lib/filter.js's countyMap only has rows that HAVE
// a CPA Target, so a blank-target county is absent from it too — a fresh
// listing there would have been rejected by filterListing() with the exact
// same "County not in target list" reasoning. The verdict stays REMOVE, but
// the reason must say WHICH case this is: Emma can turn a blank-target
// county into a target by filling in the field; a county missing from
// Airtable entirely, she cannot. ------------------------------------------

test('auditLead: POLICY — REMOVE with distinct wording when the county EXISTS in Airtable (countyRecordId resolves) but has no CPA Target', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    countyProvenance: 'url',
    countyRecordId: 'recNowhereTX', // the county row EXISTS, just no CPA Target
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(
    result.reasons.includes('county has no CPA Target in Airtable: Nowhere, TX (rejected by the nightly filter)'),
    result.reasons.join('; ')
  );
  assert.ok(!result.reasons.some(r => r.startsWith('county not a target:')), result.reasons.join('; '));
});

test('auditLead: POLICY — the same blank-CPA-Target REMOVE fires from trusted "record" provenance too', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: 'Nowhere',
    recordedState: 'TX',
    countyProvenance: 'record',
    countyRecordId: 'recNowhereTX',
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(
    result.reasons.includes('county has no CPA Target in Airtable: Nowhere, TX (rejected by the nightly filter)'),
    result.reasons.join('; ')
  );
});

test('auditLead: POLICY — text-only county provenance stays review-only, unaffected by the countyRecordId distinction', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    countyProvenance: 'text',
    countyRecordId: 'recNowhereTX', // even with a resolvable county row, text provenance never REMOVEs
  }));
  assert.notEqual(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('county (from page text) not a target: Nowhere, TX'), result.reasons.join('; '));
  assert.ok(!result.reasons.some(r => r.startsWith('county has no CPA Target')), result.reasons.join('; '));
});

test('auditLead: DEFECT 3 — a county resolved only from SCOPED PAGE TEXT that is not a target is a review-only reason, never REMOVE', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    countyProvenance: 'text',
  }));
  assert.notEqual(result.verdict, 'REMOVE');
  assert.ok(!result.reasons.some(r => r.startsWith('county not a target')), result.reasons.join('; '));
  assert.ok(result.reasons.includes('county (from page text) not a target: Nowhere, TX'), result.reasons.join('; '));
});

test('auditLead: an unspecified county provenance is treated the same as page-text (never REMOVE for "not a target")', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    // countyProvenance intentionally omitted
  }));
  assert.notEqual(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('county (from page text) not a target: Nowhere, TX'), result.reasons.join('; '));
});

test('auditLead: REMOVE when $/acre is more than 30% over the CPA target', () => {
  const result = auditLead(baseInput({
    extracted: { price: 700000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] },
    cpaTarget: 4000, // live $/ac = 7000, +75%
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.some(r => r.startsWith('$/ac over threshold')), result.reasons.join('; '));
});

test('auditLead: $/ac exactly 1.30x the target is NOT REMOVE (the boundary is "more than 30% over", not "30% or more")', () => {
  const result = auditLead(baseInput({
    fields: { [FIELDS.price]: 520000, [FIELDS.acres]: 100, [FIELDS.county]: ['recCounty1'] },
    extracted: { price: 520000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] },
    cpaTarget: 4000, // live $/ac = 5200 = exactly 1.30x
  }));
  assert.notEqual(result.verdict, 'REMOVE');
});

test('auditLead: $/ac at 1.3001x the target IS REMOVE', () => {
  const result = auditLead(baseInput({
    extracted: { price: 520040, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] },
    cpaTarget: 4000, // live $/ac = 5200.4, just over 1.30x
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.some(r => r.startsWith('$/ac over threshold')), result.reasons.join('; '));
});

test('auditLead: UNVERIFIED (never REMOVE) when the county cannot be resolved from either the page or the record', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: null, state: null, availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    countyRecordId: null,
  }));
  assert.equal(result.verdict, 'UNVERIFIED');
  assert.ok(result.reasons.includes('county could not be determined from the page or the record'), result.reasons.join('; '));
  assert.ok(!result.reasons.some(r => r.startsWith('county not a target')), result.reasons.join('; '));
});

test('auditLead: an unresolved county never suppresses a genuine REMOVE reason (flag) on the same record', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: null, state: null, availabilityFlags: ['sold'] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    countyRecordId: null,
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('now sold'), result.reasons.join('; '));
  assert.ok(!result.reasons.some(r => r.startsWith('county not a target')), result.reasons.join('; '));
});

test('auditLead: REMOVE for "county not a target" still fires when the county DID resolve from a trusted source (not confused with unresolved)', () => {
  const result = auditLead(baseInput({
    extracted: { price: 400000, acres: 100, county: 'Nowhere', state: 'TX', availabilityFlags: [] },
    cpaTarget: null,
    recordedCounty: null,
    recordedState: null,
    countyProvenance: 'url',
    countyRecordId: null,
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('county not a target: Nowhere, TX'));
});

test('auditLead: REMOVE (not UNVERIFIED) when the page shows an availability flag but no price/acreage at all', () => {
  const result = auditLead(baseInput({
    extracted: { price: null, acres: null, county: 'Taney', state: 'MO', availabilityFlags: ['sold'] },
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('now sold'), result.reasons.join('; '));
});

test('auditLead: REMOVE collects every applicable reason, not just the first', () => {
  const result = auditLead(baseInput({
    extracted: { price: 175000, acres: 35, county: 'Taney', state: 'MO', availabilityFlags: ['sold'] },
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('now sold'));
  assert.ok(result.reasons.some(r => r.includes('below 40-acre floor')));
});

test('auditLead: REMOVE rows still report recorded-vs-live price and acres deltas as reasons, with no proposed correction', () => {
  const result = auditLead(baseInput({
    fields: { [FIELDS.price]: 1999007, [FIELDS.acres]: 1999007.094, [FIELDS.county]: ['recCounty1'] },
    extracted: { price: 199900, acres: 7.094, county: 'Taney', state: 'MO', availabilityFlags: ['sold'] },
    cpaTarget: 30000,
    minAcres: 1, // isolates from the (unrelated) acre-floor reason
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('now sold'));
  assert.ok(result.reasons.some(r => r.startsWith('price: recorded $1,999,007, live $199,900')), result.reasons.join('; '));
  assert.ok(result.reasons.some(r => r.startsWith('acres: recorded 1999007.094, live 7.094')), result.reasons.join('; '));
  assert.deepEqual(result.proposed, {}); // REMOVE never proposes a correction
});

// --- FIX -----------------------------------------------------------------

test('auditLead: FIX on a recorded-vs-live price mismatch', () => {
  const result = auditLead(baseInput({
    fields: { [FIELDS.price]: 400000, [FIELDS.acres]: 100, [FIELDS.county]: ['recCounty1'] },
    extracted: { price: 450000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] },
    cpaTarget: 10000, // live $/ac = 4500, well under target — isolates the price check
  }));
  assert.equal(result.verdict, 'FIX');
  assert.ok(result.reasons.some(r => r.startsWith('price: recorded $400,000, live $450,000')), result.reasons.join('; '));
  assert.equal(result.proposed[FIELDS.price], 450000);
});

test('auditLead: FIX on a recorded-vs-live acreage mismatch', () => {
  const result = auditLead(baseInput({
    fields: { [FIELDS.price]: 500000, [FIELDS.acres]: 100, [FIELDS.county]: ['recCounty1'] },
    extracted: { price: 500000, acres: 115, county: 'Taney', state: 'MO', availabilityFlags: [] },
    cpaTarget: 10000,
  }));
  assert.equal(result.verdict, 'FIX');
  assert.ok(result.reasons.some(r => r.startsWith('acres: recorded 100, live 115')), result.reasons.join('; '));
  assert.equal(result.proposed[FIELDS.acres], 115);
});

test('auditLead: FIX when the County link is missing but resolvable', () => {
  const result = auditLead(baseInput({
    fields: { [FIELDS.price]: 500000, [FIELDS.acres]: 100 }, // no FIELDS.county at all
  }));
  assert.equal(result.verdict, 'FIX');
  assert.ok(result.reasons.some(r => r.startsWith('county link missing; resolvable to Taney, MO')), result.reasons.join('; '));
  assert.deepEqual(result.proposed[FIELDS.county], ['recCounty1']);
});

test('auditLead: watch zone (20-30% over target) is informational and does not force FIX alone', () => {
  const result = auditLead(baseInput({
    // Recorded price matches live price exactly (and acres/county are
    // untouched) so this case isolates the watch-zone $/ac check — a price
    // or acreage mismatch here would independently force FIX and defeat
    // the point of the test.
    fields: { [FIELDS.price]: 550000, [FIELDS.acres]: 100, [FIELDS.county]: ['recCounty1'] },
    extracted: { price: 550000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] },
    cpaTarget: 4500, // live $/ac = 5500, +22% -> watch zone, not remove
  }));
  assert.equal(result.verdict, 'OK');
  assert.ok(result.reasons.some(r => r.startsWith('watch zone')), result.reasons.join('; '));
});

// --- UNVERIFIED ------------------------------------------------------------

test('auditLead: UNVERIFIED when the fetch itself failed', () => {
  const result = auditLead(baseInput({
    extracted: null,
    fetchError: 'Site served a bot-challenge page (even to the browser)',
    httpStatus: null,
  }));
  assert.equal(result.verdict, 'UNVERIFIED');
  assert.ok(result.reasons.some(r => r.includes('fetch failed')));
});

test('auditLead: UNVERIFIED when nothing could be extracted from a "successful" fetch', () => {
  const result = auditLead(baseInput({
    extracted: { price: null, acres: null, county: null, state: null, availabilityFlags: [] },
  }));
  assert.equal(result.verdict, 'UNVERIFIED');
  assert.ok(result.reasons.includes('could not extract price or acreage from the live page'));
});

// --- price-source disagreement ------------------------------------------

test('auditLead: JSON-LD price wins over page-text price when they disagree by more than 1%', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] },
    ldPrice: 510000, // ~2% over the page-text price
  }));
  assert.ok(result.reasons.some(r => r.includes('price sources disagree: page $500,000 vs structured $510,000')));
  assert.equal(result.live.price, 510000);
  assert.equal(result.live.ldPrice, 510000);
  assert.equal(result.live.pagePrice, 500000);
});

test('auditLead: no disagreement reason when JSON-LD and page price are within 1%', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] },
    ldPrice: 500100, // 0.02% — well within tolerance
  }));
  assert.ok(!result.reasons.some(r => r.includes('price sources disagree')));
  assert.equal(result.live.price, 500100); // structured data still wins when present, just silently
});

// --- acreage source disagreement (DEFECT 2: provenance-aware) -----------

test('auditLead: page_load acreage wins outright over body-text acreage when they disagree by more than 1% (nearby-listings widget case)', () => {
  const result = auditLead(baseInput({
    fields: { [FIELDS.price]: 199900, [FIELDS.acres]: 7.094, [FIELDS.county]: ['recCounty1'] },
    // Real case (rec0gIpbWbIkp9Ly5): body-text extraction picked "8" (the
    // most-frequent figure on the page, from an unrelated nearby-listings
    // widget); the page's own single-listing page_load analytics payload
    // said 7.094 for the actual subject property.
    extracted: { price: 199900, acres: 8, county: 'Taney', state: 'MO', availabilityFlags: [] },
    structuredAcres: { value: 7.094, source: 'page_load' },
    cpaTarget: 30000, // generous target so this isolates the acreage check, not $/ac
    minAcres: 1, // isolates the acreage-source check from the (unrelated) 40ac floor rule
  }));
  assert.ok(result.reasons.some(r => r.includes('acres sources disagree: page_load 7.094 ac vs page 8 ac')), result.reasons.join('; '));
  assert.equal(result.live.acres, 7.094);
  assert.equal(result.verdict, 'OK'); // recorded 7.094 now matches the corrected live value
});

test('auditLead: DEFECT 2 — a rounded TITLE acreage never overrides a precise body acreage; body stays live, only a reason is added', () => {
  const result = auditLead(baseInput({
    fields: { [FIELDS.price]: 175000, [FIELDS.acres]: 39.6, [FIELDS.county]: ['recCounty1'] },
    // Real defect: title says "40 Acres" (rounded); body text says 39.6 —
    // below the 40ac floor. The title reading must never win and propose
    // Acres=40; the record must still REMOVE for being below the floor.
    extracted: { price: 175000, acres: 39.6, county: 'Taney', state: 'MO', availabilityFlags: [] },
    structuredAcres: { value: 40, source: 'title' },
  }));
  assert.ok(result.reasons.some(r => r.includes('acres sources disagree: title 40 ac vs page 39.6 ac')), result.reasons.join('; '));
  assert.equal(result.live.acres, 39.6); // body wins, title never overrides
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.some(r => r.includes('below 40-acre floor: live 39.6 ac')), result.reasons.join('; '));
  assert.deepEqual(result.proposed, {}); // REMOVE, and never proposes the title's 40
});

test('auditLead: no acreage disagreement reason, and the more precise body-text value wins, when structured and body are within 1%', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100.4, county: 'Taney', state: 'MO', availabilityFlags: [] },
    structuredAcres: { value: 100, source: 'title' },
  }));
  assert.ok(!result.reasons.some(r => r.includes('acres sources disagree')));
  assert.equal(result.live.acres, 100.4);
});

// --- availability corroboration (DEFECT 1) --------------------------------

test('auditLead: a review-only availability flag (found outside the subject-listing scope) never forces REMOVE, but is surfaced as a reason', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: [] }, // scoped: clean
    reviewOnlyFlags: ['under contract'], // found only in the unscoped body (a nearby-listings widget)
  }));
  assert.notEqual(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('availability phrase outside subject listing: under contract'), result.reasons.join('; '));
});

test('auditLead: a scoped availability flag still REMOVEs even when a different flag also matched outside scope', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: ['sold'] },
    reviewOnlyFlags: ['under contract'],
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('now sold'));
  assert.ok(result.reasons.includes('availability phrase outside subject listing: under contract'));
});

// --- DEFECT 4: structured status wording depends on whether the mapped
// meaning indicates unavailability, agrees with "active", or is unmapped. ---

test('auditLead: DEFECT 4 — a structured status value mapped as UNAVAILABLE (marketStatus=2, "pending") corroborates a scoped REMOVE flag', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: ['sold'] },
    structuredStatus: { field: 'marketStatus', value: 2 },
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('corroborating page data: marketStatus=2 (pending)'), result.reasons.join('; '));
});

test('auditLead: DEFECT 4 — a structured status value mapped as ACTIVE (marketStatus=1) disagrees with an availability flag instead of "corroborating" it', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: ['sold'] },
    structuredStatus: { field: 'marketStatus', value: 1 },
  }));
  assert.equal(result.verdict, 'REMOVE'); // the scoped flag itself still REMOVEs
  assert.ok(result.reasons.includes('page data disagrees with phrase: marketStatus=1 (active)'), result.reasons.join('; '));
  assert.ok(!result.reasons.some(r => r.startsWith('corroborating page data')), result.reasons.join('; '));
});

test('auditLead: DEFECT 4 — an unmapped structured status value is surfaced plainly, neither corroborating nor disagreeing', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Taney', state: 'MO', availabilityFlags: ['sold'] },
    structuredStatus: { field: 'marketStatus', value: 7 },
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('page data: marketStatus=7 (unmapped)'), result.reasons.join('; '));
});

test('auditLead: a structured status field is not surfaced at all on an otherwise-quiet record (no availability signal to corroborate)', () => {
  const result = auditLead(baseInput({
    structuredStatus: { field: 'marketStatus', value: 1 },
  }));
  assert.ok(!result.reasons.some(r => r.includes('marketStatus')), result.reasons.join('; '));
});

// --- county mismatch -------------------------------------------------------

test('auditLead: county mismatch is surfaced even on a REMOVE verdict (the link could be wrong on a record being removed for an unrelated reason)', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Darlington', state: 'SC', availabilityFlags: ['sold'] },
    cpaTarget: 6000,
    countyRecordId: 'recDarlingtonSC',
    recordedCounty: 'Cherokee',
    recordedState: 'SC',
  }));
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.includes('now sold'));
  assert.ok(result.reasons.some(r => r.startsWith('county mismatch: recorded Cherokee, SC, live Darlington, SC')), result.reasons.join('; '));
  assert.deepEqual(result.proposed, {}); // REMOVE never proposes a correction
});

test('auditLead: county mismatch between the recorded County link and the live page is surfaced and proposes a fix', () => {
  const result = auditLead(baseInput({
    extracted: { price: 500000, acres: 100, county: 'Darlington', state: 'SC', availabilityFlags: [] },
    cpaTarget: 6000,
    countyRecordId: 'recDarlingtonSC',
    recordedCounty: 'Cherokee',
    recordedState: 'SC',
  }));
  assert.equal(result.verdict, 'FIX');
  assert.ok(result.reasons.some(r => r.startsWith('county mismatch: recorded Cherokee, SC, live Darlington, SC')), result.reasons.join('; '));
  assert.deepEqual(result.proposed[FIELDS.county], ['recDarlingtonSC']);
});

// --- helper predicates (exported so tests can hit them directly) --------

test('isPriceMismatch: true when recorded price missing, false when nothing live to compare', () => {
  assert.equal(isPriceMismatch(null, 500000), true);
  assert.equal(isPriceMismatch(500000, null), false);
  assert.equal(isPriceMismatch(500000, 505000), false); // 1% exactly is not "more than 1%"
  assert.equal(isPriceMismatch(500000, 506000), true);
});

test('isAcresMismatch: true when recorded acres missing, false when nothing live to compare', () => {
  assert.equal(isAcresMismatch(null, 100, MIN_ACRES), true);
  assert.equal(isAcresMismatch(100, null, MIN_ACRES), false);
  assert.equal(isAcresMismatch(100, 100, MIN_ACRES), false);
  assert.equal(isAcresMismatch(100, 115, MIN_ACRES), true); // 15% relative swing
  assert.equal(isAcresMismatch(42, 38, MIN_ACRES), true); // crosses the 40ac floor
});

// --- real HTML fixture ----------------------------------------------------

test('auditLead: real listing HTML fixture (landflip-detail-420517) drives the verdict end to end', () => {
  const html = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'landflip-detail-420517.html'), 'utf8'
  );
  const url = 'https://www.landflip.com/listing/420517';
  const extracted = extractListingDetails(html, url);

  // Sanity-check what the fixture actually contains before trusting the
  // verdict built on top of it — an 11-acre tract, price ~$489,900.
  assert.equal(extracted.price, 489900);
  assert.equal(extracted.acres, 11);

  const result = auditLead({
    fields: { [FIELDS.price]: 489900, [FIELDS.acres]: 11 },
    extracted,
    ldPrice: null,
    fetchError: null,
    httpStatus: null,
    cpaTarget: null, // fixture's county doesn't resolve against an empty test county index
    minAcres: MIN_ACRES,
    countyRecordId: null,
    recordedCounty: null,
    recordedState: null,
  });

  // 11ac is below the 40ac floor on its own, independent of county — the
  // fixture's county can't be resolved against an empty test county index
  // (extractCountyState needs airtable.listAllCounties(), unpopulated
  // here), and an UNRESOLVED county must never read as "not a target"
  // (that's a confident, different claim — see the unresolved-county
  // tests above), so no county reason should appear at all here.
  assert.equal(result.verdict, 'REMOVE');
  assert.ok(result.reasons.some(r => r.includes('below 40-acre floor: live 11 ac')), result.reasons.join('; '));
  assert.ok(!result.reasons.some(r => r.startsWith('county not a target')), result.reasons.join('; '));
});
