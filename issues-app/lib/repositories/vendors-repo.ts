/**
 * vendors-repo — basic DB access for the `vendors` table. Eligibility
 * rules (e.g. do_not_dispatch, expired W-9/insurance blocking dispatch)
 * live in lib/services, not here.
 */

import { asc, eq } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { vendors, type NewVendor, type Vendor } from '../db/schema.ts';

/** Bound on the vendors list, so this can never become an unbounded read as the table grows (docs/notion-redesign.md "no unbounded reads anywhere"). */
const LIST_LIMIT = 500;

/** Insert a new vendor row and return it. */
export async function create(db: DbHandle, data: NewVendor): Promise<Vendor> {
  const [row] = await db.insert(vendors).values(data).returning();
  if (!row) {
    throw new Error('vendors-repo.create: insert returned no row');
  }
  return row;
}

/** List vendors, alphabetically, with a stable id tiebreaker. Bounded via LIST_LIMIT. */
export async function list(db: DbHandle): Promise<Vendor[]> {
  return db.select().from(vendors).orderBy(asc(vendors.displayName), asc(vendors.id)).limit(LIST_LIMIT);
}

/** Fetch a single vendor by id. */
export async function getById(db: DbHandle, id: string): Promise<Vendor | undefined> {
  const [row] = await db.select().from(vendors).where(eq(vendors.id, id));
  return row;
}
