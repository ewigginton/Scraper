#!/usr/bin/env node
/**
 * `npm run demo` — zero-setup local demo.
 *
 * Seeds a persisted PGlite database (.demo-db/) via scripts/demo-seed.ts
 * (migrations + fictional cases created through the real service layer),
 * then starts the Next.js dev server on port 4182 with ISSUES_DEMO=1 so
 * lib/db/client.ts serves from the embedded database. No Postgres install,
 * no Docker, no credentials. Pass --fresh to rebuild the demo data.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEMO_DIR = join(ROOT, '.demo-db');
// Written by scripts/demo-seed.ts only after a full successful seed —
// see lib/db/client.ts's DEMO_SEED_SENTINEL doc comment. Checking for this
// (not just "does .demo-db/ exist") matters because PGlite creates the
// directory on first open regardless of whether anything was ever
// migrated/seeded into it; treating a bare/broken directory as "already
// seeded" left `npm run demo` unable to self-heal after an interrupted
// first run (Ctrl-C mid-seed) without a manual --fresh or rm -rf.
const SEED_COMPLETE_SENTINEL = join(DEMO_DIR, '.seed-complete');

if (process.argv.includes('--fresh') && existsSync(DEMO_DIR)) {
  rmSync(DEMO_DIR, { recursive: true });
}

if (!existsSync(SEED_COMPLETE_SENTINEL)) {
  if (existsSync(DEMO_DIR)) {
    console.log('Demo database at .demo-db/ exists but was never fully seeded (interrupted run?) — rebuilding.');
    rmSync(DEMO_DIR, { recursive: true });
  }
  console.log('Building demo database (migrations + fixture cases)...');
  const seed = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'demo-seed.ts')],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (seed.status !== 0) process.exit(seed.status ?? 1);
}

console.log('Starting Issues demo at http://127.0.0.1:4182 (Ctrl+C to stop)');
const next = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', '4182'],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ISSUES_DEMO: '1' } },
);
next.on('exit', (code) => process.exit(code ?? 0));
