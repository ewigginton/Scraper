/**
 * possession-service.ts — record a possession/vacancy observation
 * (possession_records, spec §29.10/§28.3). Modeled directly on
 * hold-service.ts: same per-property advisory lock (so a possession
 * observation recorded concurrently with a release transition on the same
 * property cannot be invisible to it, matching the TOCTOU protection
 * transitionPhase/applyHold/releaseHold already share), same audited-write
 * shape.
 *
 * ADVERSARIAL-REVIEW FIX: prior to this module, `possession_records` had NO
 * write path anywhere in lib/services/ — only test fixtures ever inserted
 * into it directly — so the `vacancy_verified` prerequisite and the
 * `possession_unresolved` eligibility blocker were structurally
 * unsatisfiable through the shipped command layer for any property whose
 * possession status wasn't planted straight into the DB, bypassing the app
 * entirely. This is the missing write side; app/actions.ts wires it into a
 * server action.
 */

import { eq, sql } from 'drizzle-orm';
import type { DbHandle } from '../repositories/db-handle.ts';
import { issues, possessionRecords, type NewPossessionRecord, type PossessionRecord, type PossessionStatus } from '../db/schema.ts';
import { writeAudit } from './audit.ts';
import { applyHold, releaseHold } from './hold-service.ts';
import { createFollowUp } from './task-service.ts';
import * as holdsRepo from '../repositories/holds-repo.ts';
import { assertIssueAuthorized, RELEASE_GATE_FACT_ROLES } from './issue-authz.ts';
import { businessTodayIso } from '../date/business-today.ts';

/**
 * Possession statuses that satisfy the "vacancy/possession resolved"
 * prerequisite. Mirrors eligibility-service.ts's POSSESSION_RESOLVED_STATUSES
 * exactly — kept as a separate literal here (rather than importing it)
 * because eligibility-service.ts is the read-side chokepoint and must not
 * depend on this write-side module; duplication is the smaller coupling
 * risk.
 *
 * ROUND-3 ADVERSARIAL-REVIEW FIX (P0 companion — round 2's negative-status
 * allowlist here was as incomplete as eligibility-service.ts's, missing
 * `unknown`/`removal_authorized`/`stored`/`transferred`/`disposed`, so
 * recording one of those never created the occupancy hold either, leaving
 * BOTH lines of defense absent for those statuses simultaneously). Rather
 * than enumerate a second negative list that can drift out of sync with the
 * DB check constraint the same way, this module now branches on the
 * inverse of POSSESSION_RESOLVED_STATUSES directly: any status that is not
 * resolved is treated as requiring the blocking hold, and any status that
 * IS resolved supersedes/releases a prior hold. Requirements §29.6 line
 * 806: "Suspected occupancy, personal property, animals, vehicles, unsafe
 * structures ... or disputed possession shall create the appropriate
 * blocking hold and review Task." Holds give a second, independent line of
 * defense that doesn't depend on possession_records at all (the
 * `no_blocking_holds` prerequisite / activeHoldBlockers already consult
 * holds regardless of issue type).
 */
const POSSESSION_RESOLVED_STATUSES = new Set(['vacancy_verified', 'cleared']);

const OCCUPANCY_REVIEW_DAYS = 3;

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Mirrors hold-service.ts's lockProperty exactly (same key derivation, same reasoning). */
async function lockProperty(tx: DbHandle, propertyRefId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${propertyRefId}::text, 0))`);
}

export class PossessionServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PossessionServiceError';
    this.code = code;
  }
}

export interface RecordPossessionInput {
  issueId: string;
  possessionStatus: PossessionStatus;
  observedAt?: Date;
  observerId?: string | null;
  observerPersonRefId?: string | null;
  evidenceRefs?: unknown[];
  notes?: string | null;
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  /** Roles the acting user currently holds — rechecked server-side regardless of what the UI offered (never from form data). */
  actorRoles?: string[];
  correlationId?: string | null;
}

/**
 * Record a new possession/vacancy observation for the property behind
 * `issueId`. Possession history is append-only (each observation is a new
 * row, never an update to a prior one — matches personal_property_items'
 * documented model and lets `possession_records_observed_at_idx`/the
 * vacancyVerified/possessionBlocker "most recent row wins" reads stay
 * simple). Audits and (unlike hold apply/release) does not publish a
 * domain event — spec §7/§8.1 name explicit event types for hold apply/
 * release, reinstatement, and issue creation, not for routine possession
 * observations, matching the same DECISION task-service.ts already
 * documents for its own commands.
 */
export async function recordPossession(tx: DbHandle, input: RecordPossessionInput): Promise<PossessionRecord> {
  if (!input.issueId) {
    throw new PossessionServiceError('issue_id_required', 'A possession observation requires the issue it belongs to.');
  }
  if (!input.possessionStatus) {
    throw new PossessionServiceError('possession_status_required', 'A possession observation requires a status.');
  }

  const [issue] = await tx.select().from(issues).where(eq(issues.id, input.issueId));
  if (!issue) {
    throw new PossessionServiceError('issue_not_found', `Issue ${input.issueId} not found.`);
  }

  // ADVERSARIAL-REVIEW FIX (round 2, P1 IDOR) — see issue-authz.ts's doc
  // comment.
  assertIssueAuthorized(input, 'Recording a possession observation');

  await lockProperty(tx, issue.propertyRefId);

  const observedAt = input.observedAt ?? new Date();
  const values: NewPossessionRecord = {
    issueId: input.issueId,
    propertyRefId: issue.propertyRefId,
    possessionStatus: input.possessionStatus,
    observedAt,
    observerId: input.observerId ?? input.actorExternalId ?? null,
    observerPersonRefId: input.observerPersonRefId ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
    notes: input.notes ?? null,
  };

  const [record] = await tx.insert(possessionRecords).values(values).returning();
  if (!record) {
    throw new Error('possession-service.recordPossession: insert returned no row');
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'possession_recorded',
    objectTable: 'possession_records',
    objectId: record.id,
    before: null,
    after: record,
    reason: input.notes ?? null,
    correlationId: input.correlationId ?? null,
    source: 'possession-service.recordPossession',
  });

  // ADVERSARIAL-REVIEW FIX (§29.6 line 806): a non-resolved observation
  // must create the blocking hold + review task itself, not rely solely on
  // eligibility-service reading possession_records at the moment of a
  // release attempt (defense in depth — see the P0 finding this pairs
  // with). A later vacancy_verified/cleared observation supersedes
  // (releases) any occupancy hold this recorded previously, since the new
  // observation is the more current evidence.
  if (!POSSESSION_RESOLVED_STATUSES.has(input.possessionStatus)) {
    const activeHolds = await holdsRepo.activeForProperty(tx, issue.propertyRefId);
    const alreadyHeld = activeHolds.some((h) => h.holdType === 'occupancy');
    if (!alreadyHeld) {
      await applyHold(tx, {
        propertyRefId: issue.propertyRefId,
        issueId: input.issueId,
        holdType: 'occupancy',
        reason: `Possession status recorded as "${input.possessionStatus.replace(/_/g, ' ')}" (spec §29.6).`,
        source: 'possession-service.recordPossession',
        ownerId: input.actorExternalId ?? null,
        // ROUND-3 ADVERSARIAL-REVIEW FIX (P1: unaudited hold release): this
        // hold must be releasable by the same role class that is allowed to
        // record the superseding vacancy_verified/cleared observation
        // (RELEASE_GATE_FACT_ROLES / assertIssueAuthorized above), NOT the
        // package-wide manager/admin default hold-service.releaseHold falls
        // back to when releaseAuthority is unset — otherwise the release
        // call below would throw release_not_authorized for the ordinary
        // case of a coordinator clearing their own occupancy observation.
        // hold-service.releaseHold treats release_authority as a
        // comma-separated role list, so this authorizes exactly the same
        // three roles issue-authz.ts allows to record the observation.
        releaseAuthority: RELEASE_GATE_FACT_ROLES.join(','),
        actorId: input.actorId ?? null,
        actorExternalId: input.actorExternalId ?? null,
        actorRole: input.actorRole ?? null,
        correlationId: input.correlationId ?? null,
      });
      await createFollowUp(tx, {
        issueId: input.issueId,
        propertyRefId: issue.propertyRefId,
        assigneeId: input.actorExternalId ?? null,
        queue: input.actorExternalId ? null : 'new_unreviewed',
        title: 'Verify possession/vacancy before release',
        description: `Possession observation recorded as "${input.possessionStatus.replace(/_/g, ' ')}"; verify and clear before this property can release (spec §29.6).`,
        priority: 'urgent',
        // ROUND-2 FIX (P2): this used to derive the due date from
        // `observedAt.toISOString().slice(0, 10)` — the UTC calendar day —
        // which is exactly the pattern lib/date/business-today.ts's own
        // header names as the bug it exists to eliminate. For roughly a
        // quarter of every day (US timezones, evening observations), the
        // UTC day is already tomorrow relative to the business's local
        // calendar day, silently misdating this urgent release-gating
        // verification task a day late. businessTodayIso(observedAt)
        // resolves the correct business-local calendar day for this
        // observation's instant, matching every other due-date call site.
        dueDate: addDaysIso(businessTodayIso(observedAt), OCCUPANCY_REVIEW_DAYS),
        actorId: input.actorId ?? null,
        actorExternalId: input.actorExternalId ?? null,
        actorRole: input.actorRole ?? null,
        correlationId: input.correlationId ?? null,
      });
    }
  } else {
    // ROUND-3 ADVERSARIAL-REVIEW FIX (P1): this used to call
    // holdsRepo.release directly — the raw repository mutation — which
    // bypassed hold-service.releaseHold entirely: no audit_events row, no
    // property_operations.hold_released domain event, and no
    // release-authority check, for what is the most security-sensitive
    // state change in the package. Routing through releaseHold restores
    // all three in the same transaction, threaded from this command's own
    // actor fields. Scoped to holds raised from THIS issue (not every
    // active occupancy hold on the property) so recording vacancy on one
    // issue can never silently clear an occupancy hold raised by an
    // unrelated issue on the same property.
    const activeHolds = await holdsRepo.activeForProperty(tx, issue.propertyRefId);
    for (const hold of activeHolds.filter((h) => h.holdType === 'occupancy' && h.issueId === input.issueId)) {
      await releaseHold(tx, {
        holdId: hold.id,
        releasedBy: input.actorExternalId ?? 'system:possession-service',
        actorRoles: input.actorRoles ?? [],
        reason: `Superseded by a later possession observation of "${input.possessionStatus.replace(/_/g, ' ')}".`,
        actorId: input.actorId ?? null,
        actorExternalId: input.actorExternalId ?? null,
        actorRole: input.actorRole ?? null,
        correlationId: input.correlationId ?? null,
      });
    }
  }

  return record;
}
