/**
 * events-repo — all DB access for the outbox-style `domain_events` table
 * and the `consumed_events` idempotent-consumption ledger (spec §30.3).
 * Callers (lib/services/events.ts) publish domain_events in the same
 * transaction as the authoritative fact; the company-wide bus/transport is
 * governed centrally and is out of scope here (DESIGN.md §2).
 */

import { and, eq } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import {
  consumedEvents,
  domainEvents,
  type ConsumedEvent,
  type DomainEvent,
  type NewConsumedEvent,
  type NewDomainEvent,
} from '../db/schema.ts';

/**
 * Publish a domain event. `idempotencyKey` is unique (domain_events has a
 * unique index on it) — publishing the same key twice is a no-op that
 * returns the already-recorded row rather than throwing, so callers don't
 * need a pre-check.
 */
export async function publish(db: DbHandle, data: NewDomainEvent): Promise<DomainEvent> {
  const [row] = await db
    .insert(domainEvents)
    .values(data)
    .onConflictDoNothing({ target: domainEvents.idempotencyKey })
    .returning();
  if (row) {
    return row;
  }

  const [existing] = await db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.idempotencyKey, data.idempotencyKey));
  if (!existing) {
    throw new Error('events-repo.publish: insert returned no row and no existing row was found');
  }
  return existing;
}

/**
 * Check whether (sourceSystem, idempotencyKey) has already been consumed.
 */
export async function wasConsumed(db: DbHandle, sourceSystem: string, idempotencyKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: consumedEvents.id })
    .from(consumedEvents)
    .where(and(eq(consumedEvents.sourceSystem, sourceSystem), eq(consumedEvents.idempotencyKey, idempotencyKey)));
  return row !== undefined;
}

/**
 * Record that (sourceSystem, idempotencyKey) has been consumed. Idempotent:
 * if the pair was already recorded, returns the existing row instead of
 * throwing on the unique constraint.
 */
export async function markConsumed(
  db: DbHandle,
  data: NewConsumedEvent,
): Promise<ConsumedEvent> {
  const [row] = await db
    .insert(consumedEvents)
    .values(data)
    .onConflictDoNothing({ target: [consumedEvents.sourceSystem, consumedEvents.idempotencyKey] })
    .returning();
  if (row) {
    return row;
  }

  const [existing] = await db
    .select()
    .from(consumedEvents)
    .where(and(eq(consumedEvents.sourceSystem, data.sourceSystem), eq(consumedEvents.idempotencyKey, data.idempotencyKey)));
  if (!existing) {
    throw new Error('events-repo.markConsumed: insert returned no row and no existing row was found');
  }
  return existing;
}
