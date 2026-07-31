/**
 * audit.ts — the single audit-writing helper every command in lib/services
 * calls, in the SAME transaction as the fact it just wrote (spec §29.2,
 * DESIGN.md hard rule #4). This module contains no business rules; it is a
 * thin, consistent wrapper over lib/repositories/audit-repo.ts so every
 * command produces a uniformly-shaped audit_events row.
 *
 * audit_events is append-only at the DB level (trigger + RLS, see
 * supabase/migrations); this module never attempts an update/delete.
 */

import * as auditRepo from '../repositories/audit-repo.ts';
import type { DbHandle } from '../repositories/db-handle.ts';
import type { AuditEvent } from '../db/schema.ts';

export interface WriteAuditInput {
  /** person_refs.id of the actor, or null for a system/service action. */
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) when the actor is not (yet) a person_refs row. */
  actorExternalId?: string | null;
  /** The role the actor was acting under (spec §29.2 "effective role"). */
  actorRole?: string | null;
  /** Short machine-readable action name, e.g. 'hold_applied', 'issue_created'. */
  action: string;
  /** The table the audited fact lives in, e.g. 'holds', 'issues'. */
  objectTable: string;
  /** The row id the audited fact lives in. */
  objectId: string;
  /** JSON snapshot of the object before the change (null if newly created). */
  before?: unknown;
  /** JSON snapshot of the object after the change. */
  after?: unknown;
  /** Human-readable justification; required by several commands (holds, overrides, stale ack). */
  reason?: string | null;
  /** Correlates this audit row to other audit rows / domain events from the same command. */
  correlationId?: string | null;
  /** Free-text provenance, e.g. the service function name that wrote this row. */
  source?: string | null;
}

/**
 * Append one audit_events row. Never updates or deletes an existing row.
 * Callers MUST pass the same `tx` they used for the audited write so both
 * land in one transaction (all-or-nothing).
 */
export async function writeAudit(tx: DbHandle, input: WriteAuditInput): Promise<AuditEvent> {
  return auditRepo.append(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: input.action,
    objectTable: input.objectTable,
    objectId: input.objectId,
    before: input.before === undefined ? null : (input.before as AuditEvent['before']),
    after: input.after === undefined ? null : (input.after as AuditEvent['after']),
    reason: input.reason ?? null,
    correlationId: input.correlationId ?? null,
    source: input.source ?? null,
  });
}
