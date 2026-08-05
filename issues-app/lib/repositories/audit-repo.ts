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

export interface ListForObjectOptions {
  /** Caps rows returned; also required for the query to carry a LIMIT — see docs/notion-redesign.md "no unbounded reads anywhere". */
  limit?: number;
  offset?: number;
}

/**
 * List audit_events for a given object (object_table + object_id), newest
 * first. `opts.limit` (Issues UI v2 addition) bounds the query — callers
 * that read a single object's full audit trail for further in-memory
 * merging (e.g. app/_lib/case-view.ts's cross-object History feed) should
 * still pass a defensive cap rather than leave this unbounded.
 */
export async function listForObject(
  db: DbHandle,
  objectTable: string,
  objectId: string,
  opts: ListForObjectOptions = {},
): Promise<AuditEvent[]> {
  const base = db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.objectTable, objectTable), eq(auditEvents.objectId, objectId)))
    .orderBy(desc(auditEvents.occurredAt));
  if (opts.limit !== undefined) {
    return opts.offset !== undefined ? base.limit(opts.limit).offset(opts.offset) : base.limit(opts.limit);
  }
  return base;
}
