/**
 * hold-service.ts — apply/release restrictions (spec §20 "Restriction/Hold",
 * §21, §29.10 stop-work). A property may carry multiple simultaneous holds
 * (holds-repo has no uniqueness constraint on active holds per type); this
 * module adds no such restriction either, matching the data model.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as holdsRepo from '../repositories/holds-repo.ts';
import type { DbHandle } from '../repositories/db-handle.ts';
import { holds, type Hold, type HoldType } from '../db/schema.ts';
import { writeAudit } from './audit.ts';
import { publishDomainEvent } from './events.ts';
import { createFollowUp } from './task-service.ts';

/**
 * Per-property serialization lock (adversarial-review TOCTOU finding):
 * transition-engine.transitionPhase takes the same lock before reading
 * holds/possession, so a hold applied concurrently with a release
 * transition on the same property can no longer be invisible to it under
 * READ COMMITTED — one of the two transactions blocks until the other
 * commits/rolls back. hashtextextended gives a stable 64-bit lock key from
 * the property_ref_id text without a separate numeric-id scheme.
 */
async function lockProperty(tx: DbHandle, propertyRefId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${propertyRefId}::text, 0))`);
}

/** Roles allowed to release a hold when the hold's own release_authority is unset/unmatched. */
const DEFAULT_RELEASE_AUTHORITY_ROLES = ['manager', 'admin'];

export class HoldServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HoldServiceError';
    this.code = code;
  }
}

export interface ApplyHoldInput {
  propertyRefId: string;
  issueId?: string | null;
  holdType: HoldType;
  reason: string;
  scope?: string | null;
  source?: string | null;
  ownerId?: string | null;
  releaseCriteria?: string | null;
  releaseAuthority?: string | null;
  effectiveStart?: Date;
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/** Apply a new hold. Audits and publishes property_operations.hold_applied in the same transaction. */
export async function applyHold(tx: DbHandle, input: ApplyHoldInput): Promise<Hold> {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new HoldServiceError('reason_required', 'A hold requires a reason.');
  }

  await lockProperty(tx, input.propertyRefId);

  const hold = await holdsRepo.apply(tx, {
    propertyRefId: input.propertyRefId,
    issueId: input.issueId ?? null,
    holdType: input.holdType,
    scope: input.scope ?? null,
    reason: input.reason,
    source: input.source ?? null,
    ownerId: input.ownerId ?? null,
    releaseCriteria: input.releaseCriteria ?? null,
    releaseAuthority: input.releaseAuthority ?? null,
    effectiveStart: input.effectiveStart ?? new Date(),
  });

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'hold_applied',
    objectTable: 'holds',
    objectId: hold.id,
    before: null,
    after: hold,
    reason: input.reason,
    correlationId: input.correlationId ?? null,
    source: 'hold-service.applyHold',
  });

  await publishDomainEvent(tx, {
    eventType: 'property_operations.hold_applied',
    payload: { holdId: hold.id, holdType: hold.holdType, propertyRefId: hold.propertyRefId, issueId: hold.issueId },
    propertyRefId: hold.propertyRefId,
    issueId: hold.issueId,
    actor: input.actorId ?? null,
    correlationId: input.correlationId ?? null,
    idempotencyKey: `hold_applied:${hold.id}`,
  });

  return hold;
}

export interface ReleaseHoldInput {
  holdId: string;
  /** Free-text identity of who is releasing it (stored on holds.released_by). */
  releasedBy: string;
  /** Roles the releasing actor currently holds — checked against authority. */
  actorRoles: string[];
  reason: string;
  actorId?: string | null;
  /**
   * Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded
   * on audit_events.actor_external_id. ADVERSARIAL-REVIEW FIX: this field
   * was missing entirely (unlike ApplyHoldInput's actorExternalId), so
   * releasing a hold — the most security-sensitive command in this
   * package — was audited with NO attributable actor whenever actorId is
   * null, which is the shape every server action produces (Hub staff
   * identity is a free-text external identity, not a person_refs uuid).
   */
  actorExternalId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/**
 * Release an active hold. Requires a reason and an authorized role
 * (spec §20 "release authority"). If the hold row names a specific
 * `release_authority` role, the actor must hold that role; otherwise the
 * default authority (manager/admin) applies. Business rule, never a silent
 * bypass — an unauthorized attempt throws rather than proceeding.
 */
export async function releaseHold(tx: DbHandle, input: ReleaseHoldInput): Promise<Hold> {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new HoldServiceError('reason_required', 'Releasing a hold requires a reason.');
  }

  const [existing] = await tx.select().from(holds).where(eq(holds.id, input.holdId));

  if (!existing) {
    throw new HoldServiceError('hold_not_found', `Hold ${input.holdId} not found.`);
  }

  await lockProperty(tx, existing.propertyRefId);

  if (existing.releasedAt) {
    throw new HoldServiceError('hold_already_released', `Hold ${input.holdId} was already released.`);
  }

  // release_authority is a single text column but may name more than one
  // authorized role as a comma-separated list (e.g. possession-service's
  // occupancy holds, releasable by any of the same roles allowed to record
  // the superseding possession observation) — every existing caller sets a
  // single role, which round-trips unchanged through split(',').
  const requiredRoles = existing.releaseAuthority
    ? existing.releaseAuthority.split(',').map((role) => role.trim()).filter(Boolean)
    : DEFAULT_RELEASE_AUTHORITY_ROLES;
  const authorized = input.actorRoles.some((role) => requiredRoles.includes(role));
  if (!authorized) {
    throw new HoldServiceError(
      'release_not_authorized',
      `Releasing this ${existing.holdType} hold requires role(s): ${requiredRoles.join(', ')}.`,
    );
  }

  const released = await holdsRepo.release(tx, input.holdId, input.releasedBy, input.reason);
  if (!released) {
    throw new HoldServiceError('hold_not_found', `Hold ${input.holdId} not found.`);
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'hold_released',
    objectTable: 'holds',
    objectId: released.id,
    before: existing,
    after: released,
    reason: input.reason,
    correlationId: input.correlationId ?? null,
    source: 'hold-service.releaseHold',
  });

  await publishDomainEvent(tx, {
    eventType: 'property_operations.hold_released',
    payload: { holdId: released.id, holdType: released.holdType, propertyRefId: released.propertyRefId, issueId: released.issueId },
    propertyRefId: released.propertyRefId,
    issueId: released.issueId,
    actor: input.actorId ?? null,
    correlationId: input.correlationId ?? null,
    idempotencyKey: `hold_released:${released.id}`,
  });

  return released;
}

export interface ApplyStopWorkInput {
  propertyRefId: string;
  issueId?: string | null;
  /** The reported condition/source — recorded verbatim, never as a legal conclusion (spec §29.10). */
  reportedCondition: string;
  source: string;
  reviewerId: string;
  reviewDate: string;
  releaseAuthority?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

export interface ApplyStopWorkResult {
  hold: Hold;
  reviewTaskId: string;
}

/**
 * Place an immediate Stop Work/Review Required restriction (spec §29.10).
 * Records the reported condition and source without asserting a legal
 * conclusion, and creates the required review task/date. Blocks are
 * enforced by callers consulting eligibility-service / the active-hold
 * checks — this function does not itself special-case which downstream
 * actions are blocked (that is the eligibility chokepoint's job, per
 * DESIGN.md hard rule #1: one place evaluates blocking holds).
 */
export async function applyStopWork(tx: DbHandle, input: ApplyStopWorkInput): Promise<ApplyStopWorkResult> {
  if (!input.reportedCondition || input.reportedCondition.trim().length === 0) {
    throw new HoldServiceError('reported_condition_required', 'Stop-work requires the reported condition/source.');
  }
  if (!input.reviewerId) {
    throw new HoldServiceError('reviewer_required', 'Stop-work requires a responsible reviewer.');
  }
  if (!input.reviewDate) {
    throw new HoldServiceError('review_date_required', 'Stop-work requires a review date.');
  }

  const hold = await applyHold(tx, {
    propertyRefId: input.propertyRefId,
    issueId: input.issueId ?? null,
    holdType: 'stop_work',
    reason: input.reportedCondition,
    source: input.source,
    ownerId: input.reviewerId,
    releaseAuthority: input.releaseAuthority ?? 'manager',
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    correlationId: input.correlationId ?? randomUUID(),
  });

  // Reuses task-service.createFollowUp (rather than a raw tx.insert(tasks))
  // so this mandatory review task gets the same audit trail every other
  // task creation gets — the raw insert previously left no audit_events
  // row at all (adversarial-review finding; contrast
  // task-service.createFollowUp, which already audits its insert).
  const reviewTask = await createFollowUp(tx, {
    issueId: input.issueId ?? null,
    propertyRefId: input.propertyRefId,
    assigneeId: input.reviewerId,
    title: 'Stop Work / Review Required',
    description: input.reportedCondition,
    priority: 'urgent',
    dueDate: input.reviewDate,
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    correlationId: input.correlationId ?? null,
  });

  return { hold, reviewTaskId: reviewTask.id };
}
