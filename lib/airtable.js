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

// The same property is often listed on several sites. 'Listing ' is a URL-type
// field and holds exactly ONE link (the first-seen one), so every EXTRA source
// is preserved as its own line in the multiline 'Source' text field:
//   LandWatch                          <- first line: the primary source name
//   LandAndFarm — https://...          <- one line per merged source
// The first line stays a plain source name so every record written before
// merging existed still reads exactly as it did.
const SOURCE_LINE_SEPARATOR = ' — ';
const SOURCE_URL_PATTERN = /https?:\/\/\S+/g;
// Sentence punctuation a human's free text leaves stuck to a pasted link
// ("see https://foo.com/x." → the url is not ".../x."). Stripped from the
// END of every parsed url so an already-noted link is still recognized.
const SOURCE_URL_TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '>', '»', ')', ']', '}']);
// A closing bracket is only punctuation when nothing inside the url opened it.
const SOURCE_URL_BRACKET_OPENERS = { ')': '(', ']': '[', '}': '{' };
const UNKNOWN_SOURCE_NAME = 'Unknown source';

// Real table names in the "Land" base. The leads table is named "Land",
// NOT "Leads" — Airtable reports a table the token can't see as
// "not authorized", so a wrong name here looks like a permission failure.
const TABLES = {
  leads: 'Land',
  county: 'County',
  intake: 'Listing Intake',
};

// Team-facing intake queue: anyone submits a listing URL via the Airtable
// form; the nightly run imports it into the Land table as a New Lead.
const INTAKE_FIELDS = {
  url: 'URL',
  submittedBy: 'Submitted By',
  note: 'Note',
  status: 'Status',
  result: 'Result',
  landRecord: 'Created Land Record',
  processedAt: 'Processed At',
};

const INTAKE_STATUS = {
  new: 'New',
  processing: 'Processing',
  added: 'Added',
  duplicate: 'Duplicate',
  needsReview: 'Needs Review',
  failed: 'Failed',
  retry: 'Retry',
};

// Airtable field name mapping for the Land table — verified against the
// live base schema. Quirks that MUST be preserved:
//   - 'Listing ', 'Coordinate ', 'Price Check Log ' have TRAILING SPACES
//   - 'Name', '$/A', 'Days On The Market', 'State' are computed
//     (formula/lookup) fields — they can be read but NEVER written
//   - 'County' is a linked-record field (array of rec... IDs); the text
//     county name is in the 'County (from County)' lookup
const FIELDS = {
  propertyName: 'Property Name',
  nameFormula: 'Name',
  price: 'LP',
  acres: 'Acres',
  cpaFormula: '$/A',
  county: 'County',
  countyLookup: 'County (from County)',
  url: 'Listing ',
  source: 'Source',
  coordinates: 'Coordinate ',
  notes: 'Scraper Notes',
  humanNote: 'Note',
  domFormula: 'Days On The Market',
  stage: 'Stage',
  fingerprint: 'Fingerprint',
  validationStatus: 'Validation Status',
  filterReason: 'Filter Reason',
  priceCheckLog: 'Price Check Log ',
  created: 'Created',
  possibleDupReason: 'Possible Duplicate Reason',
};

// Stage select options that exist in the live base and are managed by the
// scraper. Any record whose Stage is outside this set has been moved by a
// human (Emma Review, HOLD, Make Offer?, CCL Negotiation, ...) and the
// scraper must not change its stage.
const STAGES = {
  newLead: 'New Lead',
  watch: 'Watch For Price Drop',
  priceDrop: 'Price Drop',
  manualCheck: 'Manual Check Price Drop',
  notInterested: 'Not Interested',
  offMarket: 'Off Market',
  emmaReview: 'Emma Review',
};
const SCRAPER_MANAGED_STAGES = new Set([
  STAGES.newLead,
  STAGES.watch,
  STAGES.priceDrop,
  STAGES.manualCheck,
]);

let base = null;

// County-link index built by loadCountyTargets: lets us write the County
// linked-record field by record ID (county names alone are ambiguous —
// Wayne exists in both KY and MO) and resolve a Land record's county/state
// from its link.
let countyIndex = { byId: new Map(), idByKey: new Map() };

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
 * Returns { urlSet, fingerprintSet, locationMap, records, urlToRecord, fingerprintToRecord } where:
 *   - urlSet: Set of existing listing URLs (primary 'Listing ' URLs PLUS every
 *     secondary link merged into a record's Source field, so a source merged
 *     last night dedups as a plain URL match tonight — that also feeds the
 *     incremental early-stop predicate, which is intended)
 *   - fingerprintSet: Set of existing property fingerprints
 *   - locationMap: Map<locationKey, Array<{price}>> for price-tolerant cross-site matching
 *   - records: Array of { id, fields } for all records
 *   - urlToRecord / fingerprintToRecord: the record behind a url/fingerprint
 *     match, so a cross-site duplicate can merge its source into it
 */
async function loadDedupIndex() {
  if (!base) init();

  const records = [];

  const fetchFields = [
    FIELDS.url, FIELDS.fingerprint, FIELDS.stage,
    FIELDS.nameFormula, FIELDS.county, FIELDS.countyLookup,
    FIELDS.acres, FIELDS.price, FIELDS.source,
  ];

  await retryFetch(() => new Promise((resolve, reject) => {
    records.length = 0;
    base(TABLES.leads).select({
      fields: fetchFields,
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        for (const rec of pageRecords) records.push({ id: rec.id, fields: rec.fields });
        fetchNextPage();
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  }));

  const index = buildDedupIndex(records);
  console.log(`[Airtable] Dedup index: ${index.urlSet.size} URLs, ${index.fingerprintSet.size} fingerprints from ${records.length} records`);
  return index;
}

/**
 * Build the dedup lookups from fetched Land records ({ id, fields }). Kept
 * separate from the Airtable fetch above so every indexing rule — including
 * pulling merged secondary links out of Source — is exercised directly.
 */
function buildDedupIndex(records) {
  const urlSet = new Set();
  const fingerprintSet = new Set();
  const locationMap = new Map();
  const urlToRecord = new Map();
  const fingerprintToRecord = new Map();

  for (const entry of records) {
    const fields = entry.fields || {};
    const url = fields[FIELDS.url];
    const fp = fields[FIELDS.fingerprint];

    if (url) {
      urlSet.add(url);
      if (!urlToRecord.has(url)) urlToRecord.set(url, entry);
    }
    if (fp) {
      fingerprintSet.add(fp);
      if (!fingerprintToRecord.has(fp)) fingerprintToRecord.set(fp, entry);
    }
    // Links merged in from other sites live in Source, not 'Listing '
    for (const mergedUrl of parseSourceUrls(fields[FIELDS.source])) {
      urlSet.add(mergedUrl);
      if (!urlToRecord.has(mergedUrl)) urlToRecord.set(mergedUrl, entry);
    }

    const loc = resolveCountyFields(fields);
    if (loc) {
      addToLocationMap(locationMap, {
        county: loc.county,
        state: loc.state,
        acres: fields[FIELDS.acres],
        price: fields[FIELDS.price],
      });
    }
  }

  return { urlSet, fingerprintSet, locationMap, records, urlToRecord, fingerprintToRecord };
}

/**
 * Resolve a Land record's county/state from its County linked-record field
 * (via the index built by loadCountyTargets). Falls back to the
 * 'County (from County)' text lookup (county name only, no state).
 * Returns { county, state } or null.
 */
function resolveCountyFields(fields) {
  const links = fields[FIELDS.county];
  if (Array.isArray(links)) {
    for (const recId of links) {
      const hit = countyIndex.byId.get(recId);
      if (hit) return hit;
    }
  }
  const lookup = fields[FIELDS.countyLookup];
  if (Array.isArray(lookup) && lookup.length > 0 && lookup[0]) {
    return { county: String(lookup[0]), state: null };
  }
  return null;
}

/**
 * Record ID of the County-table row for a county/state, for writing the
 * County linked-record field. Names alone are ambiguous (Wayne KY vs
 * Wayne MO), so links are always written by ID.
 */
function getCountyRecordId(county, state) {
  if (!county || !state) return null;
  return countyIndex.idByKey.get(`${String(county).trim().toLowerCase()}|${String(state).trim().toUpperCase()}`) || null;
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
      base(TABLES.county).select().eachPage(
        (pageRecords, fetchNextPage) => {
          for (const rec of pageRecords) {
            const countyName = firstRecordValue(rec, COUNTY_NAME_FIELDS);
            const stateRaw = firstRecordValue(rec, COUNTY_STATE_FIELDS);
            if (!countyName || !stateRaw) continue;

            const stateAb = stateAbbrev(stateRaw);

            // Index EVERY county row (even without a CPA target) so Land
            // records linking to any county can be resolved to county/state
            countyIndex.byId.set(rec.id, { county: countyName.trim(), state: stateAb });
            countyIndex.idByKey.set(`${countyName.trim().toLowerCase()}|${stateAb.toUpperCase()}`, rec.id);

            const cpaTarget = rec.get(COUNTY_CPA_TARGET_FIELD);
            if (!cpaTarget) continue;

            const maxCPA = parseCurrencyNumber(cpaTarget);
            if (isNaN(maxCPA) || maxCPA <= 0) continue;

            counties.push({ county: countyName.trim(), state: stateAb, maxCPA, recordId: rec.id });
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
 * The indexed record behind a url/fingerprint match, or null. Legacy callers
 * (and tests) build dedup indexes from bare Sets with no record maps at all —
 * those resolve to null rather than throwing, and the caller falls back to
 * skipping the duplicate exactly as before.
 */
function resolveIndexedRecord(map, key) {
  if (!map || typeof map.get !== 'function' || !key) return null;
  return map.get(key) || null;
}

/**
 * Check if a listing is a duplicate.
 * Returns { isDuplicate, reason, matchType, existingRecord } where matchType is
 * 'url' | 'fingerprint' | null and existingRecord is the { id, fields } this
 * listing duplicates (null when the index cannot resolve it), so the caller can
 * merge this listing's source+link into it.
 */
function checkDuplicate(listing, dedupIndex) {
  // Layer 1: exact URL match. The index stores primary 'Listing ' urls raw but
  // Source-parsed secondary links punctuation-trimmed, so a url that carries
  // pasted trailing punctuation also gets a trimmed lookup — without it a
  // merged link would miss this cheap match and re-run the fingerprint layers.
  const trimmedUrl = listing.url ? trimUrlTrailingPunctuation(String(listing.url)) : null;
  const urlHit = listing.url && (
    dedupIndex.urlSet.has(listing.url) || (trimmedUrl !== listing.url && dedupIndex.urlSet.has(trimmedUrl))
  );
  if (urlHit) {
    return {
      isDuplicate: true,
      reason: `URL already exists: ${listing.url}`,
      matchType: 'url',
      existingRecord: resolveIndexedRecord(dedupIndex.urlToRecord, listing.url)
        || resolveIndexedRecord(dedupIndex.urlToRecord, trimmedUrl),
    };
  }

  // Layer 2: property fingerprint match
  const fp = generateFingerprint(listing);
  if (fp && dedupIndex.fingerprintSet.has(fp)) {
    return {
      isDuplicate: true,
      reason: `Property fingerprint match (cross-site duplicate)`,
      matchType: 'fingerprint',
      existingRecord: resolveIndexedRecord(dedupIndex.fingerprintToRecord, fp),
    };
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

/** One merged-source line: `LandAndFarm — https://...`. */
function formatSourceLine(source, url) {
  return `${source || UNKNOWN_SOURCE_NAME}${SOURCE_LINE_SEPARATOR}${url}`;
}

/**
 * Drop sentence punctuation a human left attached to a pasted link. A closing
 * bracket is kept when the url itself opened it (`.../Foo_(bar)`).
 */
function trimUrlTrailingPunctuation(url) {
  let trimmed = url;
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (!SOURCE_URL_TRAILING_PUNCTUATION.has(last)) break;
    const opener = SOURCE_URL_BRACKET_OPENERS[last];
    if (opener && countCharacter(trimmed, opener) >= countCharacter(trimmed, last)) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function countCharacter(text, character) {
  let count = 0;
  for (const ch of text) if (ch === character) count++;
  return count;
}

/**
 * Every http(s) URL in a Source field, wherever it sits. Tolerant by design:
 * the field holds plain source names, merged `name — url` lines, and whatever
 * free text a human typed into it before merging existed.
 */
function parseSourceUrls(sourceText) {
  if (!sourceText) return [];
  const matches = String(sourceText).match(SOURCE_URL_PATTERN) || [];
  return matches.map(trimUrlTrailingPunctuation).filter(url => /^https?:\/\/\S/.test(url));
}

/**
 * Source text for a record that gained another source. Returns changed:false
 * (and the text untouched) when the link is already recorded — either as the
 * record's primary 'Listing ' URL or on a line already in Source.
 */
function buildMergedSourceText(existingSourceText, existingUrl, source, url) {
  const text = String(existingSourceText || '');
  if (!url) return { text, changed: false };
  // Compare (and append) the punctuation-trimmed url: parseSourceUrls returns
  // trimmed urls, so a raw url that itself ends in pasted punctuation (an
  // intake link ending in '.') would never match its own already-merged line
  // and would be re-appended on every later run.
  const urlKey = trimUrlTrailingPunctuation(String(url));
  if (existingUrl && trimUrlTrailingPunctuation(String(existingUrl)) === urlKey) {
    return { text, changed: false };
  }
  if (parseSourceUrls(text).includes(urlKey)) return { text, changed: false };

  const line = formatSourceLine(source, urlKey);
  const trimmed = text.replace(/\s+$/, '');
  return { text: trimmed ? `${trimmed}\n${line}` : line, changed: true };
}

/**
 * Preserve a cross-site duplicate's source+link on the record it duplicates,
 * instead of discarding it with the listing. Writes ONLY the Source field —
 * never Stage, price, or acres (the record may be mid-pipeline and owned by
 * a human).
 *
 * The caller's snapshot is NEVER trusted for the Source value: the record is
 * always read back first. Callers share one snapshot object per record (the
 * dedup index holds a single entry per fingerprint/url), and Source is also
 * human-editable hours after that index loaded, so building the append from a
 * stale snapshot silently drops whatever the previous writer added. Merges are
 * rare, so the extra read costs nothing worth optimizing.
 *
 * On success the merged text is written back into the caller's snapshot, so
 * every later reader of that shared dedup-index entry sees the current Source.
 *
 * Never throws on a no-op; Airtable failures propagate to the caller.
 */
async function mergeSourceIntoRecord(existingRecord, listing) {
  if (!existingRecord || !existingRecord.id) {
    return { merged: false, reason: 'No existing record to merge into' };
  }
  if (!listing || !listing.url) {
    return { merged: false, reason: 'Listing has no URL to merge' };
  }

  const fetched = await module.exports.getRecordById(existingRecord.id);
  const fields = (fetched && fetched.fields) || {};

  const { text, changed } = buildMergedSourceText(
    fields[FIELDS.source], fields[FIELDS.url], listing.source, listing.url
  );
  if (!changed) {
    return { merged: false, reason: `Source already records ${listing.url}` };
  }

  await module.exports.updateRecord(existingRecord.id, { [FIELDS.source]: text });
  if (!existingRecord.fields) existingRecord.fields = {};
  existingRecord.fields[FIELDS.source] = text;
  return { merged: true, text };
}

/**
 * The Source field value for a new record: the primary source name alone, or —
 * when cross-site duplicates were merged into this listing before it was
 * written — that name followed by one `source — url` line each. The listing's
 * own URL never gets a line (it is already the 'Listing ' field).
 */
function buildSourceFieldValue(l) {
  const extras = Array.isArray(l.additionalSources) ? l.additionalSources : [];
  if (extras.length === 0) return l.source;

  const seenUrls = new Set([l.url]);
  // Line 1 is always a plain source name, never a merged `name — url` line:
  // every record written before merging existed reads that way, and the dedup
  // index treats a line-1 url as a merged secondary link.
  const lines = [l.source || UNKNOWN_SOURCE_NAME];
  for (const extra of extras) {
    if (!extra || !extra.url || seenUrls.has(extra.url)) continue;
    seenUrls.add(extra.url);
    lines.push(formatSourceLine(extra.source, extra.url));
  }
  return lines.join('\n');
}

/**
 * Convert a listing to Airtable Land-table fields. Computed fields (Name,
 * $/A, State, Days On The Market) are never written — Airtable derives them
 * from LP, Acres, and the County link.
 */
function listingToFields(l) {
  const countyRecordId = getCountyRecordId(l.county, l.state);
  const fields = {
    [FIELDS.propertyName]: l.name || 'Unnamed Listing',
    [FIELDS.price]: l.price,
    [FIELDS.acres]: l.acres,
    [FIELDS.county]: countyRecordId ? [countyRecordId] : undefined,
    [FIELDS.url]: l.url,
    [FIELDS.source]: buildSourceFieldValue(l),
    [FIELDS.coordinates]: l.coordinates || '',
    [FIELDS.notes]: l.description || '',
    [FIELDS.stage]: l.stage,
    [FIELDS.fingerprint]: l.fingerprint,
    [FIELDS.validationStatus]: l.validationErrors && l.validationErrors.length > 0 ? 'Has Warnings' : 'Clean',
    [FIELDS.filterReason]: l.filterReason || '',
    [FIELDS.possibleDupReason]: l.possibleDuplicateReason || undefined,
  };
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null) delete fields[key];
  }
  return fields;
}

/**
 * Write a batch of validated, non-duplicate listings to Airtable.
 * Each listing should already have passed filtering and dedup checks.
 *
 * Returns { created, errors, records } where records is [{ id, url }] for the
 * records Airtable actually created — the caller needs the ids to merge a
 * later cross-site duplicate's source into a lead written earlier tonight.
 */
async function writeListings(listings, opts = {}) {
  if (!listings.length) return { created: 0, errors: [], records: [] };
  try {
    if (!base) init();
  } catch (err) {
    const filePath = persistFailedListings(listings, {
      table: TABLES.leads,
      operation: 'create',
      error: err.message,
      fileTag: opts.fileTag,
    });
    return {
      created: 0,
      errors: [{ batch: 0, error: err.message, savedTo: filePath }],
      records: [],
    };
  }

  const errors = [];
  const createdRecords = [];
  let created = 0;

  const airtableRecords = listings.map(l => ({ fields: listingToFields(l) }));

  // Write in batches of 10
  for (let i = 0; i < airtableRecords.length; i += BATCH_SIZE) {
    const batch = airtableRecords.slice(i, i + BATCH_SIZE);
    const batchListings = listings.slice(i, i + BATCH_SIZE);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const written = await module.exports.getLeadsTable().create(batch, { typecast: true });
        created += batch.length;
        // Airtable resolves create() with the new records in request order, so
        // ids pair positionally with this batch's listings.
        if (Array.isArray(written)) {
          for (let k = 0; k < written.length && k < batchListings.length; k++) {
            const id = recordIdOf(written[k]);
            if (id) createdRecords.push({ id, url: batchListings[k].url });
          }
        }
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
            table: TABLES.leads,
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

  return { created, errors, records: createdRecords };
}

/** Record id from an Airtable record object (getId()) or a plain stub ({ id }). */
function recordIdOf(record) {
  if (!record) return null;
  if (typeof record.getId === 'function') return record.getId();
  return record.id || null;
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
    const matches = await module.exports.getLeadsTable().select({
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

/**
 * Filter formula for getIntakeQueue: Status empty, 'New', or 'Retry' (a
 * first attempt that failed and is due for its next-day retry), OR'd with
 * the legacy-poller reclaim clause — see getIntakeQueue's jsdoc for why that
 * clause exists. Extracted as a pure function so the formula string itself
 * is directly testable without going through the Airtable client.
 */
function buildIntakeQueueFormula() {
  const s = INTAKE_FIELDS.status;
  const r = INTAKE_FIELDS.result;
  return `OR({${s}} = '', {${s}} = '${INTAKE_STATUS.new}', {${s}} = '${INTAKE_STATUS.retry}', AND({${s}} = '${INTAKE_STATUS.needsReview}', LEFT({${r}}, 5) = 'HTTP '))`;
}

/**
 * Fetch intake submissions awaiting processing: Status empty, 'New', or
 * 'Retry' (a first attempt that failed and is due for its next-day retry).
 *
 * Also RECLAIMS rows the legacy intake poller broke: it marked its fetch
 * failures 'Needs Review' with a Result beginning "HTTP <status> fetching".
 * While that script still runs on the production Mac it grabs daytime
 * submissions first and strands them there — pulling its failures back into
 * this queue means they get the browser-fallback retry the next night no
 * matter what. Human-set 'Needs Review' rows (any other Result) are left
 * alone, as are 'Failed' rows.
 */
async function getIntakeQueue() {
  if (!base) init();

  const records = [];
  await new Promise((resolve, reject) => {
    base(TABLES.intake).select({
      filterByFormula: buildIntakeQueueFormula(),
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
 * Update an intake row. typecast lets Airtable create select options the
 * base doesn't have yet (e.g. the first 'Retry').
 */
async function updateIntakeRecord(recordId, fields) {
  if (!base) init();
  await base(TABLES.intake).update([{ id: recordId, fields }], { typecast: true });
}

/**
 * Create a single Land record directly and return its record id (the
 * intake table links back to the created lead — writeListings can't do
 * that because it doesn't return ids).
 */
async function createLeadRecord(listing) {
  if (!base) init();
  const [record] = await base(TABLES.leads).create([{ fields: listingToFields(listing) }], { typecast: true });
  return record.getId();
}

/**
 * Every county row (with or without a CPA target) as { county, state }.
 * Populated by loadCountyTargets; used for best-effort county matching of
 * intake URLs.
 */
function listAllCounties() {
  return Array.from(countyIndex.byId.values());
}

function escapeFormulaValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getRecordById(recordId) {
  if (!base) init();
  const record = await retryFetch(() => base(TABLES.leads).find(recordId));
  return { id: record.id, fields: record.fields };
}

/**
 * The underlying Airtable table handle for the Land leads table. Extracted
 * as a seam so tests can drive the real updateRecord logic while stubbing
 * only the Airtable client (updateRecord calls it via module.exports so a
 * test override on the required module takes effect).
 */
function getLeadsTable() {
  if (!base) init();
  return base(TABLES.leads);
}

/**
 * Update an existing record's fields (for price drops, stage changes, etc.).
 * Respects stage protection — won't overwrite if Emma has manually changed the stage.
 */
async function updateRecord(recordId, fields, protectStage = true) {
  if (protectStage && fields[FIELDS.stage]) {
    const table = module.exports.getLeadsTable();
    const record = await retryFetch(() => table.find(recordId));
    const currentStage = record.get(FIELDS.stage);
    // Only records still in a scraper-managed stage may be auto-moved; any
    // other stage (Emma Review, HOLD, Make Offer?, CCL Negotiation, ...)
    // means a human took over this record
    if (currentStage && !SCRAPER_MANAGED_STAGES.has(currentStage)) {
      return { updated: false, reason: `Stage is '${currentStage}' (manually set by Emma)` };
    }
  }

  const table = module.exports.getLeadsTable();
  await retryFetch(() => table.update(recordId, fields, { typecast: true }));
  return { updated: true };
}

/**
 * Fetch records by stage.
 */
async function getRecordsByStage(stage) {
  if (!base) init();

  const records = [];
  await new Promise((resolve, reject) => {
    base(TABLES.leads).select({
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
    base(TABLES.leads).select({
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
  TABLES,
  FIELDS,
  STAGES,
  SCRAPER_MANAGED_STAGES,
  COUNTY_CPA_TARGET_FIELD,
  COUNTY_NAME_FIELDS,
  COUNTY_STATE_FIELDS,
  loadCountyTargets,
  loadDedupIndex,
  buildDedupIndex,
  checkDuplicate,
  writeListings,
  listingToFields,
  formatSourceLine,
  parseSourceUrls,
  buildMergedSourceText,
  buildSourceFieldValue,
  mergeSourceIntoRecord,
  updateRecord,
  getLeadsTable,
  getRecordById,
  getRecordsByStage,
  getActivePipeline,
  parseCurrencyNumber,
  firstRecordValue,
  addToLocationMap,
  resolveCountyFields,
  getCountyRecordId,
  isRetryableError,
  escapeFormulaValue,
  INTAKE_FIELDS,
  INTAKE_STATUS,
  buildIntakeQueueFormula,
  getIntakeQueue,
  updateIntakeRecord,
  createLeadRecord,
  listAllCounties,
};
