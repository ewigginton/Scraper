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

import { and, asc, eq, isNotNull, lte, gt, or } from 'drizzle-orm';
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

/**
 * Bounded default page size for every work-screen queue (adversarial-review
 * finding: none of the seven queue queries applied any LIMIT at all, so an
 * active company's overdue/waitingBlocked buckets would return and render
 * every matching row, unbounded, on every load). A real "N more" affordance
 * with cursor pagination is a larger UI change (spec §25); this bound at
 * least keeps a single work-screen load's query cost and render size
 * constant as task volume grows, which is the safety property that matters
 * most (a runaway query/render is worse than an incomplete-looking list).
 */
const DEFAULT_QUEUE_LIMIT = 200;

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
  /** Max rows returned per queue. Default DEFAULT_QUEUE_LIMIT; overridable for tests. */
  queueLimit?: number;
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
 * ADVERSARIAL-REVIEW FIX: same shape as `ownerFilter` above, but scoped to
 * the parent ISSUE's coordinator_id/queue rather than a task's own
 * assignee_id/queue — notices have no per-row assignee/queue of their own,
 * so "the caller's owner filter via the parent issue" (this module's own
 * doc comment for noticesDue, which the code never actually implemented)
 * has to key off the joined issue instead.
 */
function issueOwnerFilter(params: InboxForUserParams) {
  const predicates = [];
  if (params.assigneeId) {
    predicates.push(eq(issues.coordinatorId, params.assigneeId));
  }
  if (params.queues && params.queues.length > 0) {
    predicates.push(or(...params.queues.map((q) => eq(issues.queue, q))));
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
 *   cure_deadline, scoped to the caller's owner filter via the parent issue
 *   (adversarial-review fix: this used to have NO owner scoping at all —
 *   see the join below).
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
  const issueOwner = issueOwnerFilter(params);
  const openStatuses = or(eq(tasks.status, 'open'), eq(tasks.status, 'in_progress'));
  const limit = params.queueLimit ?? DEFAULT_QUEUE_LIMIT;

  const withOwner = (...predicates: Array<ReturnType<typeof eq> | undefined>) => {
    const all = [...predicates, owner].filter((p): p is NonNullable<typeof p> => p !== undefined);
    return all.length > 0 ? and(...all) : undefined;
  };

  const noticesWhere = (() => {
    const statusPredicate = or(eq(notices.status, 'pending'), eq(notices.status, 'sent'));
    return issueOwner ? and(statusPredicate, issueOwner) : statusPredicate;
  })();

  // ADVERSARIAL-REVIEW FIX (round 2, P2): none of the seven queries below
  // had an ORDER BY at all — the earlier fix that added `.limit(limit)`
  // stopped these queries from being unbounded, but with no ORDER BY,
  // Postgres returns rows in an UNSPECIFIED order, so WHICH `limit` rows
  // survive a query that matches more than `limit` rows is
  // planner-dependent and can silently change between page loads (e.g. the
  // oldest, most-escalated overdue tasks are exactly as likely to be
  // dropped as the newest). A deterministic ORDER BY makes the truncation
  // itself deterministic (always the same "first N" by a documented
  // ordering) even though it does not, on its own, surface a "showing N of
  // M" signal to the caller (see this fix's doc comment for that
  // documented follow-up).
  const [newUnreviewed, actionDateFollowups, upcoming, overdue, waitingBlocked, noticesDue, pendingApprovals] =
    await Promise.all([
      db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(issues, eq(tasks.issueId, issues.id))
        .where(withOwner(eq(tasks.status, 'open'), eq(issues.lifecycleStatus, 'intake')))
        .orderBy(asc(tasks.dueDate), asc(tasks.priority), asc(tasks.id))
        .limit(limit)
        .then((rows) => rows.map((r) => r.task)),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, isNotNull(tasks.actionDate), lte(tasks.actionDate, today)))
        .orderBy(asc(tasks.dueDate), asc(tasks.priority), asc(tasks.id))
        .limit(limit),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, isNotNull(tasks.dueDate), gt(tasks.dueDate, today), lte(tasks.dueDate, upcomingUntil)))
        .orderBy(asc(tasks.dueDate), asc(tasks.priority), asc(tasks.id))
        .limit(limit),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, isNotNull(tasks.dueDate), lte(tasks.dueDate, today)))
        .orderBy(asc(tasks.dueDate), asc(tasks.priority), asc(tasks.id))
        .limit(limit),
      db
        .select()
        .from(tasks)
        .where(withOwner(openStatuses, or(isNotNull(tasks.waitingReason), isNotNull(tasks.waitingParty))))
        .orderBy(asc(tasks.dueDate), asc(tasks.priority), asc(tasks.id))
        .limit(limit),
      db
        .select({ notice: notices })
        .from(notices)
        // ADVERSARIAL-REVIEW FIX: this used to have NO join to issues and NO
        // owner scoping at all, so every caller's "Letters / Notices Due"
        // queue showed every pending/sent notice company-wide, contradicting
        // this module's own doc comment.
        .innerJoin(issues, eq(notices.issueId, issues.id))
        .where(noticesWhere)
        .orderBy(asc(notices.cureDeadline), asc(notices.id))
        .limit(limit)
        .then((rows) => rows.map((r) => r.notice)),
      params.approverPersonRefId
        ? db
            .select()
            .from(approvals)
            .where(and(eq(approvals.decision, 'pending'), eq(approvals.approverId, params.approverPersonRefId)))
            .orderBy(asc(approvals.createdAt), asc(approvals.id))
            .limit(limit)
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
