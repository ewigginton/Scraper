/**
 * vendors-repo — basic DB access for the `vendors` table. Eligibility
 * rules (e.g. do_not_dispatch, expired W-9/insurance blocking dispatch)
 * live in lib/services, not here.
 */

import { eq } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { vendors, type NewVendor, type Vendor } from '../db/schema.ts';

/** Insert a new vendor row and return it. */
export async function create(db: DbHandle, data: NewVendor): Promise<Vendor> {
  const [row] = await db.insert(vendors).values(data).returning();
  if (!row) {
    throw new Error('vendors-repo.create: insert returned no row');
  }
  return row;
}

/** List all vendors. */
export async function list(db: DbHandle): Promise<Vendor[]> {
  return db.select().from(vendors);
}

/** Fetch a single vendor by id. */
export async function getById(db: DbHandle, id: string): Promise<Vendor | undefined> {
  const [row] = await db.select().from(vendors).where(eq(vendors.id, id));
  return row;
}
