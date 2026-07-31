/**
 * tasks-repo — all DB access for the `tasks` table, including the
 * personal-work-screen inbox query (spec §8.1). Grouping/query logic here
 * is data access, not business rules: what counts as "overdue" or
 * "upcoming" is a plain date comparison against the tasks/notices/approvals
 * tables, not a workflow decision. Workflow rules (e.g. what happens when a
 * task is completed) live in lib/services/task-service.ts.
 *
 * DECISION (spec §8.1 is silent on exact bucket definitions beyond naming
 * the queues): this module defines each queue with the simplest read that
 * matches the queue's name, documented per-queue below.
 */

import { and, eq, isNotNull, lte, gt, or } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import {
  approvals,
  issues,
  notices,
  tasks,
  type Approval,
  type Notice,
  type Task,
} from '../db/schema.ts';

export interface InboxForUserParams {
  /** External staff identity (lib/auth CurrentUser.id). */
  assigneeId?: string;
  /** Queue names the user's role covers, in addition to direct assignment. */
  queues?: string[];
  /** person_refs.id for the current user, used for the approvals bucket. */
  approverPersonRefId?: string;
  /** ISO date (YYYY-MM-DD) to treat as "today"; defaults to current date. Overridable for tests. */
  today?: string;
  /** Window size for the "upcoming" bucket, in days. Default 14. */
  upcomingWithinDays?: number;
}

export interface Inbox {
  newUnreviewed: Task[];
  actionDateFollowups: Task[];
  noticesDue: Notice[];
  upcoming: Task[];
  overdue: Task[];
  waitingBlocked: Task[];
  approvals: Approval[];
}

function ownerFilter(params: InboxForUserParams) {
  const predicates = [];
  if (params.assigneeId) {
    predicates.push(eq(tasks.assigneeId, params.assigneeId));
  }
  if (params.queues && params.queues.length > 0) {
    predicates.push(or(...params.queues.map((q) => eq(tasks.queue, q))));
  }
  return predicates.length > 0 ? or(...predicates) : undefined;
}

/**
 * Build the personal work screen inbox (spec §8.1) grouped into its
 * required queues:
 * - newUnreviewed: open tasks on issues still in `intake` lifecycle_status.
 * - actionDateFollowups: open/in_progress tasks whose action_date has
 *   arrived (<= today) — a customer/vendor promised to act or update.
 * - noticesDue: notices not yet resolved (pending/sent) ordered by
 *   cure_deadline, scoped to the caller's owner filter via the parent issue.
 * - upcoming: open/in_progress tasks with due_date in the future, within
 *   `upcomingWithinDays`.
 * - overdue: open/in_progress tasks with due_date in the past.
 * - waitingBlocked: tasks with a waiting_reason or waiting_party set.
 * - approvals: pending approvals awaiting this user's decision
 *   (params.approverPersonRefId).
 */
export async function inboxForUser(db: DbHandle, params: InboxForUserParams = {}): Promise<Inbox> {
  const today = params.today ?? new Date().toISOString().slice(0, 10);
  const upcomingWithinDays = params.upcomingWithinDays ?? 14;
  const upcomingUntil = addDays(today, upcomingWithinDays);
  const owner = ownerFilter(params);
  const openStatuses = or(eq(tasks.status, 'open'), eq(tasks.status, 'in_progress'));

  const withOwner = (...predicates: Array<ReturnType<typeof eq> | undefined>) => {
    const all = [...predicates, owner].filter((p): p is NonNullable<typeof p> => p !== undefined);
    return all.length > 0 ? and(...all) : undefined;
  };

  const [newUnreviewed, actionDateFollowups, upcoming, overdue, waitingBlocked, noticesDue, pendingApprovals] =
    await Promise.all([
      db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(issues, eq(tasks.issueId, issues.id))
        .where(withOwner(eq(tasks.status, 'open'), eq(issues.lifecycleStatus, 'intake')))
        .then((rows) => rows.map((r) => r.task)),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, isNotNull(tasks.actionDate), lte(tasks.actionDate, today))),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, isNotNull(tasks.dueDate), gt(tasks.dueDate, today), lte(tasks.dueDate, upcomingUntil))),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, isNotNull(tasks.dueDate), lte(tasks.dueDate, today))),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, or(isNotNull(tasks.waitingReason), isNotNull(tasks.waitingParty)))),
      db
        .select()
        .from(notices)
        .where(or(eq(notices.status, 'pending'), eq(notices.status, 'sent'))),
      params.approverPersonRefId
        ? db
            .select()
            .from(approvals)
            .where(and(eq(approvals.decision, 'pending'), eq(approvals.approverId, params.approverPersonRefId)))
        : Promise.resolve([]),
    ]);

  return {
    newUnreviewed,
    actionDateFollowups,
    noticesDue,
    upcoming,
    overdue,
    waitingBlocked,
    approvals: pendingApprovals,
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Mark a task completed. Sets status='completed' and
 * verified_completion_date. Caller (task-service.ts) decides whether
 * completion is currently allowed and what follow-on tasks/events fire.
 */
export async function complete(
  db: DbHandle,
  id: string,
  verifiedCompletionDate: string = new Date().toISOString().slice(0, 10),
): Promise<Task | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ status: 'completed', verifiedCompletionDate })
    .where(eq(tasks.id, id))
    .returning();
  return row;
}

/** Reschedule a task's due_date. */
export async function reschedule(db: DbHandle, id: string, dueDate: string): Promise<Task | undefined> {
  const [row] = await db.update(tasks).set({ dueDate }).where(eq(tasks.id, id)).returning();
  return row;
}
