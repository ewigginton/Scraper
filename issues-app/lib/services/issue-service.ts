/**
 * issue-service.ts — intake and case-lifecycle commands (spec §5.2, §7,
 * §28.4-28.5, §30.4, §31.2, DESIGN.md §6).
 */

import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { DbHandle } from '../repositories/db-handle.ts';
import * as issuesRepo from '../repositories/issues-repo.ts';
import { businessTodayIso } from '../date/business-today.ts';
import {
  approvals,
  holds,
  issuePeople,
  issues,
  phaseInstances,
  staleAcknowledgments,
  tasks,
  type Issue,
  type IssuePersonRole,
  type IssueType,
  type PhaseInstance,
  type Priority,
  type StaleAcknowledgment,
  type Task,
} from '../db/schema.ts';
import { writeAudit } from './audit.ts';
import { consumeEvent, publishDomainEvent, type ConsumeEventResult } from './events.ts';
import { applyHold } from './hold-service.ts';
import { assertIssueAuthorized } from './issue-authz.ts';

export class IssueValidationError extends Error {
  code = 'issue_validation_failed';
  violations: string[];
  constructor(violations: string[]) {
    super(`Issue intake validation failed: ${violations.join('; ')}`);
    this.name = 'IssueValidationError';
    this.violations = violations;
  }
}

function todayIso(): string {
  return businessTodayIso();
}

// =====================================================================
// createIssue — spec §5.2
// =====================================================================

export interface CreateIssuePersonInput {
  personRefId: string;
  role: IssuePersonRole;
  notes?: string;
}

export interface CreateIssueTaskInput {
  title: string;
  dueDate: string;
  assigneeId?: string | null;
  queue?: string | null;
  description?: string | null;
  priority?: Priority;
}

export interface CreateIssueInput {
  issueType: IssueType;
  propertyRefId: string;
  summary: string;
  priority?: Priority;
  coordinatorId?: string | null;
  queue?: string | null;
  /** People to link at intake. Required unless `noPeopleException` documents why none are known yet. */
  people?: CreateIssuePersonInput[];
  /** Documented reason no person could be linked at intake (spec §5.2 "or documented exception"). */
  noPeopleException?: string;
  initialTask: CreateIssueTaskInput;
  /**
   * Google My Maps link. Required (and written onto issues.map_link — a
   * Property-Operations-owned fact, NEVER property_refs) when
   * `entryPhaseKey` is 'recovery_review' (spec §5.2 "Property Recovery
   * review requires a Google My Maps link"). Optional otherwise.
   */
  mapLink?: string;
  /**
   * The phase_instances.phase_key the issue opens into. Defaults to
   * 'intake'. A caller opening directly into the Property Recovery review
   * workflow should pass 'recovery_review' so the map-link requirement
   * applies; a Loan-Services-triggered default case (which has not yet
   * done a map review) should leave this at the default.
   */
  entryPhaseKey?: string;
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

export interface CreateIssueResult {
  issue: Issue;
  task: Task;
  phaseInstance: PhaseInstance;
}

/**
 * Create a new Issue, enforcing spec §5.2's required-at-intake items:
 * property, summary, >=1 linked person (or a documented exception),
 * an initial task with a future due date, and priority. When entering
 * directly into the Property Recovery review phase, also requires a map
 * link (writing it onto property_refs if newly supplied).
 */
export async function createIssue(tx: DbHandle, input: CreateIssueInput): Promise<CreateIssueResult> {
  const violations: string[] = [];

  if (!input.propertyRefId) {
    violations.push('property is required');
  }
  if (!input.summary || input.summary.trim().length === 0) {
    violations.push('summary is required');
  }
  if ((!input.people || input.people.length === 0) && !input.noPeopleException) {
    violations.push('at least one linked person is required, or a documented exception');
  }
  if (!input.initialTask || !input.initialTask.title || input.initialTask.title.trim().length === 0) {
    violations.push('an initial task title is required');
  }
  if (!input.initialTask?.dueDate) {
    violations.push('the initial task requires a due date');
  } else if (input.initialTask.dueDate <= todayIso()) {
    violations.push('the initial task due date must be in the future');
  }
  if (input.initialTask && !input.initialTask.assigneeId && !input.initialTask.queue) {
    violations.push('the initial task requires an assignee or a queue');
  }

  const entryPhaseKey = input.entryPhaseKey ?? 'intake';
  const effectiveMapLink = input.mapLink ?? null;
  if (entryPhaseKey === 'recovery_review') {
    if (!effectiveMapLink || effectiveMapLink.trim().length === 0) {
      violations.push('Property Recovery review requires a Google My Maps link');
    }
  }

  if (violations.length > 0) {
    throw new IssueValidationError(violations);
  }

  // Property-Operations-owned fact: written onto issues.map_link, NEVER
  // property_refs.map_link. property_refs is a sync-owned read-through
  // cache with exactly one writer (the Inventory/Tables sync job) per its
  // own migration comment; a second writer here would be silently
  // clobbered by the next sync and violated DESIGN.md hard rule #2
  // (adversarial-review finding).
  const issue = await issuesRepo.create(tx, {
    issueType: input.issueType,
    propertyRefId: input.propertyRefId,
    summary: input.summary,
    priority: input.priority ?? 'normal',
    coordinatorId: input.coordinatorId ?? null,
    queue: input.queue ?? null,
    lifecycleStatus: 'intake',
    mapLink: effectiveMapLink,
  });

  for (const person of input.people ?? []) {
    await tx.insert(issuePeople).values({
      issueId: issue.id,
      personRefId: person.personRefId,
      role: person.role,
      notes: person.notes ?? null,
    });
  }

  const [phaseInstance] = await tx
    .insert(phaseInstances)
    .values({
      issueId: issue.id,
      phaseKey: entryPhaseKey,
      status: 'open',
      startedAt: new Date(),
      ownerId: input.coordinatorId ?? null,
      queue: input.queue ?? null,
    })
    .returning();
  if (!phaseInstance) {
    throw new Error('issue-service.createIssue: failed to open initial phase_instance');
  }

  const [task] = await tx
    .insert(tasks)
    .values({
      issueId: issue.id,
      phaseInstanceId: phaseInstance.id,
      propertyRefId: input.propertyRefId,
      assigneeId: input.initialTask.assigneeId ?? null,
      queue: input.initialTask.queue ?? null,
      title: input.initialTask.title,
      description: input.initialTask.description ?? null,
      dueDate: input.initialTask.dueDate,
      priority: input.initialTask.priority ?? input.priority ?? 'normal',
    })
    .returning();
  if (!task) {
    throw new Error('issue-service.createIssue: failed to create initial task');
  }

  const [updatedIssue] = await tx
    .update(issues)
    .set({ currentPhaseInstanceId: phaseInstance.id })
    .where(eq(issues.id, issue.id))
    .returning();
  if (!updatedIssue) {
    throw new Error('issue-service.createIssue: failed to link current phase instance');
  }

  const correlationId = input.correlationId ?? randomUUID();

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'issue_created',
    objectTable: 'issues',
    objectId: issue.id,
    before: null,
    after: updatedIssue,
    reason: input.noPeopleException ?? null,
    correlationId,
    source: 'issue-service.createIssue',
  });

  await publishDomainEvent(tx, {
    eventType: 'property_operations.issue_created',
    payload: { issueId: issue.id, issueType: issue.issueType, propertyRefId: issue.propertyRefId },
    issueId: issue.id,
    propertyRefId: issue.propertyRefId,
    actor: input.actorId ?? null,
    correlationId,
    idempotencyKey: `issue_created:${issue.id}`,
  });

  return { issue: updatedIssue, task, phaseInstance };
}

// =====================================================================
// openFromLoanDefault — spec OPS-MV-001, §30.4
// =====================================================================

export interface OpenFromLoanDefaultEvent {
  /** Loan Services' idempotency key for this loan.defaulted delivery (required — dedup key). */
  idempotencyKey: string;
  propertyRefId: string;
  summary?: string;
  people?: CreateIssuePersonInput[];
  coordinatorId?: string | null;
  queue?: string | null;
  initialTask?: CreateIssueTaskInput;
  priority?: Priority;
  actorId?: string | null;
  correlationId?: string | null;
}

export type OpenFromLoanDefaultResult =
  | { status: 'processed'; result: CreateIssueResult }
  | { status: 'skipped_duplicate' };

/**
 * Idempotently open (or, on replay, no-op) the recovery Issue for a
 * loan.defaulted domain event (spec §30.4, OPS-MV-001: "Loan Services
 * publishes loan.defaulted twice. One recovery Issue/transition is
 * created"). Never itself releases or makes the property Available —
 * §30.4 is explicit that a default event alone never does that.
 */
export async function openFromLoanDefault(db: DbHandle, event: OpenFromLoanDefaultEvent): Promise<OpenFromLoanDefaultResult> {
  return consumeEvent(db, 'loan_services', event.idempotencyKey, async (tx) => {
    return createIssue(tx, {
      issueType: 'default_recovery',
      propertyRefId: event.propertyRefId,
      summary: event.summary ?? 'Loan default received from Loan Services; opening recovery case.',
      people: event.people,
      noPeopleException: event.people && event.people.length > 0 ? undefined : 'Loan default event did not include a linked owner/contact; add when known.',
      coordinatorId: event.coordinatorId ?? null,
      queue: event.queue ?? 'new_unreviewed',
      initialTask: event.initialTask ?? {
        title: 'Initial review: loan default recovery case',
        dueDate: addDaysIso(todayIso(), 3),
        queue: event.queue ?? 'new_unreviewed',
      },
      priority: event.priority ?? 'high',
      actorId: event.actorId ?? null,
      correlationId: event.correlationId ?? randomUUID(),
    });
  });
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// =====================================================================
// reopenAsNewCycle — spec §7 "Reopened cycle"
// =====================================================================

export interface ReopenAsNewCycleInput {
  issueId: string;
  reason: string;
  /**
   * ADVERSARIAL-REVIEW FIX: required idempotency key for this reopen
   * ATTEMPT (e.g. a client-generated request id, or a stable key derived
   * from the triggering UI action) — the same key retried (network retry,
   * double form-submit) is a no-op, not a second issue_cycles row. Unlike
   * `correlationId` (which correlates rows WITHIN one occurrence),
   * `idempotencyKey` identifies the occurrence ITSELF; the caller must
   * supply a fresh one for a genuinely NEW, deliberate reopen.
   */
  idempotencyKey: string;
  nextTask?: CreateIssueTaskInput;
  actorId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

export interface ReopenAsNewCycleResult {
  issue: Issue;
  task: Task | null;
}

/**
 * Reopen a closed Issue as a new Issue Cycle: preserves all prior cycle
 * history (issue_cycles rows are additive, never overwritten) and reopens
 * the issue for active work.
 *
 * ADVERSARIAL-REVIEW FIX: unlike `openFromLoanDefault`/
 * `handleReinstatementEffective`, this command used to have no idempotency
 * protection at all — a retried/double-submitted call inserted a SECOND
 * issue_cycles row (plus a second follow-up task and audit row), and its
 * own published domain event embedded a fresh `randomUUID()` in its
 * idempotencyKey on every call, defeating domain_events' ON CONFLICT DO
 * NOTHING dedup by construction (DESIGN.md hard rule #5). Now wrapped in
 * `consumeEvent` exactly like those two commands, keyed on the caller's
 * supplied `idempotencyKey` (source_system 'property_operations.command' —
 * this is a locally-triggered command retry, not an inbound external event,
 * but consumeEvent's claim mechanism is exactly what a retry-safe command
 * needs regardless of who triggers it). Takes `db` (not `tx`) accordingly —
 * consumeEvent opens its own transaction.
 */
export async function reopenAsNewCycle(db: DbHandle, input: ReopenAsNewCycleInput): Promise<ConsumeEventResult<ReopenAsNewCycleResult>> {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new IssueValidationError(['a reason is required to reopen an issue as a new cycle']);
  }
  if (!input.idempotencyKey) {
    throw new IssueValidationError(['an idempotency key is required to reopen an issue as a new cycle']);
  }

  return consumeEvent(db, 'property_operations.command', `reopen_as_new_cycle:${input.idempotencyKey}`, async (tx) => {
    const [existing] = await tx.select().from(issues).where(eq(issues.id, input.issueId));
    if (!existing) {
      throw new IssueValidationError([`issue ${input.issueId} not found`]);
    }

    // issues_active_requires_owner_check (20260731090000_issues_core.sql)
    // rejects lifecycle_status='active' with no coordinator_id AND no
    // queue. createIssue allows an issue to have neither at intake, so a
    // reopen that unconditionally forces 'active' below could hit that
    // constraint as an unhandled 500 instead of a typed validation error
    // (adversarial-review finding). Require the caller to supply one via
    // nextTask.queue when the existing issue has neither.
    const willHaveOwner = Boolean(existing.coordinatorId) || Boolean(existing.queue) || Boolean(input.nextTask?.queue) || Boolean(input.nextTask?.assigneeId);
    if (!willHaveOwner) {
      throw new IssueValidationError([
        'reopening this issue requires a coordinator or queue: it has neither, so pass nextTask.queue (or nextTask.assigneeId) to reopen it',
      ]);
    }

    await issuesRepo.openCycle(tx, input.issueId, { reason: input.reason });

    let task: Task | null = null;
    if (input.nextTask) {
      if (!input.nextTask.assigneeId && !input.nextTask.queue) {
        throw new IssueValidationError(['the reopen follow-up task requires an assignee or a queue']);
      }
      const [created] = await tx
        .insert(tasks)
        .values({
          issueId: input.issueId,
          propertyRefId: existing.propertyRefId,
          assigneeId: input.nextTask.assigneeId ?? null,
          queue: input.nextTask.queue ?? null,
          title: input.nextTask.title,
          description: input.nextTask.description ?? null,
          dueDate: input.nextTask.dueDate,
          priority: input.nextTask.priority ?? existing.priority,
        })
        .returning();
      task = created ?? null;
    }

    const [updated] = await tx
      .update(issues)
      .set({
        lifecycleStatus: 'active',
        // Carry forward an owner/queue from the reopen follow-up task when
        // the issue itself had neither (see the willHaveOwner check
        // above) — otherwise issues_active_requires_owner_check would
        // reject this update.
        coordinatorId: existing.coordinatorId ?? input.nextTask?.assigneeId ?? null,
        queue: existing.queue ?? input.nextTask?.queue ?? null,
      })
      .where(eq(issues.id, input.issueId))
      .returning();
    if (!updated) {
      throw new Error('issue-service.reopenAsNewCycle: failed to update issue lifecycle_status');
    }

    const correlationId = input.correlationId ?? randomUUID();

    await writeAudit(tx, {
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      action: 'issue_reopened_new_cycle',
      objectTable: 'issues',
      objectId: input.issueId,
      before: { lifecycleStatus: existing.lifecycleStatus },
      after: { lifecycleStatus: updated.lifecycleStatus },
      reason: input.reason,
      correlationId,
      source: 'issue-service.reopenAsNewCycle',
    });

    await publishDomainEvent(tx, {
      eventType: 'property_operations.issue_reopened',
      payload: { issueId: input.issueId, reason: input.reason },
      issueId: input.issueId,
      propertyRefId: existing.propertyRefId,
      actor: input.actorId ?? null,
      correlationId,
      // Derived from the SAME stable idempotencyKey the caller supplied
      // (not randomUUID()) so a replay of this exact reopen occurrence
      // cannot double-publish (adversarial-review finding).
      idempotencyKey: `issue_reopened:${input.issueId}:${input.idempotencyKey}`,
    });

    return { issue: updated, task };
  });
}

// =====================================================================
// closeIssue — spec §7, and required so open_issue_phase / eligibility
// checks (spec §21, §28.3) are satisfiable at all (adversarial-review
// finding: no code path anywhere ever set lifecycle_status='closed').
// =====================================================================

export interface CloseIssueInput {
  issueId: string;
  reason: string;
  actorId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/** Close an issue: sets lifecycle_status='closed', audited. */
export async function closeIssue(tx: DbHandle, input: CloseIssueInput): Promise<Issue> {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new IssueValidationError(['a reason is required to close an issue']);
  }

  const [existing] = await tx.select().from(issues).where(eq(issues.id, input.issueId));
  if (!existing) {
    throw new IssueValidationError([`issue ${input.issueId} not found`]);
  }
  if (existing.lifecycleStatus === 'closed') {
    return existing;
  }

  const [updated] = await tx
    .update(issues)
    .set({ lifecycleStatus: 'closed' })
    .where(eq(issues.id, input.issueId))
    .returning();
  if (!updated) {
    throw new Error('issue-service.closeIssue: update returned no row');
  }

  const correlationId = input.correlationId ?? randomUUID();

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'issue_closed',
    objectTable: 'issues',
    objectId: input.issueId,
    before: { lifecycleStatus: existing.lifecycleStatus },
    after: { lifecycleStatus: updated.lifecycleStatus },
    reason: input.reason,
    correlationId,
    source: 'issue-service.closeIssue',
  });

  return updated;
}

// =====================================================================
// recordPriceReview — spec §10 (development price review window)
// =====================================================================
// ADVERSARIAL-REVIEW FIX: prior to this command, the ONLY mechanism able to
// write issues.price_reviewed_at was TransitionCtx.priceReviewedAt on
// transitionPhase, which (a) had an ordering bug making it unable to
// satisfy the very same call's own price_review_complete prerequisite/
// gates_release check (fixed separately in transition-engine.ts), and (b)
// is only reachable from WITHIN a phase transition attempt, even though
// spec §10 review is its own recordable fact/decision independent of any
// particular transition, and priceReviewBlockers (eligibility-service.ts)
// checks it per-issue across every open default_recovery/market_readiness
// issue on a property, not just whichever one is currently transitioning.
// Standalone, audited command — no domain event (same DECISION task-
// service.ts documents for its own routine commands: spec names explicit
// event types for hold apply/release, reinstatement, and issue creation,
// not for this).

export interface RecordPriceReviewInput {
  issueId: string;
  reviewedAt?: string | Date;
  actorId?: string | null;
  actorExternalId?: string | null;
  actorRole?: string | null;
  /** Roles the acting user currently holds — rechecked server-side regardless of what the UI offered (never from form data). */
  actorRoles?: string[];
  correlationId?: string | null;
}

/** Record that the development price was reviewed for `issueId` (spec §10). */
export async function recordPriceReview(tx: DbHandle, input: RecordPriceReviewInput): Promise<Issue> {
  if (!input.issueId) {
    throw new IssueValidationError(['a price review requires the issue it belongs to']);
  }

  const [existing] = await tx.select().from(issues).where(eq(issues.id, input.issueId));
  if (!existing) {
    throw new IssueValidationError([`issue ${input.issueId} not found`]);
  }

  // ADVERSARIAL-REVIEW FIX (round 2, P1 IDOR) — see issue-authz.ts's doc
  // comment.
  assertIssueAuthorized(input, 'Recording a price review');

  const reviewedAt = input.reviewedAt ? new Date(input.reviewedAt) : new Date();
  const [updated] = await tx.update(issues).set({ priceReviewedAt: reviewedAt }).where(eq(issues.id, input.issueId)).returning();
  if (!updated) {
    throw new Error('issue-service.recordPriceReview: update returned no row');
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'price_review_recorded',
    objectTable: 'issues',
    objectId: input.issueId,
    before: { priceReviewedAt: existing.priceReviewedAt },
    after: { priceReviewedAt: updated.priceReviewedAt },
    correlationId: input.correlationId ?? null,
    source: 'issue-service.recordPriceReview',
  });

  return updated;
}

// =====================================================================
// acknowledgeStale — spec §31.2
// =====================================================================

export interface AcknowledgeStaleInput {
  issueId: string;
  /** Existing stale_acknowledgments row to acknowledge; if omitted, one is created and immediately acknowledged. */
  staleAcknowledgmentId?: string;
  explanation: string;
  newTask: CreateIssueTaskInput;
  /** Free-text staff identity recorded on stale_acknowledgments.acknowledged_by (spec §31.2 "actor... remain auditable"). */
  acknowledgedBy: string;
  /** person_refs.id of the acknowledging actor, if known — recorded on the audit_events row (audit_events.actor_id is a uuid FK to person_refs). */
  actorId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/**
 * Acknowledge a stale-case prompt. Requires a status explanation AND a new
 * next task/due date (spec §31.2 — "cannot be silently dismissed").
 */
export async function acknowledgeStale(tx: DbHandle, input: AcknowledgeStaleInput): Promise<{ acknowledgment: StaleAcknowledgment; task: Task }> {
  const violations: string[] = [];
  if (!input.explanation || input.explanation.trim().length === 0) {
    violations.push('a status explanation is required');
  }
  if (!input.newTask?.title || !input.newTask?.dueDate) {
    violations.push('a new next task with a due date is required');
  } else if (input.newTask.dueDate <= todayIso()) {
    violations.push('the new next task due date must be in the future');
  }
  if (input.newTask && !input.newTask.assigneeId && !input.newTask.queue) {
    violations.push('the new next task requires an assignee or a queue');
  }
  if (!input.acknowledgedBy) {
    violations.push('an acknowledging actor is required');
  }
  if (violations.length > 0) {
    throw new IssueValidationError(violations);
  }

  const [issue] = await tx.select().from(issues).where(eq(issues.id, input.issueId));
  if (!issue) {
    throw new IssueValidationError([`issue ${input.issueId} not found`]);
  }

  const [task] = await tx
    .insert(tasks)
    .values({
      issueId: input.issueId,
      propertyRefId: issue.propertyRefId,
      assigneeId: input.newTask.assigneeId ?? null,
      queue: input.newTask.queue ?? null,
      title: input.newTask.title,
      description: input.newTask.description ?? null,
      dueDate: input.newTask.dueDate,
      priority: input.newTask.priority ?? issue.priority,
    })
    .returning();
  if (!task) {
    throw new Error('issue-service.acknowledgeStale: failed to create the new next task');
  }

  const now = new Date();
  let acknowledgment: StaleAcknowledgment | undefined;
  if (input.staleAcknowledgmentId) {
    const [updated] = await tx
      .update(staleAcknowledgments)
      .set({
        acknowledgedAt: now,
        acknowledgedBy: input.acknowledgedBy,
        statusExplanation: input.explanation,
        newNextTaskId: task.id,
        newDueDate: input.newTask.dueDate,
      })
      .where(eq(staleAcknowledgments.id, input.staleAcknowledgmentId))
      .returning();
    acknowledgment = updated;
  }
  if (!acknowledgment) {
    const [created] = await tx
      .insert(staleAcknowledgments)
      .values({
        issueId: input.issueId,
        flaggedAt: now,
        acknowledgedAt: now,
        acknowledgedBy: input.acknowledgedBy,
        statusExplanation: input.explanation,
        newNextTaskId: task.id,
        newDueDate: input.newTask.dueDate,
      })
      .returning();
    acknowledgment = created;
  }
  if (!acknowledgment) {
    throw new Error('issue-service.acknowledgeStale: failed to record acknowledgment');
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'stale_case_acknowledged',
    objectTable: 'stale_acknowledgments',
    objectId: acknowledgment.id,
    before: null,
    after: acknowledgment,
    reason: input.explanation,
    correlationId: input.correlationId ?? null,
    source: 'issue-service.acknowledgeStale',
  });

  return { acknowledgment, task };
}

// =====================================================================
// handleReinstatementEffective — spec §28.5
// =====================================================================

export interface ReinstatementEffectiveEvent {
  /** Loan Services' idempotency key for this Reinstatement Approved/Effective delivery. */
  idempotencyKey: string;
  propertyRefId: string;
  reason?: string;
  coordinatorId?: string | null;
  managerId?: string | null;
  actorId?: string | null;
  correlationId?: string | null;
}

export interface ReinstatementAffectedIssue {
  issueId: string;
  reviewPhaseInstanceId: string;
  urgentTaskId: string;
}

export type HandleReinstatementEffectiveResult =
  | { status: 'processed'; result: { affectedIssues: ReinstatementAffectedIssue[] } }
  | { status: 'skipped_duplicate' };

/**
 * React to Reinstatement Approved/Effective (spec §28.5, §28.7, §28.8).
 * Moves every open Property Operations Issue/Phase for the property into a
 * Reinstatement Review state, cancels stale pending approvals, creates an
 * urgent coordinator/manager task, and confirms an Existing Contract Active
 * hold — all while PRESERVING prior work (no cleanup/bid/cost rows are
 * deleted or altered beyond the phase-status/approval-status change).
 * Idempotent via consumeEvent (a duplicate delivery is a no-op).
 */
export async function handleReinstatementEffective(db: DbHandle, event: ReinstatementEffectiveEvent): Promise<HandleReinstatementEffectiveResult> {
  return consumeEvent(db, 'loan_services', event.idempotencyKey, async (tx) => {
    const openIssues = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.propertyRefId, event.propertyRefId), ne(issues.lifecycleStatus, 'closed')));

    const affectedIssues: ReinstatementAffectedIssue[] = [];
    const reason = event.reason ?? 'Account reinstatement approved/effective; cleanup and recovery work paused for review.';
    const correlationId = event.correlationId ?? randomUUID();

    for (const issue of openIssues) {
      const openPhases = await tx
        .select()
        .from(phaseInstances)
        .where(and(eq(phaseInstances.issueId, issue.id), ne(phaseInstances.status, 'completed'), ne(phaseInstances.status, 'cancelled'), ne(phaseInstances.status, 'skipped')));

      for (const phase of openPhases) {
        await tx
          .update(phaseInstances)
          .set({ status: 'blocked', endedAt: new Date(), exitOutcome: 'reinstatement_effective' })
          .where(eq(phaseInstances.id, phase.id));
      }

      const [reviewPhase] = await tx
        .insert(phaseInstances)
        .values({
          issueId: issue.id,
          phaseKey: 'reinstatement_review',
          status: 'open',
          startedAt: new Date(),
          entryReason: reason,
          ownerId: issue.coordinatorId,
          queue: issue.queue,
        })
        .returning();
      if (!reviewPhase) {
        throw new Error('issue-service.handleReinstatementEffective: failed to open reinstatement_review phase');
      }

      await tx
        .update(issues)
        .set({ currentPhaseInstanceId: reviewPhase.id, lifecycleStatus: 'blocked' })
        .where(eq(issues.id, issue.id));

      // Cancel stale pending approvals for this issue (spec §28.7: reinstatement invalidates a stale pending release/listing/new-contract approval).
      const withdrawnApprovals = await tx
        .update(approvals)
        .set({ decision: 'withdrawn', decisionReason: 'Cancelled: account reinstatement effective', decidedAt: new Date() })
        .where(and(eq(approvals.objectTable, 'issues'), eq(approvals.objectId, issue.id), eq(approvals.decision, 'pending')))
        .returning();

      // Each withdrawn approval is its own audited state change (a decision
      // on an approval record) — previously only the issue-level audit row
      // below existed, so the approval withdrawal itself left no trace
      // (adversarial-review finding).
      for (const withdrawn of withdrawnApprovals) {
        await writeAudit(tx, {
          actorId: event.actorId ?? null,
          actorRole: null,
          action: 'approval_withdrawn',
          objectTable: 'approvals',
          objectId: withdrawn.id,
          before: { decision: 'pending' },
          after: { decision: withdrawn.decision, decisionReason: withdrawn.decisionReason },
          reason: reason,
          correlationId,
          source: 'issue-service.handleReinstatementEffective',
        });
      }

      const [urgentTask] = await tx
        .insert(tasks)
        .values({
          issueId: issue.id,
          phaseInstanceId: reviewPhase.id,
          propertyRefId: event.propertyRefId,
          assigneeId: issue.coordinatorId ?? event.coordinatorId ?? null,
          queue: issue.coordinatorId ? null : (issue.queue ?? 'waiting_blocked'),
          title: 'Reinstatement effective — review paused cleanup/recovery work',
          description: reason,
          status: 'open',
          priority: 'urgent',
          dueDate: addDaysIso(todayIso(), 1),
        })
        .returning();
      if (!urgentTask) {
        throw new Error('issue-service.handleReinstatementEffective: failed to create urgent review task');
      }

      await writeAudit(tx, {
        actorId: event.actorId ?? null,
        actorRole: null,
        action: 'reinstatement_effective_applied',
        objectTable: 'issues',
        objectId: issue.id,
        before: { lifecycleStatus: issue.lifecycleStatus },
        after: { lifecycleStatus: 'blocked', phaseKey: 'reinstatement_review' },
        reason,
        correlationId,
        source: 'issue-service.handleReinstatementEffective',
      });

      await publishDomainEvent(tx, {
        eventType: 'property_operations.reinstatement_review_started',
        payload: { issueId: issue.id, propertyRefId: event.propertyRefId },
        issueId: issue.id,
        propertyRefId: event.propertyRefId,
        actor: event.actorId ?? null,
        correlationId,
        idempotencyKey: `reinstatement_review_started:${issue.id}:${event.idempotencyKey}`,
      });

      affectedIssues.push({ issueId: issue.id, reviewPhaseInstanceId: reviewPhase.id, urgentTaskId: urgentTask.id });
    }

    // Confirm/create the Existing Contract Active restriction (spec §28.5), unless one is already active.
    const activeHolds = await tx
      .select()
      .from(holds)
      .where(and(eq(holds.propertyRefId, event.propertyRefId), eq(holds.holdType, 'existing_contract_active')));
    const alreadyActive = activeHolds.some((h) => !h.releasedAt);
    if (!alreadyActive) {
      await applyHold(tx, {
        propertyRefId: event.propertyRefId,
        holdType: 'existing_contract_active',
        reason,
        source: 'loan_services.reinstatement_effective',
        ownerId: event.coordinatorId ?? null,
        releaseCriteria: 'Account/contract terminates through an authorized Loan Services workflow.',
        actorId: event.actorId ?? null,
        correlationId,
      });
    }

    return { affectedIssues };
  });
}
