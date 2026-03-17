'use strict';

const Airtable = require('airtable');
const { generateFingerprint } = require('./fingerprint');

const BATCH_SIZE = 10; // Airtable API max per request
const RATE_LIMIT_DELAY = 250; // ms between batches (5 req/sec limit)
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

// Airtable field name mapping — change these if your field names differ
const FIELDS = {
  name: 'Name',
  price: 'LP',
  acres: 'Acres',
  cpa: '$/A',
  county: 'County',
  state: 'State',
  url: 'Listing URL',
  source: 'Source',
  coordinates: 'Coordinate',
  notes: 'Property Notes',
  dom: 'Days On The Market',
  stage: 'Stage',
  fingerprint: 'Fingerprint',
  validationStatus: 'Validation Status',
  filterReason: 'Filter Reason',
  priceCheckLog: 'Price Check Log',
};

// Full state name → abbreviation mapping
const STATE_ABBREV = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY',
};

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

  const fetchFields = [
    FIELDS.url, FIELDS.fingerprint, FIELDS.stage,
    FIELDS.name, FIELDS.county, FIELDS.state,
    FIELDS.acres, FIELDS.price, FIELDS.cpa,
  ];

  await new Promise((resolve, reject) => {
    base('Leads').select({
      fields: fetchFields,
      filterByFormula: `AND({${FIELDS.stage}} != 'Not Interested')`,
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        for (const rec of pageRecords) {
          const url = rec.get(FIELDS.url);
          const fp = rec.get(FIELDS.fingerprint);

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

  console.log(`[Airtable] Dedup index: ${urlSet.size} URLs, ${fingerprintSet.size} fingerprints from ${records.length} records`);
  return { urlSet, fingerprintSet, records };
}

/**
 * Load county CPA targets from the Airtable "county" table.
 * Only returns counties where "CPA top target" has a number.
 * Converts full state names (e.g. "Texas") to abbreviations (e.g. "TX").
 *
 * Returns { counties: [{ county, state, maxCPA }], countyMap: Map<"county|state", maxCPA> }
 */
async function loadCountyTargets() {
  if (!base) init();

  const counties = [];

  await new Promise((resolve, reject) => {
    base('county').select({
      filterByFormula: `{CPA top target} != ''`,
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        for (const rec of pageRecords) {
          const countyName = rec.get('Name');
          const stateRaw = rec.get('State');
          const cpaTarget = rec.get('CPA top target');

          if (!countyName || !stateRaw || !cpaTarget) continue;

          const maxCPA = parseFloat(cpaTarget);
          if (isNaN(maxCPA) || maxCPA <= 0) continue;

          // Convert full state name to abbreviation
          const stateAbbrev = STATE_ABBREV[stateRaw.toLowerCase().trim()] || stateRaw.trim().toUpperCase();

          counties.push({ county: countyName.trim(), state: stateAbbrev, maxCPA });
        }
        fetchNextPage();
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  // Build lookup map: "county|state" -> maxCPA
  const countyMap = new Map();
  for (const c of counties) {
    const key = `${c.county.toLowerCase()}|${c.state.toUpperCase()}`;
    countyMap.set(key, c.maxCPA);
  }

  const states = new Set(counties.map(c => c.state));
  console.log(`[Airtable] County targets loaded: ${counties.length} counties across ${states.size} states from Airtable`);

  return { counties, countyMap };
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
 */
async function writeListings(listings) {
  if (!base) init();
  if (!listings.length) return { created: 0, errors: [] };

  const errors = [];
  let created = 0;

  // Convert to Airtable records
  const airtableRecords = listings.map(l => {
    const fields = {
      [FIELDS.name]: l.name || 'Unnamed Listing',
      [FIELDS.price]: l.price,
      [FIELDS.acres]: l.acres,
      [FIELDS.cpa]: l.computedCPA,
      [FIELDS.county]: l.county,
      [FIELDS.state]: l.state,
      [FIELDS.url]: l.url,
      [FIELDS.source]: l.source,
      [FIELDS.coordinates]: l.coordinates || '',
      [FIELDS.notes]: l.description || '',
      [FIELDS.dom]: l.daysOnMarket || null,
      [FIELDS.stage]: l.stage,
      [FIELDS.fingerprint]: l.fingerprint,
      [FIELDS.validationStatus]: l.validationErrors && l.validationErrors.length > 0 ? 'Has Warnings' : 'Clean',
      [FIELDS.filterReason]: l.filterReason || '',
    };

    return { fields };
  });

  // Remove null/undefined fields
  for (const rec of airtableRecords) {
    for (const [key, val] of Object.entries(rec.fields)) {
      if (val === undefined || val === null) delete rec.fields[key];
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

  if (protectStage && fields[FIELDS.stage]) {
    const record = await retryFetch(() => base('Leads').find(recordId));
    const currentStage = record.get(FIELDS.stage);
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
      filterByFormula: `{${FIELDS.stage}} = '${stage}'`,
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
      filterByFormula: `{${FIELDS.stage}} != 'Not Interested'`,
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
  FIELDS,
  loadCountyTargets,
  loadDedupIndex,
  checkDuplicate,
  writeListings,
  updateRecord,
  getRecordsByStage,
  getActivePipeline,
};
