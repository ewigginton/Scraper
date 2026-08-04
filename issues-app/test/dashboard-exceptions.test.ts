/**
 * dashboard-exceptions.test.ts — coverage for lib/repositories/dashboard-repo.ts
 * (§8.2 General Issues dashboard aggregates) and lib/repositories/exceptions-repo.ts
 * (§13 data-quality/exception queues), against a small seeded PGlite fixture.
 * Every aggregate is checked against a hand-counted expectation, and every
 * bounded (limit-capped) query is checked to actually respect its limit
 * while still reporting the true total count.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activeHoldPropertyCount,
  activeHoldPropertyCountsByType,
  agingBucketsOfOpenIssues,
  issuesByLifecycleStatus,
  openIssuesByCoordinatorOrQueue,
  openIssuesByState,
  openIssuesByType,
  overdueTaskCountsByCoordinator,
} from '../lib/repositories/dashboard-repo.ts';
import {
  missingOrShortSummaryQueue,
  noActionableTaskQueue,
  readyToReleaseBlockedQueue,
  RELEASE_TRACK_PHASE_KEYS,
  staleCasesQueue,
  tasksOpenOverDaysQueue,
} from '../lib/repositories/exceptions-repo.ts';
import {
  auditEvents,
  holds,
  issues,
  phaseInstances,
  tasks,
  type Issue,
  type NewHold,
  type NewIssue,
  type NewPropertyRef,
  type NewTask,
} from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDb, type TestDbHandle } from './helpers/pglite.ts';
import { makeProperty, pastDate, futureDate } from './helpers/fixtures.ts';

let counter = 0;

async function makeIssue(
  db: TestDb,
  overrides: Partial<NewIssue> & { propertyOverrides?: Partial<NewPropertyRef> } = {},
): Promise<Issue> {
  counter += 1;
  const { propertyOverrides, propertyRefId, ...issueOverrides } = overrides;
  const resolvedPropertyRefId = propertyRefId ?? (await makeProperty(db, propertyOverrides)).id;
  const [row] = await db
    .insert(issues)
    .values({
      issueType: 'default_recovery',
      propertyRefId: resolvedPropertyRefId,
      summary: `Test issue ${counter}`,
      priority: 'normal',
      lifecycleStatus: 'active',
      coordinatorId: 'alice',
      ...issueOverrides,
    })
    .returning();
  if (!row) throw new Error('makeIssue: insert returned no row');
  return row;
}

async function makeTask(db: TestDb, overrides: Partial<NewTask> = {}) {
  const [row] = await db
    .insert(tasks)
    .values({
      title: 'Test task',
      status: 'open',
      priority: 'normal',
      assigneeId: 'alice',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeTask: insert returned no row');
  return row;
}

async function makeHold(db: TestDb, overrides: Partial<NewHold> & { propertyRefId: string }) {
  const [row] = await db
    .insert(holds)
    .values({
      holdType: 'legal',
      reason: 'Test hold',
      effectiveStart: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeHold: insert returned no row');
  return row;
}

async function putIssueInPhase(db: TestDb, issue: Issue, phaseKey: string, status: 'open' | 'in_progress' | 'completed' = 'open') {
  const [phase] = await db
    .insert(phaseInstances)
    .values({ issueId: issue.id, phaseKey, status })
    .returning();
  if (!phase) throw new Error('putIssueInPhase: insert returned no row');
  await db.update(issues).set({ currentPhaseInstanceId: phase.id }).where(eq(issues.id, issue.id));
  return phase;
}

function daysAgoDate(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('dashboard-repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('openIssuesByType groups open issues by issue_type, excluding closed', async () => {
    await makeIssue(handle.db, { issueType: 'default_recovery' });
    await makeIssue(handle.db, { issueType: 'default_recovery' });
    await makeIssue(handle.db, { issueType: 'covenant_violation' });
    await makeIssue(handle.db, { issueType: 'covenant_violation', lifecycleStatus: 'closed' });

    const rows = await openIssuesByType(handle.db);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(byKey.default_recovery).toBe(2);
    expect(byKey.covenant_violation).toBe(1);
  });

  it('issuesByLifecycleStatus includes closed issues in its own bucket', async () => {
    await makeIssue(handle.db, { lifecycleStatus: 'active' });
    await makeIssue(handle.db, { lifecycleStatus: 'intake', coordinatorId: null });
    await makeIssue(handle.db, { lifecycleStatus: 'closed', coordinatorId: null });

    const rows = await issuesByLifecycleStatus(handle.db);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(byKey.active).toBe(1);
    expect(byKey.intake).toBe(1);
    expect(byKey.closed).toBe(1);
  });

  it('openIssuesByState groups by property state, coalescing null to Unknown, excluding closed', async () => {
    await makeIssue(handle.db, { propertyOverrides: { state: 'TX' } });
    await makeIssue(handle.db, { propertyOverrides: { state: 'TX' } });
    await makeIssue(handle.db, { propertyOverrides: { state: 'OK' } });
    await makeIssue(handle.db, { propertyOverrides: { state: null } });
    await makeIssue(handle.db, { propertyOverrides: { state: 'TX' }, lifecycleStatus: 'closed' });

    const rows = await openIssuesByState(handle.db);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(byKey.TX).toBe(2);
    expect(byKey.OK).toBe(1);
    expect(byKey.Unknown).toBe(1);
  });

  it('openIssuesByCoordinatorOrQueue falls back to queue, then Unassigned', async () => {
    await makeIssue(handle.db, { coordinatorId: 'alice', queue: null });
    await makeIssue(handle.db, { coordinatorId: 'alice', queue: null });
    await makeIssue(handle.db, { coordinatorId: null, queue: 'legal', lifecycleStatus: 'waiting' });
    await makeIssue(handle.db, { coordinatorId: null, queue: null, lifecycleStatus: 'intake' });

    const rows = await openIssuesByCoordinatorOrQueue(handle.db);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(byKey.alice).toBe(2);
    expect(byKey.legal).toBe(1);
    expect(byKey.Unassigned).toBe(1);
  });

  it('overdueTaskCountsByCoordinator only counts open/in_progress tasks past due, grouped by assignee then queue', async () => {
    await makeTask(handle.db, { assigneeId: 'bob', status: 'open', dueDate: pastDate(5) });
    await makeTask(handle.db, { assigneeId: 'bob', status: 'open', dueDate: futureDate(5) }); // not overdue
    await makeTask(handle.db, { assigneeId: null, queue: 'sales', status: 'in_progress', dueDate: pastDate(1) });
    await makeTask(handle.db, { assigneeId: 'bob', status: 'completed', dueDate: pastDate(30) }); // not open

    const rows = await overdueTaskCountsByCoordinator(handle.db, TODAY);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(byKey.bob).toBe(1);
    expect(byKey.sales).toBe(1);
  });

  it('agingBucketsOfOpenIssues buckets by days since created_at and always returns all four keys', async () => {
    await makeIssue(handle.db, { createdAt: daysAgoDate(2) });
    await makeIssue(handle.db, { createdAt: daysAgoDate(20) });
    await makeIssue(handle.db, { createdAt: daysAgoDate(60) });
    await makeIssue(handle.db, { createdAt: daysAgoDate(200) });
    await makeIssue(handle.db, { createdAt: daysAgoDate(200), lifecycleStatus: 'closed' }); // excluded

    const buckets = await agingBucketsOfOpenIssues(handle.db, TODAY);
    expect(buckets).toEqual({ '0-7': 1, '8-30': 1, '31-90': 1, '90+': 1 });
  });

  it('activeHoldPropertyCountsByType and activeHoldPropertyCount count DISTINCT properties, not hold rows', async () => {
    const propA = await makeProperty(handle.db);
    const propB = await makeProperty(handle.db);
    const propC = await makeProperty(handle.db);

    await makeHold(handle.db, { propertyRefId: propA.id, holdType: 'legal' });
    await makeHold(handle.db, { propertyRefId: propB.id, holdType: 'legal' });
    await makeHold(handle.db, { propertyRefId: propB.id, holdType: 'safety' });
    // Released hold on propC: not active, must not count anywhere.
    await makeHold(handle.db, {
      propertyRefId: propC.id,
      holdType: 'title',
      releasedAt: new Date(),
      releasedBy: 'tester',
      releaseReason: 'resolved',
    });

    const byType = await activeHoldPropertyCountsByType(handle.db);
    const byKey = Object.fromEntries(byType.map((r) => [r.key, r.count]));
    expect(byKey.legal).toBe(2);
    expect(byKey.safety).toBe(1);
    expect(byKey.title).toBeUndefined();

    const total = await activeHoldPropertyCount(handle.db);
    expect(total).toBe(2); // propA + propB, never propC
  });
});

describe('exceptions-repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('noActionableTaskQueue: active issues with no open task, or no future-due open task', async () => {
    const hasActionable = await makeIssue(handle.db);
    await makeTask(handle.db, { issueId: hasActionable.id, status: 'open', dueDate: futureDate(3) });

    const noOpenTaskAtAll = await makeIssue(handle.db);

    const onlyPastDueOpenTask = await makeIssue(handle.db);
    await makeTask(handle.db, { issueId: onlyPastDueOpenTask.id, status: 'open', dueDate: pastDate(3) });

    const notActive = await makeIssue(handle.db, { lifecycleStatus: 'intake' });

    const onlyCompletedTaskWithFutureDue = await makeIssue(handle.db);
    await makeTask(handle.db, { issueId: onlyCompletedTaskWithFutureDue.id, status: 'completed', dueDate: futureDate(3) });

    const result = await noActionableTaskQueue(handle.db, { today: TODAY });
    const ids = result.rows.map((r) => r.issue.id);
    expect(result.count).toBe(3);
    expect(ids).toContain(noOpenTaskAtAll.id);
    expect(ids).toContain(onlyPastDueOpenTask.id);
    expect(ids).toContain(onlyCompletedTaskWithFutureDue.id);
    expect(ids).not.toContain(hasActionable.id);
    expect(ids).not.toContain(notActive.id);
  });

  it('noActionableTaskQueue respects limit while reporting the true count', async () => {
    for (let i = 0; i < 4; i++) await makeIssue(handle.db);
    const result = await noActionableTaskQueue(handle.db, { today: TODAY, limit: 2 });
    expect(result.count).toBe(4);
    expect(result.rows).toHaveLength(2);
  });

  it('missingOrShortSummaryQueue: short summary on open, non-passive issues only', async () => {
    const shortActive = await makeIssue(handle.db, { summary: 'Too short' }); // 9 chars
    await makeIssue(handle.db, { summary: 'This summary is long enough' });
    await makeIssue(handle.db, { summary: 'short', lifecycleStatus: 'closed', coordinatorId: null });
    await makeIssue(handle.db, {
      summary: 'short',
      lifecycleStatus: 'passive_wait',
      wakeEvent: 'buyer_response',
      coordinatorId: null,
    });

    const result = await missingOrShortSummaryQueue(handle.db, { today: TODAY });
    expect(result.count).toBe(1);
    expect(result.rows[0]?.issue.id).toBe(shortActive.id);
  });

  it('readyToReleaseBlockedQueue: pre-release phase + active hold older than the threshold', async () => {
    expect(RELEASE_TRACK_PHASE_KEYS).toContain('relisting');

    const blocked = await makeIssue(handle.db);
    await putIssueInPhase(handle.db, blocked, 'relisting', 'open');
    await makeHold(handle.db, { propertyRefId: blocked.propertyRefId, effectiveStart: daysAgoDate(20) });

    const notOldEnough = await makeIssue(handle.db);
    await putIssueInPhase(handle.db, notOldEnough, 'relisting', 'open');
    await makeHold(handle.db, { propertyRefId: notOldEnough.propertyRefId, effectiveStart: daysAgoDate(5) });

    const wrongPhase = await makeIssue(handle.db);
    await putIssueInPhase(handle.db, wrongPhase, 'intake', 'open');
    await makeHold(handle.db, { propertyRefId: wrongPhase.propertyRefId, effectiveStart: daysAgoDate(20) });

    const phaseNotOpen = await makeIssue(handle.db);
    await putIssueInPhase(handle.db, phaseNotOpen, 'relisting', 'completed');
    await makeHold(handle.db, { propertyRefId: phaseNotOpen.propertyRefId, effectiveStart: daysAgoDate(20) });

    const result = await readyToReleaseBlockedQueue(handle.db, { today: TODAY, minBlockedDays: 14 });
    const ids = result.rows.map((r) => r.issue.id);
    expect(result.count).toBe(1);
    expect(ids).toEqual([blocked.id]);
    expect(ids).not.toContain(notOldEnough.id);
    expect(ids).not.toContain(wrongPhase.id);
    expect(ids).not.toContain(phaseNotOpen.id);
  });

  it('staleCasesQueue: no audit activity in 14+ days, excluding closed/passive_wait', async () => {
    const stale = await makeIssue(handle.db, { createdAt: daysAgoDate(30) });

    const recentlyActive = await makeIssue(handle.db, { createdAt: daysAgoDate(30) });
    await handle.db.insert(auditEvents).values({
      objectTable: 'issues',
      objectId: recentlyActive.id,
      action: 'updated',
      occurredAt: daysAgoDate(2),
    });

    const tooYoung = await makeIssue(handle.db, { createdAt: daysAgoDate(5) });

    const closedButOld = await makeIssue(handle.db, { createdAt: daysAgoDate(30), lifecycleStatus: 'closed', coordinatorId: null });

    const result = await staleCasesQueue(handle.db, { today: TODAY, minStaleDays: 14 });
    const ids = result.rows.map((r) => r.issue.id);
    expect(result.count).toBe(1);
    expect(ids).toEqual([stale.id]);
    expect(ids).not.toContain(recentlyActive.id);
    expect(ids).not.toContain(tooYoung.id);
    expect(ids).not.toContain(closedButOld.id);
  });

  it('tasksOpenOverDaysQueue: open/in_progress tasks older than the threshold, linked to a case', async () => {
    const issue = await makeIssue(handle.db);

    const oldOpen = await makeTask(handle.db, { issueId: issue.id, status: 'open', createdAt: daysAgoDate(40) });
    await makeTask(handle.db, { issueId: issue.id, status: 'open', createdAt: daysAgoDate(10) }); // too young
    await makeTask(handle.db, { issueId: issue.id, status: 'completed', createdAt: daysAgoDate(40) }); // not open
    await makeTask(handle.db, { issueId: null, status: 'open', queue: 'sales', createdAt: daysAgoDate(40) }); // no case to link

    const result = await tasksOpenOverDaysQueue(handle.db, { today: TODAY, minOpenDays: 30 });
    expect(result.count).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.task.id).toBe(oldOpen.id);
    expect(result.rows[0]?.issueId).toBe(issue.id);
  });
});
