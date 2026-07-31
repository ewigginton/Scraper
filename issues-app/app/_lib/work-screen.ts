/**
 * app/_lib/work-screen.ts — builds the personal work screen's seven queues
 * (spec §8.1) into one uniform row shape the table can render. The queue
 * membership queries themselves already live in
 * lib/repositories/tasks-repo.ts (`inboxForUser`); this module only joins in
 * the display fields (property/state, issue type, current stage, summary)
 * that tasks/notices/approvals rows don't carry directly, since no
 * repository currently exposes that join. Documented gap: this join belongs
 * in lib/repositories/ long-term; lib/repositories/ is outside this lane's
 * assigned paths.
 */

import { inArray } from 'drizzle-orm';
import type { DbHandle } from '../../lib/repositories/db-handle.ts';
import * as tasksRepo from '../../lib/repositories/tasks-repo.ts';
import {
  issues,
  phaseInstances,
  propertyRefs,
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
  assignee: string | null;
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
  const issueRows = issueIds.length > 0 ? await db.select().from(issues).where(inArray(issues.id, issueIds)) : [];
  const issueById = new Map(issueRows.map((row) => [row.id, row]));

  const phaseIds = Array.from(
    new Set(issueRows.map((row) => row.currentPhaseInstanceId).filter((v): v is string => Boolean(v))),
  );
  const phaseRows = phaseIds.length > 0 ? await db.select().from(phaseInstances).where(inArray(phaseInstances.id, phaseIds)) : [];
  const phaseById = new Map(phaseRows.map((row) => [row.id, row]));

  const propertyIds = Array.from(new Set(issueRows.map((row) => row.propertyRefId).filter(Boolean)));
  const propertyRows = propertyIds.length > 0 ? await db.select().from(propertyRefs).where(inArray(propertyRefs.id, propertyIds)) : [];
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
    assignee: task.assigneeId ?? task.queue ?? null,
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
    summary: approval.thresholdRule ?? issue?.summary ?? null,
    canComplete: false,
    canReschedule: false,
  };
}

export interface WorkScreenData {
  queues: Record<WorkQueueKey, WorkRow[]>;
}

export async function buildWorkScreen(db: DbHandle, params: tasksRepo.InboxForUserParams): Promise<WorkScreenData> {
  const inbox = await tasksRepo.inboxForUser(db, params);

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
  };
}
