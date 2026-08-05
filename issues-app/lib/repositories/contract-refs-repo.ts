/**
 * contract-refs-repo — read-only DB access for contract_refs (Wave 2b
 * roadmap: "Case left-panel contract/transaction overview + CRM links",
 * spec §9.1/§30.2). Mirrors the read-through-cache role property_refs/
 * person_refs already play: contract_refs is NOT canonical (the Hub's
 * Sales/Transactions module + Contract workflow own the real Contract
 * record — see supabase/migrations/20260804120000_issues_contract_refs.sql's
 * table comment), so this module only ever SELECTs.
 */

import { desc, eq, sql } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { contractRefs, type ContractRef } from '../db/schema.ts';
import { isUuid } from './id-guard.ts';

const FOR_PROPERTY_LIMIT = 20;

/**
 * Every contract_refs row linked to a property, newest executed_date first
 * (nulls last), bounded per this app's "every list query bounded" rule.
 * A property normally has at most a handful of contracts across its life
 * (offer/counter/executed/rescinded generations), so FOR_PROPERTY_LIMIT is
 * generous headroom, not a real pagination need.
 */
export async function getForProperty(db: DbHandle, propertyRefId: string): Promise<ContractRef[]> {
  if (!isUuid(propertyRefId)) return [];
  return db
    .select()
    .from(contractRefs)
    .where(eq(contractRefs.propertyRefId, propertyRefId))
    .orderBy(sql`${contractRefs.executedDate} desc nulls last`, desc(contractRefs.createdAt))
    .limit(FOR_PROPERTY_LIMIT);
}

/** Single contract_refs row by id, for the /contracts/[id] stub route. */
export async function getById(db: DbHandle, id: string): Promise<ContractRef | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(contractRefs).where(eq(contractRefs.id, id)).limit(1);
  return row ?? null;
}
