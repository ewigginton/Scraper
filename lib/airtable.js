'use strict';

const Airtable = require('airtable');
const { generateFingerprint } = require('./fingerprint');

const BATCH_SIZE = 10; // Airtable API max per request
const RATE_LIMIT_DELAY = 250; // ms between batches (5 req/sec limit)
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

let base = null;

function init() {
  if (!process.env.AIRTABLE_LAND_TOKEN || !process.env.AIRTABLE_BASE_ID) {
    throw new Error('Missing AIRTABLE_LAND_TOKEN or AIRTABLE_BASE_ID in environment');
  }
  Airtable.configure({
    apiKey: process.env.AIRTABLE_LAND_TOKEN,
    requestTimeout: 30000,
  });
  base = Airtable.base(process.env.AIRTABLE_BASE_ID);
}

/**
 * Load all existing records for deduplication.
 * Returns { urlSet, fingerprintSet, records } where:
 *   - urlSet: Set of existing listing URLs
 *   - fingerprintSet: Set of existing property fingerprints
 *   - records: Array of { id, fields } for all active records
 */
async function loadDedupIndex() {
  if (!base) init();

  const urlSet = new Set();
  const fingerprintSet = new Set();
  const records = [];

  await new Promise((resolve, reject) => {
    base('Leads').select({
      fields: ['Listing URL', 'PropertyFingerprint', 'Stage', 'Name', 'County', 'State', 'Acres', 'LP', '$/A'],
      // Exclude rejected records from dedup — we don't care about re-finding them
      filterByFormula: "AND({Stage} != 'Not Interested')",
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        for (const rec of pageRecords) {
          const url = rec.get('Listing URL');
          const fp = rec.get('PropertyFingerprint');

          if (url) urlSet.add(url);
          if (fp) fingerprintSet.add(fp);

          records.push({ id: rec.id, fields: rec.fields });
        }
        fetchNextPage();
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  return { urlSet, fingerprintSet, records };
}

/**
 * Check if a listing is a duplicate.
 * Returns { isDuplicate, reason, matchType } where matchType is 'url' | 'fingerprint' | null.
 */
function checkDuplicate(listing, dedupIndex) {
  // Layer 1: exact URL match
  if (listing.url && dedupIndex.urlSet.has(listing.url)) {
    return { isDuplicate: true, reason: `URL already exists: ${listing.url}`, matchType: 'url' };
  }

  // Layer 2: property fingerprint match
  const fp = generateFingerprint(listing);
  if (fp && dedupIndex.fingerprintSet.has(fp)) {
    return { isDuplicate: true, reason: `Property fingerprint match (cross-site duplicate)`, matchType: 'fingerprint' };
  }

  return { isDuplicate: false, reason: null, matchType: null };
}

/**
 * Write a batch of validated, non-duplicate listings to Airtable.
 * Each listing should already have passed filtering and dedup checks.
 *
 * listing shape: {
 *   name, price, acres, computedCPA, cpaTarget, county, state,
 *   url, source, description, coordinates, daysOnMarket,
 *   stage, filterReason, validationErrors, fingerprint
 * }
 */
async function writeListings(listings) {
  if (!base) init();
  if (!listings.length) return { created: 0, errors: [] };

  const errors = [];
  let created = 0;

  // Convert to Airtable records
  const airtableRecords = listings.map(l => ({
    fields: {
      'Name': l.name || 'Unnamed Listing',
      'LP': l.price,
      'Acres': l.acres,
      '$/A': l.computedCPA,
      'CPA Top Target': undefined, // Lookup field — set by Airtable
      'County': l.county,
      'State': l.state,
      'Listing URL': l.url,
      'Source': l.source,
      'Coordinate': l.coordinates || '',
      'Property Notes': l.description || '',
      'Days On The Market': l.daysOnMarket || null,
      'Stage': l.stage,
      'PropertyFingerprint': l.fingerprint,
      'ValidationStatus': l.validationErrors && l.validationErrors.length > 0 ? 'Has Warnings' : 'Clean',
      'FilterReason': l.filterReason || '',
    }
  }));

  // Remove undefined fields (like CPA Top Target which is a lookup)
  for (const rec of airtableRecords) {
    for (const [key, val] of Object.entries(rec.fields)) {
      if (val === undefined) delete rec.fields[key];
    }
  }

  // Write in batches of 10
  for (let i = 0; i < airtableRecords.length; i += BATCH_SIZE) {
    const batch = airtableRecords.slice(i, i + BATCH_SIZE);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await base('Leads').create(batch, { typecast: true });
        created += batch.length;
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES - 1) {
          errors.push({ batch: i, error: err.message });
        } else {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          await sleep(delay);
        }
      }
    }

    // Rate limiting
    if (i + BATCH_SIZE < airtableRecords.length) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  return { created, errors };
}

/**
 * Update an existing record's fields (for price drops, stage changes, etc.).
 * Respects stage protection — won't overwrite if Emma has manually changed the stage.
 */
async function updateRecord(recordId, fields, protectStage = true) {
  if (!base) init();

  if (protectStage && fields.Stage) {
    // Fetch current stage first
    const record = await retryFetch(() => base('Leads').find(recordId));
    const currentStage = record.get('Stage');
    const protectedStages = ['Info Requested', 'Researching', 'Under Contract'];
    if (protectedStages.includes(currentStage)) {
      return { updated: false, reason: `Stage is '${currentStage}' (manually set by Emma)` };
    }
  }

  await retryFetch(() => base('Leads').update(recordId, fields));
  return { updated: true };
}

/**
 * Fetch records by stage.
 */
async function getRecordsByStage(stage) {
  if (!base) init();

  const records = [];
  await new Promise((resolve, reject) => {
    base('Leads').select({
      filterByFormula: `{Stage} = '${stage}'`,
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        records.push(...pageRecords.map(r => ({ id: r.id, fields: r.fields })));
        fetchNextPage();
      },
      (err) => err ? reject(err) : resolve()
    );
  });
  return records;
}

/**
 * Fetch all active pipeline records (not rejected).
 */
async function getActivePipeline() {
  if (!base) init();

  const records = [];
  await new Promise((resolve, reject) => {
    base('Leads').select({
      filterByFormula: "{Stage} != 'Not Interested'",
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        records.push(...pageRecords.map(r => ({ id: r.id, fields: r.fields })));
        fetchNextPage();
      },
      (err) => err ? reject(err) : resolve()
    );
  });
  return records;
}

async function retryFetch(fn) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  init,
  loadDedupIndex,
  checkDuplicate,
  writeListings,
  updateRecord,
  getRecordsByStage,
  getActivePipeline,
};
