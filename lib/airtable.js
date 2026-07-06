'use strict';

const Airtable = require('airtable');
const { generateFingerprint, locationKey } = require('./fingerprint');
const { loadLocalCountyTargets, persistFailedListings } = require('./local-store');
const { stateAbbrev } = require('./states');

const BATCH_SIZE = 10; // Airtable API max per request
const RATE_LIMIT_DELAY = 250; // ms between batches (5 req/sec limit)
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;
const LOCATION_PRICE_TOLERANCE = 0.10;
const COUNTY_CPA_TARGET_FIELD = 'CPA Target';
const COUNTY_NAME_FIELDS = ['County', 'Name'];
const COUNTY_STATE_FIELDS = ['State (full)', 'State Full', 'State Name', 'State'];

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
 *
 * Deliberately includes 'Not Interested' records: a rejected or expired lead
 * whose listing is still live would otherwise be re-created as a brand-new
 * record on every subsequent scrape.
 *
 * Returns { urlSet, fingerprintSet, locationMap, records } where:
 *   - urlSet: Set of existing listing URLs
 *   - fingerprintSet: Set of existing property fingerprints
 *   - locationMap: Map<locationKey, Array<{price}>> for price-tolerant cross-site matching
 *   - records: Array of { id, fields } for all records
 */
async function loadDedupIndex() {
  if (!base) init();

  const urlSet = new Set();
  const fingerprintSet = new Set();
  const locationMap = new Map();
  const records = [];

  const fetchFields = [
    FIELDS.url, FIELDS.fingerprint, FIELDS.stage,
    FIELDS.name, FIELDS.county, FIELDS.state,
    FIELDS.acres, FIELDS.price, FIELDS.cpa,
  ];

  await retryFetch(() => new Promise((resolve, reject) => {
    urlSet.clear();
    fingerprintSet.clear();
    locationMap.clear();
    records.length = 0;
    base('Leads').select({
      fields: fetchFields,
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        for (const rec of pageRecords) {
          const url = rec.get(FIELDS.url);
          const fp = rec.get(FIELDS.fingerprint);

          if (url) urlSet.add(url);
          if (fp) fingerprintSet.add(fp);
          addToLocationMap(locationMap, {
            county: rec.get(FIELDS.county),
            state: rec.get(FIELDS.state),
            acres: rec.get(FIELDS.acres),
            price: rec.get(FIELDS.price),
          });

          records.push({ id: rec.id, fields: rec.fields });
        }
        fetchNextPage();
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  }));

  console.log(`[Airtable] Dedup index: ${urlSet.size} URLs, ${fingerprintSet.size} fingerprints from ${records.length} records`);
  return { urlSet, fingerprintSet, locationMap, records };
}

function addToLocationMap(locationMap, listing) {
  const key = locationKey(listing.county, listing.state, listing.acres);
  if (!key || !listing.price) return;
  if (!locationMap.has(key)) locationMap.set(key, []);
  locationMap.get(key).push({ price: listing.price });
}

/**
 * Load county CPA targets from the Airtable "county" table.
 * Only returns counties where "CPA Target" has a number.
 * Converts full state names (e.g. "Texas") to abbreviations (e.g. "TX").
 *
 * Returns { counties: [{ county, state, maxCPA }], countyMap: Map<"county|state", maxCPA> }
 */
async function loadCountyTargets() {
  const counties = [];

  try {
    if (!base) init();
    await new Promise((resolve, reject) => {
      base('county').select().eachPage(
        (pageRecords, fetchNextPage) => {
          for (const rec of pageRecords) {
            const countyName = firstRecordValue(rec, COUNTY_NAME_FIELDS);
            const stateRaw = firstRecordValue(rec, COUNTY_STATE_FIELDS);
            const cpaTarget = rec.get(COUNTY_CPA_TARGET_FIELD);

            if (!countyName || !stateRaw || !cpaTarget) continue;

            const maxCPA = parseCurrencyNumber(cpaTarget);
            if (isNaN(maxCPA) || maxCPA <= 0) continue;

            const stateAb = stateAbbrev(stateRaw);

            counties.push({ county: countyName.trim(), state: stateAb, maxCPA });
          }
          fetchNextPage();
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  } catch (err) {
    const fallback = loadLocalCountyTargets();
    fallback.warning = `Airtable county target load failed; using local fallback: ${err.message}`;
    console.warn(`[Airtable] ${fallback.warning}`);
    return fallback;
  }

  // Build lookup map: "county|state" -> maxCPA
  const countyMap = new Map();
  for (const c of counties) {
    const key = `${c.county.toLowerCase()}|${c.state.toUpperCase()}`;
    countyMap.set(key, c.maxCPA);
  }

  const states = new Set(counties.map(c => c.state));
  console.log(`[Airtable] County targets loaded: ${counties.length} counties across ${states.size} states from Airtable`);

  if (counties.length === 0) {
    const fallback = loadLocalCountyTargets();
    fallback.warning = 'Airtable returned zero county targets; using local fallback county config';
    console.warn(`[Airtable] ${fallback.warning}`);
    return fallback;
  }

  return { counties, countyMap, source: 'airtable' };
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

  // Layer 3: same county/state/acreage with price within tolerance.
  // This MIGHT be the same property listed at slightly different prices on
  // two sites (different $5k fingerprint buckets) — but subdivided sibling
  // tracts of identical size at near-identical prices are common in rural
  // land, so this is flagged as a SUSPECTED duplicate rather than silently
  // skipped. The listing is still written; the warning shows in Airtable.
  if (dedupIndex.locationMap && listing.price) {
    const key = locationKey(listing.county, listing.state, listing.acres);
    const candidates = key ? dedupIndex.locationMap.get(key) : null;
    if (candidates) {
      for (const candidate of candidates) {
        const diff = Math.abs(candidate.price - listing.price)
          / Math.min(candidate.price, listing.price);
        if (diff <= LOCATION_PRICE_TOLERANCE) {
          return {
            isDuplicate: false,
            reason: null,
            matchType: null,
            suspectedCrossSite: `Possible cross-site duplicate: existing lead in same county at ${listing.acres}ac / $${candidate.price.toLocaleString()} (this one $${listing.price.toLocaleString()})`,
          };
        }
      }
    }
  }

  return { isDuplicate: false, reason: null, matchType: null };
}

/**
 * Write a batch of validated, non-duplicate listings to Airtable.
 * Each listing should already have passed filtering and dedup checks.
 */
async function writeListings(listings, opts = {}) {
  if (!listings.length) return { created: 0, errors: [] };
  try {
    if (!base) init();
  } catch (err) {
    const filePath = persistFailedListings(listings, {
      table: 'Leads',
      operation: 'create',
      error: err.message,
      fileTag: opts.fileTag,
    });
    return {
      created: 0,
      errors: [{ batch: 0, error: err.message, savedTo: filePath }],
    };
  }

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
    const batchListings = listings.slice(i, i + BATCH_SIZE);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await base('Leads').create(batch, { typecast: true });
        created += batch.length;
        break;
      } catch (err) {
        const lastAttempt = attempt === MAX_RETRIES - 1;

        // A timeout/network failure is ambiguous — Airtable may have accepted
        // the batch before the response was lost. Retrying blindly would
        // double-create every record, so confirm non-existence first.
        if (isAmbiguousFailure(err)) {
          const alreadyCreated = await batchAlreadyCreated(batchListings);
          if (alreadyCreated) {
            created += batch.length;
            console.warn(`[Airtable] Batch at ${i} was created despite the error (${err.message}); skipping retry`);
            break;
          }
        }

        if (lastAttempt || !isRetryableError(err)) {
          errors.push({ batch: i, error: err.message });
          const filePath = persistFailedListings(batchListings, {
            table: 'Leads',
            operation: 'create',
            batchStart: i,
            error: err.message,
            fileTag: opts.fileTag,
          });
          errors[errors.length - 1].savedTo = filePath;
          break;
        }

        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        await sleep(delay);
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
 * Check whether the first listing of a failed batch already exists in
 * Airtable (batch creates are atomic, so one record existing means the whole
 * batch landed). Fails closed: an error here returns false so the caller
 * retries — worst case that produces duplicates the dedup index catches on
 * the next run, whereas silently skipping would lose leads.
 */
async function batchAlreadyCreated(batchListings) {
  const probe = batchListings.find(l => l && l.url);
  if (!probe) return false;
  try {
    const matches = await base('Leads').select({
      filterByFormula: `{${FIELDS.url}} = '${escapeFormulaValue(probe.url)}'`,
      maxRecords: 1,
      fields: [FIELDS.url],
    }).firstPage();
    return matches.length > 0;
  } catch (probeErr) {
    console.warn(`[Airtable] Could not verify batch existence: ${probeErr.message}`);
    return false;
  }
}

/**
 * Retry only errors that can plausibly succeed on retry: rate limits,
 * server errors, and network/timeout failures. A 422 (bad field/schema) or
 * 403 (auth) fails identically every time — retrying just burns 14s per batch.
 */
function isRetryableError(err) {
  const status = err && (err.statusCode || err.status);
  if (typeof status === 'number') {
    return status === 429 || status === 408 || status >= 500;
  }
  return true; // no status — network error, timeout, DNS, etc.
}

/**
 * True when we can't know whether the request reached Airtable
 * (timeout / connection drop — anything without an HTTP status).
 */
function isAmbiguousFailure(err) {
  const status = err && (err.statusCode || err.status);
  return typeof status !== 'number';
}

function escapeFormulaValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getRecordById(recordId) {
  if (!base) init();
  const record = await retryFetch(() => base('Leads').find(recordId));
  return { id: record.id, fields: record.fields };
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

  await retryFetch(() => base('Leads').update(recordId, fields, { typecast: true }));
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
      filterByFormula: `{${FIELDS.stage}} = '${escapeFormulaValue(stage)}'`,
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
      if (attempt === MAX_RETRIES - 1 || !isRetryableError(err)) throw err;
      await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCurrencyNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  return parseFloat(value.replace(/[$,\s]/g, ''));
}

function firstRecordValue(record, fields) {
  for (const field of fields) {
    const value = record.get(field);
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return String(value[0]);
      continue;
    }
    return String(value);
  }
  return null;
}

module.exports = {
  init,
  FIELDS,
  COUNTY_CPA_TARGET_FIELD,
  COUNTY_NAME_FIELDS,
  COUNTY_STATE_FIELDS,
  loadCountyTargets,
  loadDedupIndex,
  checkDuplicate,
  writeListings,
  updateRecord,
  getRecordById,
  getRecordsByStage,
  getActivePipeline,
  parseCurrencyNumber,
  firstRecordValue,
  addToLocationMap,
  isRetryableError,
  escapeFormulaValue,
};
