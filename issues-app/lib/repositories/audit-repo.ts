/**
 * audit-repo — all DB access for the append-only `audit_events` table
 * (spec §29.2, §12). The table itself rejects UPDATE/DELETE via a DB
 * trigger (see supabase/migrations); this repo never attempts either.
 * Callers (every command in lib/services) are expected to append exactly
 * one audit_events row in the same transaction as the fact they wrote.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { auditEvents, type AuditEvent, type NewAuditEvent } from '../db/schema.ts';

/** Append one audit_events row. Never updates or deletes existing rows. */
export async function append(db: DbHandle, data: NewAuditEvent): Promise<AuditEvent> {
  const [row] = await db.insert(auditEvents).values(data).returning();
  if (!row) {
    throw new Error('audit-repo.append: insert returned no row');
  }
  return row;
}

/** List audit_events for a given object (object_table + object_id), newest first. */
export async function listForObject(
  db: DbHandle,
  objectTable: string,
  objectId: string,
): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.objectTable, objectTable), eq(auditEvents.objectId, objectId)))
    .orderBy(desc(auditEvents.occurredAt));
}
