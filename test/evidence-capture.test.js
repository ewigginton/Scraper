'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  shortHash,
  evidenceFileName,
  computePendingUrls,
  processEvidenceRequests,
} = require('../lib/evidence-capture');

const URL_A = 'https://www.landwatch.com/kentucky/knott-county/land-for-sale?minAcreage=40';
const URL_B = 'https://www.landflip.com/land-for-sale/alabama';

function tmpEvidenceDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('(e) evidence filename and hash are stable across runs for the same URL', () => {
  assert.equal(evidenceFileName(URL_A), evidenceFileName(URL_A));
  assert.equal(shortHash(URL_A), shortHash(URL_A));
  assert.match(evidenceFileName(URL_A), /^www\.landwatch\.com-.*-[0-9a-f]{8}\.html$/);
  // Distinct URLs map to distinct files.
  assert.notEqual(evidenceFileName(URL_A), evidenceFileName(URL_B));
});

test('computePendingUrls skips URLs whose evidence file already exists and dedupes', () => {
  const existing = [evidenceFileName(URL_A)];
  assert.deepEqual(computePendingUrls([URL_A, URL_B], existing), [URL_B]);
  // Duplicate request collapses to a single capture.
  assert.deepEqual(computePendingUrls([URL_B, URL_B], []), [URL_B]);
});

test('(a) empty urls does no work and never invokes capture or push', async (t) => {
  const dir = tmpEvidenceDir(t);
  let captured = 0;
  let pushed = 0;
  const result = await processEvidenceRequests({
    urls: [],
    evidenceDir: dir,
    captureUrl: async () => { captured++; return 'x'; },
    gitPushEvidence: async () => { pushed++; return true; },
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(result, { captured: 0, skipped: 0, failed: 0, pushed: false, capturedFiles: [] });
  assert.equal(captured, 0);
  assert.equal(pushed, 0);
});

test('(b) an already-captured URL is skipped (no capture, no push)', async (t) => {
  const dir = tmpEvidenceDir(t);
  fs.writeFileSync(path.join(dir, evidenceFileName(URL_A)), '<html>old</html>');
  let captureCalls = 0;
  let pushCalls = 0;
  const result = await processEvidenceRequests({
    urls: [URL_A],
    evidenceDir: dir,
    captureUrl: async () => { captureCalls++; return '<html>new</html>'; },
    gitPushEvidence: async () => { pushCalls++; return true; },
    logger: { log() {}, error() {} },
  });
  assert.equal(captureCalls, 0);
  assert.equal(pushCalls, 0);
  assert.equal(result.captured, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.pushed, false);
});

test('(c) a new URL is captured, written to disk, and push is invoked', async (t) => {
  const dir = tmpEvidenceDir(t);
  const pushArgs = [];
  const result = await processEvidenceRequests({
    urls: [URL_A],
    evidenceDir: dir,
    captureUrl: async () => '<html>captured</html>',
    gitPushEvidence: async (files) => { pushArgs.push(files); return true; },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.captured, 1);
  assert.equal(result.pushed, true);
  const name = evidenceFileName(URL_A);
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), '<html>captured</html>');
  assert.deepEqual(pushArgs, [[name]]);
});

test('(d) a capture failure is non-fatal: other URLs proceed and push still runs for successes', async (t) => {
  const dir = tmpEvidenceDir(t);
  let pushed = false;
  const result = await processEvidenceRequests({
    urls: [URL_A, URL_B],
    evidenceDir: dir,
    captureUrl: async (url) => {
      if (url === URL_A) throw new Error('HTTP 403 wall');
      return '<html>b ok</html>';
    },
    gitPushEvidence: async () => { pushed = true; return true; },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.captured, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.pushed, true);
  assert.equal(pushed, true);
  // The failed URL left no file; the successful one is present.
  assert.equal(fs.existsSync(path.join(dir, evidenceFileName(URL_A))), false);
  assert.equal(fs.existsSync(path.join(dir, evidenceFileName(URL_B))), true);
});

test('push is not invoked when every capture fails', async (t) => {
  const dir = tmpEvidenceDir(t);
  let pushCalls = 0;
  const result = await processEvidenceRequests({
    urls: [URL_A],
    evidenceDir: dir,
    captureUrl: async () => { throw new Error('offline'); },
    gitPushEvidence: async () => { pushCalls++; return true; },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.captured, 0);
  assert.equal(result.failed, 1);
  assert.equal(pushCalls, 0);
  assert.equal(result.pushed, false);
});

test('polite delay is applied between fetches but not after the last', async (t) => {
  const dir = tmpEvidenceDir(t);
  const sleeps = [];
  await processEvidenceRequests({
    urls: [URL_A, URL_B],
    evidenceDir: dir,
    captureUrl: async () => '<html>x</html>',
    gitPushEvidence: async () => true,
    delayMs: 1234,
    sleep: async (ms) => { sleeps.push(ms); },
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(sleeps, [1234]);
});
