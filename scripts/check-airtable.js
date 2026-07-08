'use strict';

require('dotenv').config();

const airtable = require('../lib/airtable');

/**
 * Airtable connection diagnostic — verifies the token, base, table names,
 * and every field the scraper reads or writes, and explains failures in
 * plain English. Usage: npm run check-airtable
 */
const { TABLES, FIELDS } = airtable;

// Every Land-table field the code touches; a rename in Airtable shows up
// here as UNKNOWN_FIELD_NAME with the exact field named
const LAND_FIELDS_USED = [
  FIELDS.propertyName, FIELDS.nameFormula, FIELDS.price, FIELDS.acres,
  FIELDS.cpaFormula, FIELDS.county, FIELDS.countyLookup, FIELDS.url,
  FIELDS.source, FIELDS.coordinates, FIELDS.notes, FIELDS.humanNote,
  FIELDS.domFormula, FIELDS.stage, FIELDS.fingerprint,
  FIELDS.validationStatus, FIELDS.filterReason, FIELDS.priceCheckLog,
  FIELDS.created, FIELDS.possibleDupReason,
];

function explain(err) {
  const status = err.statusCode || err.status;
  const msg = err.message || String(err);
  if (status === 401) {
    return `${msg}\n    → The token is INVALID or EXPIRED. Create a new one at https://airtable.com/create/tokens\n      with scopes data.records:read + data.records:write and access to the Land base,\n      then update AIRTABLE_LAND_TOKEN in .env`;
  }
  if (status === 403) {
    return `${msg}\n    → The token works but is NOT ALLOWED to do this. Either the token lacks access to this base\n      (check its "Access" list at https://airtable.com/create/tokens), it is missing the\n      data.records:read / data.records:write scopes, or a TABLE NAME in the code no longer\n      matches the base (Airtable reports unknown tables as not-authorized).`;
  }
  if (status === 404 || /could not find/i.test(msg)) {
    return `${msg}\n    → The base ID or a table name is wrong. Check AIRTABLE_BASE_ID in .env and that the\n      tables '${TABLES.leads}' and '${TABLES.county}' still exist with those exact names.`;
  }
  if (/unknown field name/i.test(msg)) {
    return `${msg}\n    → A field was RENAMED in Airtable. The message above names the field the code expected;\n      either rename it back in Airtable or update FIELDS in lib/airtable.js.`;
  }
  return msg;
}

(async () => {
  let failed = false;
  console.log('Airtable connection check');
  console.log('-'.repeat(50));

  if (!process.env.AIRTABLE_LAND_TOKEN || !process.env.AIRTABLE_BASE_ID) {
    console.error('✗ AIRTABLE_LAND_TOKEN and/or AIRTABLE_BASE_ID missing from .env');
    process.exit(1);
  }
  console.log(`✓ Token present (starts ${process.env.AIRTABLE_LAND_TOKEN.slice(0, 8)}…), base ${process.env.AIRTABLE_BASE_ID}`);

  airtable.init();
  const Airtable = require('airtable');
  const base = Airtable.base(process.env.AIRTABLE_BASE_ID);

  // 1. County table read
  try {
    const recs = await base(TABLES.county).select({
      maxRecords: 1,
      fields: ['County', 'State (full)', 'CPA Target'],
    }).firstPage();
    console.log(`✓ '${TABLES.county}' table readable (sample: ${recs[0] ? recs[0].get('County') : 'empty table'})`);
  } catch (err) {
    failed = true;
    console.error(`✗ '${TABLES.county}' table read FAILED: ${explain(err)}`);
  }

  // 2. Land table read with every field the scraper uses
  try {
    const recs = await base(TABLES.leads).select({
      maxRecords: 1,
      fields: LAND_FIELDS_USED,
    }).firstPage();
    console.log(`✓ '${TABLES.leads}' table readable and all ${LAND_FIELDS_USED.length} expected fields exist`);
    if (recs[0]) {
      console.log(`  Sample record: ${recs[0].get(FIELDS.nameFormula) || recs[0].id} (stage: ${recs[0].get(FIELDS.stage) || 'none'})`);
    }
  } catch (err) {
    failed = true;
    console.error(`✗ '${TABLES.leads}' table read FAILED: ${explain(err)}`);
  }

  console.log('-'.repeat(50));
  if (failed) {
    console.error('RESULT: PROBLEMS FOUND — see the arrows above for what to fix.');
    process.exit(1);
  }
  console.log('RESULT: Airtable connection is fully working.');
  process.exit(0);
})().catch(err => {
  console.error(`Unexpected failure: ${explain(err)}`);
  process.exit(1);
});
