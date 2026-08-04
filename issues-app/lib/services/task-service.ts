/**
 * task-service.ts — task lifecycle commands (spec §7, §8.1, DESIGN.md §6).
 * Query/grouping logic (the personal work screen inbox) already lives in
 * lib/repositories/tasks-repo.ts; this module is the write side: completing,
 * rescheduling, and spawning follow-up tasks, each audited per command.
 *
 * DECISION: spec §7/§8.1 do not name specific domain event types for
 * routine task actions (unlike hold apply/release, reinstatement, and issue
 * creation, which the spec explicitly names events for). To avoid
 * inventing undocumented event types, these commands audit but do not
 * publish domain events.
 */

import { eq } from 'drizzle-orm';
import type { DbHandle } from '../repositories/db-handle.ts';
import * as tasksRepo from '../repositories/tasks-repo.ts';
import { tasks, type NewTask, type Priority, type Task } from '../db/schema.ts';
import { writeAudit } from './audit.ts';

export class TaskServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskServiceError';
    this.code = code;
  }
}

/**
 * ADVERSARIAL-REVIEW FIX (P1 IDOR): completeTask/rescheduleTask used to act
 * on whatever taskId the caller supplied with no ownership or role check at
 * all — the read side (tasks-repo.ts's inboxForUser) is correctly scoped to
 * the caller's assignment/queue, but that scoping is presentation only
 * (requirements line 378: the server must independently recheck permission,
 * never rely on "the UI only offered my own tasks"). Any authenticated
 * caller could complete/reschedule ANY other user's task — including a
 * release-gating verification task — by supplying its uuid directly.
 * `actorRoles`/`actorQueues` let the caller either own the task directly
 * (assignee match) or cover its queue, and manager/admin may override
 * regardless (recorded via `overrodeOwnership` on the audit row so the
 * override is visible in History, not silently indistinguishable from a
 * normal own-task completion).
 *
 * ROUND-3 ADVERSARIAL-REVIEW FIX (P2): the round-2 `isOwner || isCoveredQueue
 * || canOverride` OR gave queue coverage EQUAL precedence to an explicit
 * named assignment, so a task with both assignee_id='alice' and
 * queue='new_unreviewed' set was completable by any other coordinator
 * covering that queue, recorded as overrodeOwnership:false — indistinguishable
 * from Alice completing her own task. That made an explicit assignment
 * WEAKER than no assignment at all (a queue-only task at least records
 * `basis:'queue'`; a named-but-mismatched one recorded nothing).
 *
 * Fix: a named assignee now outranks queue coverage. If the task has an
 * assignee_id and the caller isn't it, ONLY a manager/admin role override
 * may act on it — queue coverage no longer silently substitutes for a
 * mismatched named assignment. The caller also gets the actual `basis` of
 * authorization back (not just a boolean) so audit rows can distinguish
 * "queue coverage" from "role override" rather than collapsing both into
 * one flag.
 */
function assertTaskAuthorized(
  existing: Task,
  input: { actorExternalId?: string | null; actorQueues?: string[]; actorRoles?: string[] },
): { overrodeOwnership: boolean; basis: 'owner' | 'queue' | 'role_override' } {
  const isOwner = Boolean(existing.assigneeId) && existing.assigneeId === input.actorExternalId;
  if (isOwner) {
    return { overrodeOwnership: false, basis: 'owner' };
  }

  const canOverride = (input.actorRoles ?? []).some((r) => r === 'manager' || r === 'admin');

  if (existing.assigneeId) {
    // Assigned to someone else by name: queue coverage does not apply here
    // regardless of the task's queue field — only an explicit role override
    // may act on someone else's named assignment.
    if (!canOverride) {
      throw new TaskServiceError('task_not_authorized', 'This task is assigned to someone else.');
    }
    return { overrodeOwnership: true, basis: 'role_override' };
  }

  const isCoveredQueue = Boolean(existing.queue) && (input.actorQueues ?? []).includes(existing.queue as string);
  if (isCoveredQueue) {
    return { overrodeOwnership: false, basis: 'queue' };
  }
  if (canOverride) {
    return { overrodeOwnership: true, basis: 'role_override' };
  }
  throw new TaskServiceError('task_not_authorized', 'This task is assigned to someone else.');
}

export interface CompleteTaskInput {
  taskId: string;
  /** Optional link to the evidence proving completion (spec §20 Task "completion evidence"). */
  completionEvidenceId?: string | null;
  verifiedCompletionDate?: string;
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  /** Roles the acting user currently holds — rechecked server-side regardless of what the UI offered (never from form data). */
  actorRoles?: string[];
  /** Queue names the actor's role covers, in addition to direct assignment. */
  actorQueues?: string[];
  correlationId?: string | null;
}

/** Complete a task. Verified completion date is CCL confirming resolution — never inferred from a promise (spec §7). */
export async function completeTask(tx: DbHandle, input: CompleteTaskInput): Promise<Task> {
  const [existing] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId));
  if (!existing) {
    throw new TaskServiceError('task_not_found', `Task ${input.taskId} not found.`);
  }
  const { overrodeOwnership, basis } = assertTaskAuthorized(existing, input);

  const verifiedCompletionDate = input.verifiedCompletionDate ?? new Date().toISOString().slice(0, 10);
  const [updated] = await tx
    .update(tasks)
    .set({
      status: 'completed',
      verifiedCompletionDate,
      completionEvidenceId: input.completionEvidenceId ?? existing.completionEvidenceId,
    })
    .where(eq(tasks.id, input.taskId))
    .returning();
  if (!updated) {
    throw new Error('task-service.completeTask: update returned no row');
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'task_completed',
    objectTable: 'tasks',
    objectId: updated.id,
    before: existing,
    // ROUND-3 FIX (P2): stamp the actual authorization basis whenever it
    // isn't a plain own-task completion, so History can distinguish
    // "completed via queue coverage" from "completed via manager/admin
    // override" instead of collapsing both into one overrodeOwnership flag.
    after: basis === 'owner' ? updated : { ...updated, overrodeOwnership, authorizationBasis: basis },
    correlationId: input.correlationId ?? null,
    source: 'task-service.completeTask',
  });

  return updated;
}

export interface RescheduleTaskInput {
  taskId: string;
  newDueDate: string;
  reason?: string | null;
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  /** Roles the acting user currently holds — rechecked server-side regardless of what the UI offered (never from form data). */
  actorRoles?: string[];
  /** Queue names the actor's role covers, in addition to direct assignment. */
  actorQueues?: string[];
  correlationId?: string | null;
}

/** Reschedule a task's due date. Audited (spec §29.2: all edits/status changes retain audit history). */
export async function rescheduleTask(tx: DbHandle, input: RescheduleTaskInput): Promise<Task> {
  if (!input.newDueDate) {
    throw new TaskServiceError('due_date_required', 'A new due date is required to reschedule a task.');
  }

  const [existing] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId));
  if (!existing) {
    throw new TaskServiceError('task_not_found', `Task ${input.taskId} not found.`);
  }
  const { overrodeOwnership, basis } = assertTaskAuthorized(existing, input);

  const updated = await tasksRepo.reschedule(tx, input.taskId, input.newDueDate);
  if (!updated) {
    throw new Error('task-service.rescheduleTask: update returned no row');
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'task_rescheduled',
    objectTable: 'tasks',
    objectId: updated.id,
    before: { dueDate: existing.dueDate },
    after:
      basis === 'owner'
        ? { dueDate: updated.dueDate }
        : { dueDate: updated.dueDate, overrodeOwnership, authorizationBasis: basis },
    reason: input.reason ?? null,
    correlationId: input.correlationId ?? null,
    source: 'task-service.rescheduleTask',
  });

  return updated;
}

export interface CreateFollowUpInput {
  issueId?: string | null;
  issueCycleId?: string | null;
  phaseInstanceId?: string | null;
  propertyRefId?: string | null;
  personRefId?: string | null;
  title: string;
  description?: string | null;
  dueDate: string;
  assigneeId?: string | null;
  queue?: string | null;
  priority?: Priority;
  sourceRule?: string | null;
  waitingReason?: string | null;
  waitingParty?: string | null;
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/** Create a follow-up task (e.g. an action-date reminder, a waiting/blocked follow-up — spec §7). Audited. */
export async function createFollowUp(tx: DbHandle, input: CreateFollowUpInput): Promise<Task> {
  const violations: string[] = [];
  if (!input.title || input.title.trim().length === 0) {
    violations.push('a task title is required');
  }
  if (!input.dueDate) {
    violations.push('a due date is required');
  }
  if (!input.assigneeId && !input.queue) {
    violations.push('an assignee or a queue is required');
  }
  if (violations.length > 0) {
    throw new TaskServiceError('follow_up_validation_failed', violations.join('; '));
  }

  const values: NewTask = {
    issueId: input.issueId ?? null,
    issueCycleId: input.issueCycleId ?? null,
    phaseInstanceId: input.phaseInstanceId ?? null,
    propertyRefId: input.propertyRefId ?? null,
    personRefId: input.personRefId ?? null,
    assigneeId: input.assigneeId ?? null,
    queue: input.queue ?? null,
    title: input.title,
    description: input.description ?? null,
    dueDate: input.dueDate,
    priority: input.priority ?? 'normal',
    sourceRule: input.sourceRule ?? null,
    waitingReason: input.waitingReason ?? null,
    waitingParty: input.waitingParty ?? null,
  };

  const [created] = await tx.insert(tasks).values(values).returning();
  if (!created) {
    throw new Error('task-service.createFollowUp: insert returned no row');
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'task_follow_up_created',
    objectTable: 'tasks',
    objectId: created.id,
    before: null,
    after: created,
    correlationId: input.correlationId ?? null,
    source: 'task-service.createFollowUp',
  });

  return created;
}
