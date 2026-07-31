/**
 * events.ts — publishes property_operations.* domain events in-transaction
 * (outbox pattern, spec §30.3, DESIGN.md §6) and provides the idempotent
 * inbound-event consumption primitive (`consumeEvent`) used by commands
 * that react to external events (e.g. issue-service.openFromLoanDefault
 * reacting to loan.defaulted — spec OPS-MV-001).
 *
 * DECISION: lib/repositories/events-repo.ts (already delivered by another
 * lane) exposes `publish`, `wasConsumed`, and `markConsumed`, but none of
 * them atomically "claim" a (sourceSystem, idempotencyKey) pair — the
 * combination needed to run a handler AT MOST ONCE under concurrency.
 * Rather than editing a file outside this lane's assigned paths
 * (lib/repositories/), `consumeEvent` below performs its own claim insert
 * (insert ... on conflict do nothing ... returning) directly against the
 * consumed_events table, inside the same transaction as the handler. The
 * unique index on (source_system, idempotency_key) is the actual safety
 * net: only one concurrent transaction can ever win the claim insert, so
 * the handler runs exactly once even under concurrent duplicate delivery.
 */

import type { DbHandle } from '../repositories/db-handle.ts';
import * as eventsRepo from '../repositories/events-repo.ts';
import { consumedEvents, type DomainEvent, type NewDomainEvent } from '../db/schema.ts';

export interface PublishDomainEventInput {
  /** Dotted event name, e.g. 'property_operations.hold_applied'. */
  eventType: string;
  schemaVersion?: number;
  sourceModule?: string;
  payload?: Record<string, unknown>;
  personRefId?: string | null;
  propertyRefId?: string | null;
  issueId?: string | null;
  occurredAt?: Date;
  /** Free-text actor identity (person_refs.id or a system name). */
  actor?: string | null;
  correlationId?: string | null;
  /**
   * Uniquely identifies this event occurrence. Publishing the same key
   * twice is a no-op (events-repo.publish uses ON CONFLICT DO NOTHING on
   * this column) — callers should derive it deterministically from the
   * fact being published (e.g. `hold_applied:${holdId}`) so retries of the
   * same command never double-publish.
   */
  idempotencyKey: string;
}

/** Publish one domain event in the caller's transaction (outbox write). */
export async function publishDomainEvent(tx: DbHandle, input: PublishDomainEventInput): Promise<DomainEvent> {
  const data: NewDomainEvent = {
    eventType: input.eventType,
    schemaVersion: input.schemaVersion ?? 1,
    sourceModule: input.sourceModule ?? 'property_operations',
    payload: input.payload ?? {},
    personRefId: input.personRefId ?? null,
    propertyRefId: input.propertyRefId ?? null,
    issueId: input.issueId ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    actor: input.actor ?? null,
    correlationId: input.correlationId ?? null,
    idempotencyKey: input.idempotencyKey,
  };
  return eventsRepo.publish(tx, data);
}

export type ConsumeEventResult<T> = { status: 'processed'; result: T } | { status: 'skipped_duplicate' };

/**
 * Atomically records (sourceSystem, idempotencyKey) into consumed_events
 * and runs `handler` at most once for that pair. `db` must be a top-level
 * DbHandle (not already inside a transaction) — this function opens its
 * own transaction so the claim and the handler's writes commit or roll
 * back together.
 *
 * If the pair was already consumed, `handler` is never invoked and
 * `{ status: 'skipped_duplicate' }` is returned — this is the mechanism
 * behind spec OPS-MV-001 ("duplicate loan.defaulted creates exactly one
 * issue") and OPS-MV-005/§28.7 (replayed webhooks are idempotent).
 */
export async function consumeEvent<T>(
  db: DbHandle,
  sourceSystem: string,
  idempotencyKey: string,
  handler: (tx: DbHandle) => Promise<T>,
): Promise<ConsumeEventResult<T>> {
  return db.transaction(async (tx) => {
    const claimed = await claimConsumption(tx, sourceSystem, idempotencyKey);
    if (!claimed) {
      return { status: 'skipped_duplicate' } as const;
    }

    try {
      const result = await handler(tx);
      return { status: 'processed', result } as const;
    } catch (err) {
      // Re-throw so the transaction (including the claim insert) rolls
      // back — a failed handler must be retryable, not permanently
      // marked "consumed".
      throw err;
    }
  });
}

/**
 * Insert-and-detect-new-row claim on (source_system, idempotency_key).
 * Returns true iff this call newly inserted the row (i.e. this caller
 * "won" the claim and should run its handler); false if a row already
 * existed (duplicate delivery).
 */
async function claimConsumption(tx: DbHandle, sourceSystem: string, idempotencyKey: string): Promise<boolean> {
  const [row] = await tx
    .insert(consumedEvents)
    .values({ sourceSystem, idempotencyKey, result: 'processed' })
    .onConflictDoNothing({ target: [consumedEvents.sourceSystem, consumedEvents.idempotencyKey] })
    .returning({ id: consumedEvents.id });
  return row !== undefined;
}
