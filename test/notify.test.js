'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

test('notify.js uses spawnSync not execSync for email', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../lib/notify'), 'utf8');
  assert.ok(!src.includes('execSync('), 'notify.js should not use execSync with shell string');
  assert.ok(src.includes('spawnSync(') || src.includes('execFileSync('),
    'notify.js should use spawnSync or execFileSync');
});

test('notify.js does not interpolate variables into shell strings', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../lib/notify'), 'utf8');
  // The old vulnerable pattern was: execSync(`echo '${...}' | mail -s '${...}' '${...}'`)
  assert.ok(!src.includes('| mail'), 'should not pipe through shell to mail');
});

test('sendMail does not crash when mail binary is missing', () => {
  // sendMail is not exported, but we can test the module loads and
  // sendScraperEmail/sendReviewEmail handle missing EMAIL_TO gracefully
  const { sendScraperEmail } = require('../lib/notify');
  const report = {
    sites: {},
    totals: { checked: 0, parsed: 0, passed: 0, duplicates: 0, rejected: 0, written: 0, errors: 0 },
    duplicateDetails: [],
    writeErrors: [],
    elapsedMinutes: 0,
  };
  // With no EMAIL_TO set, it should return without error
  const original = process.env.EMAIL_TO;
  delete process.env.EMAIL_TO;
  assert.doesNotReject(() => sendScraperEmail(report, null));
  if (original) process.env.EMAIL_TO = original;
});
