/**
 * Shared DB handle type for repositories.
 *
 * Every repository function takes this as its first argument instead of
 * importing lib/db/client.ts directly, so repositories work equally against:
 * - the production postgres-js driver (lib/db/client.ts), and
 * - the PGlite (Postgres-in-WASM) driver used in tests (see DESIGN.md §4/§9).
 *
 * `PgDatabase<any, any, any>` is the drizzle-orm base class both
 * `PostgresJsDatabase` and `PgliteDatabase` extend, and `PgTransaction` also
 * extends `PgDatabase` — so the same handle type covers a top-level db
 * client and a transaction callback's `tx` argument.
 */

import type { PgDatabase } from 'drizzle-orm/pg-core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbHandle = PgDatabase<any, any, any>;
