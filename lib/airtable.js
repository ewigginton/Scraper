'use strict';

const Airtable = require('airtable');
const { generateFingerprint } = require('./fingerprint');

const BATCH_SIZE = 10; // Airtable API max per request
const RATE_LIMIT_DELAY = 250; // ms between batches (5 req/sec limit)
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

// New fields added in v2.0 — scraper degrades gracefully if these don't exist yet
const V2_FIELDS = ['PropertyFingerprint', 'ValidationStatus', 'FilterReason'];

let base = null;
let v2FieldsAvailable = null; // null = not checked yet, true/false after probe

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
 * Probe Airtable to check if v2 fields (PropertyFingerprint, etc.) exist.
 * Fetches a single record requesting only those fields. If Airtable throws
 * "Unknown field name", we know the fields haven't been added yet and
 * the scraper should run in degraded mode (URL-only dedup, no fingerprint writes).
 */
async function probeV2Fields() {
  if (!base) init();
  if (v2FieldsAvailable !== null) return v2FieldsAvailable;

  try {
    await new Promise((resolve, reject) => {
      base('Leads').select({
        fields: ['Listing URL', 'PropertyFingerprint'],
        maxRecords: 1,
      }).firstPage((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    v2FieldsAvailable = true;
    console.log('[Airtable] v2 fields detected (PropertyFingerprint, ValidationStatus, FilterReason)');
  } catch (err) {
    if (err.message && err.message.includes('Unknown field name')) {
      v2FieldsAvailable = false;
      console.warn('[Airtable] ⚠️  v2 fields NOT found in Airtable — running in degraded mode (URL-only dedup)');
      console.warn('[Airtable] Add these fields to your Leads table for cross-site dedup:');
      console.warn('[Airtable]   PropertyFingerprint  (Single line text)');
      console.warn('[Airtable]   ValidationStatus     (Single line text)');
      console.warn('[Airtable]   FilterReason          (Long text)');
    } else {
      // Some other error (network, auth) — assume fields exist, let real calls surface the error
      v2FieldsAvailable = true;
    }
  }

  return v2FieldsAvailable;
}

/**
 * Load all existing records for deduplication.
 * Returns { urlSet, fingerprintSet, records, hasV2Fields } where:
 *   - urlSet: Set of existing listing URLs
 *   - fingerprintSet: Set of existing property fingerprints (empty if v2 fields missing)
 *   - records: Array of { id, fields } for all active records
 *   - hasV2Fields: whether PropertyFingerprint field exists in Airtable
 */
async function loadDedupIndex() {
  if (!base) init();

  // Check if v2 fields exist before requesting them
  const hasV2 = await probeV2Fields();

  const urlSet = new Set();
  const fingerprintSet = new Set();
  const records = [];

  // Only request PropertyFingerprint if the field exists in Airtable
  const fetchFields = ['Listing URL', 'Stage', 'Name', 'County', 'State', 'Acres', 'LP', '$/A'];
  if (hasV2) fetchFields.push('PropertyFingerprint');

  await new Promise((resolve, reject) => {
    base('Leads').select({
      fields: fetchFields,
      // Exclude rejected records from dedup — we don't care about re-finding them
      filterByFormula: "AND({Stage} != 'Not Interested')",
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        for (const rec of pageRecords) {
          const url = rec.get('Listing URL');
          if (url) urlSet.add(url);

          if (hasV2) {
            const fp = rec.get('PropertyFingerprint');
            if (fp) fingerprintSet.add(fp);
          }

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

  // If v2 fields don't exist, build fingerprints from existing data as a fallback.
  // This gives us cross-site dedup even without the Airtable field, by computing
  // fingerprints on the fly from county+state+acres+price.
  if (!hasV2 && records.length > 0) {
    console.log('[Airtable] Building fingerprint index from existing record data (fallback mode)...');
    for (const rec of records) {
      const fp = generateFingerprint({
        county: rec.fields.County,
        state: rec.fields.State,
        acres: rec.fields.Acres,
        price: rec.fields.LP,
      });
      if (fp) fingerprintSet.add(fp);
    }
    console.log(`[Airtable] Built ${fingerprintSet.size} fingerprints from ${records.length} existing records`);
  }

  return { urlSet, fingerprintSet, records, hasV2Fields: hasV2 };
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

  // Check if v2 fields are available (probe should have run during loadDedupIndex)
  const hasV2 = await probeV2Fields();

  // Convert to Airtable records
  const airtableRecords = listings.map(l => {
    const fields = {
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
    };

    // Only include v2 fields if they exist in Airtable
    if (hasV2) {
      fields['PropertyFingerprint'] = l.fingerprint;
      fields['ValidationStatus'] = l.validationErrors && l.validationErrors.length > 0 ? 'Has Warnings' : 'Clean';
      fields['FilterReason'] = l.filterReason || '';
    }

    return { fields };
  });

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
  probeV2Fields,
  loadDedupIndex,
  checkDuplicate,
  writeListings,
  updateRecord,
  getRecordsByStage,
  getActivePipeline,
};
