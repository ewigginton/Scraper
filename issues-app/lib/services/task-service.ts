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

export interface CompleteTaskInput {
  taskId: string;
  /** Optional link to the evidence proving completion (spec §20 Task "completion evidence"). */
  completionEvidenceId?: string | null;
  verifiedCompletionDate?: string;
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/** Complete a task. Verified completion date is CCL confirming resolution — never inferred from a promise (spec §7). */
export async function completeTask(tx: DbHandle, input: CompleteTaskInput): Promise<Task> {
  const [existing] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId));
  if (!existing) {
    throw new TaskServiceError('task_not_found', `Task ${input.taskId} not found.`);
  }

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
    after: updated,
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
    after: { dueDate: updated.dueDate },
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
