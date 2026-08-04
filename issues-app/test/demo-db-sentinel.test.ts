/**
 * demo-db-sentinel.test.ts — regression coverage for lib/db/client.ts's
 * demo-mode guard.
 *
 * Before the fix, ISSUES_DEMO=1's getDb() opened `new PGlite('.demo-db')`
 * unconditionally — PGlite creates the on-disk directory on first use
 * regardless of whether anything was ever migrated/seeded into it, so a
 * missing or interrupted-setup .demo-db/ silently produced an empty,
 * unmigrated database instead of a catchable error. app/_lib/db.ts's
 * tryGetDb()/requireDb() only catch a SYNCHRONOUS throw from getDb(), and
 * the old code never threw one in demo mode — every route then 500'd on
 * its first query with a raw "relation does not exist" error instead of
 * rendering the graceful DatabaseUnavailable empty state.
 *
 * FAILS before the fix: getDb() with ISSUES_DEMO=1 never throws, no matter
 * what .demo-db/ looks like. PASSES after: getDb() throws synchronously
 * (catchable by tryGetDb) unless the .seed-complete sentinel is present.
 *
 * Uses vi.resetModules() + a fresh dynamic import per test (rather than the
 * static top-level import used elsewhere) because lib/db/client.ts caches
 * its db handle in a module-scope singleton — each test needs its own
 * unevaluated copy of the module bound to its own scratch cwd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('lib/db/client.ts demo-mode sentinel guard', () => {
  const originalCwd = process.cwd();
  const originalIssuesDemo = process.env.ISSUES_DEMO;
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'issues-demo-client-test-'));
    process.chdir(scratchDir);
    process.env.ISSUES_DEMO = '1';
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalIssuesDemo === undefined) delete process.env.ISSUES_DEMO;
    else process.env.ISSUES_DEMO = originalIssuesDemo;
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('throws synchronously when .demo-db/ does not exist at all (never silently creates an empty db)', async () => {
    const { getDb } = await import('../lib/db/client.ts');
    expect(() => getDb()).toThrow(/never fully seeded|seed-complete/i);
  });

  it('throws synchronously when .demo-db/ exists but was never fully seeded (interrupted setup)', async () => {
    // Simulates Ctrl-C mid-seed: PGlite created the directory, but
    // demo-seed.ts never reached its final "write the sentinel" step.
    mkdirSync(join(scratchDir, '.demo-db'), { recursive: true });
    writeFileSync(join(scratchDir, '.demo-db', 'PG_VERSION'), '17\n');

    const { getDb } = await import('../lib/db/client.ts');
    expect(() => getDb()).toThrow(/never fully seeded|seed-complete/i);
  });

  it('a thrown error from getDb() is caught by app/_lib/db.ts-style try/catch, matching the missing-DATABASE_URL contract', async () => {
    const { getDb } = await import('../lib/db/client.ts');
    let caught: unknown = null;
    try {
      getDb();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('does not throw once the .seed-complete sentinel is present', async () => {
    mkdirSync(join(scratchDir, '.demo-db'), { recursive: true });
    writeFileSync(join(scratchDir, '.demo-db', '.seed-complete'), `${new Date().toISOString()}\n`);

    const { getDb } = await import('../lib/db/client.ts');
    expect(() => getDb()).not.toThrow();
  });
});
