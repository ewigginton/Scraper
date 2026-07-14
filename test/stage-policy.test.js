'use strict';

/**
 * Stage policy: every lead entering Emma's queue arrives as 'New Lead' and
 * stays there until SHE changes it. Her triage filter is built on that
 * stage, so:
 *   - price-drop promotions must set Stage to 'New Lead' (not 'Price Drop')
 *   - the review must never change a lead's Stage (dealbreakers are flagged
 *     in notes/email only)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const airtable = require('../lib/airtable');
const { initFilter } = require('../lib/filter');
const { runPriceCheck } = require('../lib/price-checker');
const { runReview } = require('../lib/review');

function stubAirtable(t, { stageRecords, record }) {
  const original = {
    getRecordsByStage: airtable.getRecordsByStage,
    resolveCountyFields: airtable.resolveCountyFields,
    getRecordById: airtable.getRecordById,
    updateRecord: airtable.updateRecord,
  };
  const updates = [];
  airtable.getRecordsByStage = async stage => stageRecords[stage] || [];
  airtable.resolveCountyFields = () => ({ county: 'Wayne', state: 'KY' });
  airtable.getRecordById = async () => record;
  airtable.updateRecord = async (recordId, fields, protectStage) => {
    updates.push({ recordId, fields, protectStage });
    return { id: recordId };
  };
  t.after(() => Object.assign(airtable, original));
  return updates;
}

test('a promotable price drop moves the record to New Lead, not Price Drop', { timeout: 60000 }, async (t) => {
  // Local listing page: current price $300,000 (down from stored $500,000).
  // 100 acres → $3,000/ac vs the $2,900/ac target = 3.4% over → promotable.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><script type="application/ld+json">
      {"@type":"Product","offers":{"price":"300000"}}
    </script></head><body>Listing</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { FIELDS, STAGES } = airtable;
  const record = {
    id: 'recWatch00000001X',
    fields: {
      Name: 'Watch Tract',
      [FIELDS.url]: `http://127.0.0.1:${server.address().port}/listing`,
      [FIELDS.price]: 500000,
      [FIELDS.acres]: 100,
      [FIELDS.created]: new Date().toISOString(),
    },
  };

  initFilter(new Map([['wayne|KY', 2900]]));
  const updates = stubAirtable(t, { stageRecords: { [STAGES.watch]: [record] }, record });

  const report = await runPriceCheck({ dryRun: false });

  assert.equal(report.promoted, 1);
  const stageUpdates = updates.filter(u => u.fields.Stage);
  assert.equal(stageUpdates.length, 1);
  assert.equal(stageUpdates[0].fields.Stage, STAGES.newLead);
});

test('the review never changes a lead Stage, even on dealbreakers', async (t) => {
  const { FIELDS, STAGES } = airtable;
  const record = {
    id: 'recNewLead000001X',
    fields: {
      Name: 'Flagged Tract',
      Stage: STAGES.newLead,
      [FIELDS.price]: 200000,
      [FIELDS.acres]: 100,
      [FIELDS.notes]: 'Beautiful tract but landlocked with no road access.',
      [FIELDS.created]: new Date().toISOString(),
    },
  };

  initFilter(new Map([['wayne|KY', 2900]]));
  const updates = stubAirtable(t, { stageRecords: { [STAGES.newLead]: [record] }, record });

  const report = await runReview();

  assert.equal(report.reviewed, 1);
  assert.equal(report.flagged.length, 1, 'dealbreaker must still be flagged in the report');
  for (const u of updates) {
    assert.equal('Stage' in u.fields, false, `review must not write Stage (wrote: ${JSON.stringify(u.fields)})`);
  }
  // The dealbreaker analysis must still land in the notes
  const noteUpdate = updates.find(u => u.fields[FIELDS.notes]);
  assert.ok(noteUpdate, 'analysis must be written to Scraper Notes');
  assert.match(noteUpdate.fields[FIELDS.notes], /landlocked/i);
});
