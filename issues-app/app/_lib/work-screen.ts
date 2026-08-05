/**
 * app/_lib/work-screen.ts — builds the personal work screen's seven queues
 * (spec §8.1, "My Work at volume") into one uniform row shape the table can
 * render. The queue membership queries themselves live in
 * lib/repositories/tasks-repo.ts (`inboxForUser` for the capped rows,
 * `countsForUser` for the real per-queue totals behind the count chips).
 *
 * ADVERSARIAL-REVIEW FOLLOW-UP (Issues UI v2, scale foundation): the raw
 * issues/phase_instances/property_refs id-batch reads that used to live
 * directly in this module's buildJoinContext now go through
 * lib/repositories/issues-repo.ts, lib/repositories/phase-instances-repo.ts,
 * and lib/repositories/reference-data-repo.ts — closing the architectural
 * gap this module's previous doc comment flagged ("this join belongs in
 * lib/repositories/ long-term; lib/repositories/ is outside this lane's
 * assigned paths").
 */

import type { DbHandle } from '../../lib/repositories/db-handle.ts';
import * as issuesRepo from '../../lib/repositories/issues-repo.ts';
import * as phaseInstancesRepo from '../../lib/repositories/phase-instances-repo.ts';
import * as referenceDataRepo from '../../lib/repositories/reference-data-repo.ts';
import * as tasksRepo from '../../lib/repositories/tasks-repo.ts';
import {
  type Approval,
  type Issue,
  type Notice,
  type PhaseInstance,
  type PropertyRef,
  type Task,
} from '../../lib/db/schema.ts';

export type WorkQueueKey =
  | 'newUnreviewed'
  | 'actionDateFollowups'
  | 'noticesDue'
  | 'upcoming'
  | 'overdue'
  | 'waitingBlocked'
  | 'approvals';

export const WORK_QUEUE_LABELS: Record<WorkQueueKey, string> = {
  newUnreviewed: 'New / Unreviewed Issues',
  actionDateFollowups: 'Communications from Action Dates',
  noticesDue: 'Letters / Notices Due',
  upcoming: 'Upcoming Deadlines',
  overdue: 'Overdue Tasks',
  waitingBlocked: 'Waiting / Blocked',
  approvals: 'Approvals',
};

export interface WorkRow {
  key: string;
  kind: 'task' | 'notice' | 'approval';
  taskId: string | null;
  issueId: string | null;
  propertyLabel: string;
  state: string | null;
  issueType: string | null;
  stage: string | null;
  taskLabel: string;
  dueDate: string | null;
  priority: string | null;
  /** A real staff identity string (task.assigneeId) — displayed as-is, never humanized (it isn't a snake_case enum). */
  assignee: string | null;
  /** Set ONLY when there's no individual assignee and the row falls back to its queue key (e.g. 'new_unreviewed') — the renderer humanizes this, unlike `assignee`, which is an opaque identity string, not a label. */
  assigneeQueue: string | null;
  summary: string | null;
  canComplete: boolean;
  canReschedule: boolean;
}

interface JoinContext {
  issueById: Map<string, Issue>;
  phaseById: Map<string, PhaseInstance>;
  propertyById: Map<string, PropertyRef>;
}

async function buildJoinContext(db: DbHandle, seedIssueIds: Array<string | null | undefined>): Promise<JoinContext> {
  const issueIds = Array.from(new Set(seedIssueIds.filter((v): v is string => Boolean(v))));
  const issueRows = await issuesRepo.getManyByIds(db, issueIds);
  const issueById = new Map(issueRows.map((row) => [row.id, row]));

  const phaseIds = Array.from(
    new Set(issueRows.map((row) => row.currentPhaseInstanceId).filter((v): v is string => Boolean(v))),
  );
  const phaseRows = await phaseInstancesRepo.getManyByIds(db, phaseIds);
  const phaseById = new Map(phaseRows.map((row) => [row.id, row]));

  const propertyIds = Array.from(new Set(issueRows.map((row) => row.propertyRefId).filter(Boolean)));
  const propertyRows = await referenceDataRepo.getPropertiesByIds(db, propertyIds);
  const propertyById = new Map(propertyRows.map((row) => [row.id, row]));

  return { issueById, phaseById, propertyById };
}

function propertyDisplay(property: PropertyRef | undefined): { label: string; state: string | null } {
  if (!property) return { label: 'No linked property', state: null };
  const label = property.displayName ?? [property.development, property.tract].filter(Boolean).join(' / ') ?? property.id;
  return { label: label || property.id, state: property.state ?? null };
}

function taskToRow(task: Task, ctx: JoinContext): WorkRow {
  const issue = task.issueId ? ctx.issueById.get(task.issueId) : undefined;
  const propertyId = task.propertyRefId ?? issue?.propertyRefId;
  const property = propertyId ? ctx.propertyById.get(propertyId) : undefined;
  const phase = issue?.currentPhaseInstanceId ? ctx.phaseById.get(issue.currentPhaseInstanceId) : undefined;
  const { label, state } = propertyDisplay(property);

  return {
    key: `task:${task.id}`,
    kind: 'task',
    taskId: task.id,
    issueId: issue?.id ?? null,
    propertyLabel: label,
    state,
    issueType: issue?.issueType ?? null,
    stage: phase?.phaseKey ?? null,
    taskLabel: task.title,
    dueDate: task.dueDate,
    priority: task.priority,
    assignee: task.assigneeId ?? null,
    assigneeQueue: task.assigneeId ? null : (task.queue ?? null),
    summary: task.description ?? issue?.summary ?? null,
    canComplete: task.status === 'open' || task.status === 'in_progress',
    canReschedule: task.status === 'open' || task.status === 'in_progress',
  };
}

function noticeToRow(notice: Notice, ctx: JoinContext): WorkRow {
  const issue = ctx.issueById.get(notice.issueId);
  const property = issue?.propertyRefId ? ctx.propertyById.get(issue.propertyRefId) : undefined;
  const { label, state } = propertyDisplay(property);

  return {
    key: `notice:${notice.id}`,
    kind: 'notice',
    taskId: null,
    issueId: notice.issueId,
    propertyLabel: label,
    state,
    issueType: issue?.issueType ?? null,
    stage: `Notice: ${notice.status}`,
    taskLabel: `Send/confirm ${notice.templateVersion} notice`,
    dueDate: notice.cureDeadline,
    priority: null,
    assignee: null,
    assigneeQueue: null,
    summary: issue?.summary ?? null,
    canComplete: false,
    canReschedule: false,
  };
}

function approvalToRow(approval: Approval, ctx: JoinContext): WorkRow {
  const issue = approval.objectTable === 'issues' ? ctx.issueById.get(approval.objectId) : undefined;
  const property = issue?.propertyRefId ? ctx.propertyById.get(issue.propertyRefId) : undefined;
  const { label, state } = propertyDisplay(property);

  return {
    key: `approval:${approval.id}`,
    kind: 'approval',
    taskId: null,
    issueId: issue?.id ?? null,
    propertyLabel: label,
    state,
    issueType: issue?.issueType ?? null,
    stage: 'Approval pending',
    taskLabel: approval.requestedAction,
    dueDate: null,
    priority: null,
    assignee: null,
    assigneeQueue: null,
    summary: approval.thresholdRule ?? issue?.summary ?? null,
    canComplete: false,
    canReschedule: false,
  };
}

export interface WorkScreenData {
  queues: Record<WorkQueueKey, WorkRow[]>;
  /**
   * Real per-queue totals (spec "My Work at volume": each queue shows the
   * first N rows with per-queue COUNTS, distinct from `queues[key].length`
   * once a queue is capped below its true size).
   */
  counts: tasksRepo.QueueCounts;
}

export async function buildWorkScreen(db: DbHandle, params: tasksRepo.InboxForUserParams): Promise<WorkScreenData> {
  const [inbox, counts] = await Promise.all([tasksRepo.inboxForUser(db, params), tasksRepo.countsForUser(db, params)]);

  const allTasks = [
    ...inbox.newUnreviewed,
    ...inbox.actionDateFollowups,
    ...inbox.upcoming,
    ...inbox.overdue,
    ...inbox.waitingBlocked,
  ];
  const seedIssueIds = [
    ...allTasks.map((t) => t.issueId),
    ...inbox.noticesDue.map((n) => n.issueId),
    ...inbox.approvals.filter((a) => a.objectTable === 'issues').map((a) => a.objectId),
  ];
  const ctx = await buildJoinContext(db, seedIssueIds);

  return {
    queues: {
      newUnreviewed: inbox.newUnreviewed.map((t) => taskToRow(t, ctx)),
      actionDateFollowups: inbox.actionDateFollowups.map((t) => taskToRow(t, ctx)),
      noticesDue: inbox.noticesDue.map((n) => noticeToRow(n, ctx)),
      upcoming: inbox.upcoming.map((t) => taskToRow(t, ctx)),
      overdue: inbox.overdue.map((t) => taskToRow(t, ctx)),
      waitingBlocked: inbox.waitingBlocked.map((t) => taskToRow(t, ctx)),
      approvals: inbox.approvals.map((a) => approvalToRow(a, ctx)),
    },
    counts,
  };
}
