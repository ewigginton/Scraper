'use strict';

/**
 * getIntakeQueue's filterByFormula is never executed by any existing test
 * (it's only exercised against a live Airtable base). This asserts the
 * formula string itself is well-formed: it must select New/Retry/empty
 * Status rows, and it must reclaim legacy-poller rows the production
 * incident notes describe (Status 'Needs Review' with a Result beginning
 * "HTTP ") without touching human-set Needs Review rows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const airtable = require('../lib/airtable');
const { buildIntakeQueueFormula, INTAKE_FIELDS, INTAKE_STATUS } = airtable;

test('buildIntakeQueueFormula selects empty/New/Retry Status rows', () => {
  const formula = buildIntakeQueueFormula();

  assert.match(formula, /^OR\(/, 'top-level formula must be an OR(...)');
  assert.ok(
    formula.includes(`{${INTAKE_FIELDS.status}} = ''`),
    `formula must match an empty ${INTAKE_FIELDS.status}: ${formula}`
  );
  assert.ok(
    formula.includes(`{${INTAKE_FIELDS.status}} = '${INTAKE_STATUS.new}'`),
    `formula must match Status = ${INTAKE_STATUS.new}: ${formula}`
  );
  assert.ok(
    formula.includes(`{${INTAKE_FIELDS.status}} = '${INTAKE_STATUS.retry}'`),
    `formula must match Status = ${INTAKE_STATUS.retry}: ${formula}`
  );
});

test('buildIntakeQueueFormula reclaims legacy-poller Needs-Review rows whose Result starts with "HTTP "', () => {
  const formula = buildIntakeQueueFormula();

  const reclaimClause = `AND({${INTAKE_FIELDS.status}} = '${INTAKE_STATUS.needsReview}', LEFT({${INTAKE_FIELDS.result}}, 5) = 'HTTP ')`;
  assert.ok(
    formula.includes(reclaimClause),
    `formula must include the exact reclaim clause: ${reclaimClause}\ngot: ${formula}`
  );
});

test('buildIntakeQueueFormula does not reclaim Failed rows or other Needs-Review reasons', () => {
  const formula = buildIntakeQueueFormula();

  // 'Failed' must never appear as a bare Status clause — only inside the
  // reclaim AND(), which it isn't part of at all.
  assert.equal(
    formula.includes(`{${INTAKE_FIELDS.status}} = '${INTAKE_STATUS.failed}'`),
    false,
    'Failed rows must never be reclaimed into the queue'
  );
  // The reclaim only fires for Needs Review rows AND'd with the HTTP-prefix
  // check — a bare Needs-Review clause without the AND/LEFT guard would
  // reclaim human-set rows too.
  assert.equal(
    formula.includes(`OR({${INTAKE_FIELDS.status}} = '${INTAKE_STATUS.needsReview}'`),
    false,
    'Needs Review must only appear inside the guarded AND() reclaim clause'
  );
});
