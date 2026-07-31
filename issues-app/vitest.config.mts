import { defineConfig } from 'vitest/config';

/**
 * Every test file spins up its own @electric-sql/pglite (Postgres-in-WASM)
 * instance per test (see test/helpers/pglite.ts) and replays all
 * migrations — real but not free. Under parallel test-file execution this
 * can occasionally exceed vitest's 10s default hook timeout on a loaded
 * machine; raise it rather than papering over a slow/flaky failure.
 */
export default defineConfig({
  test: {
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
