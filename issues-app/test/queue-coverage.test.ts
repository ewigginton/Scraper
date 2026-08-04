/**
 * queue-coverage.test.ts — regression coverage for the ROUND-2 P1 finding:
 * task-service.ts's assertTaskAuthorized (the round-1 task IDOR fix) grants
 * access via `actorQueues` covering a task's queue, but NO production caller
 * ever supplied `actorQueues` — CurrentUser had no `queues` field to source
 * it from. Queue-only tasks ARE created by shipped commands
 * (issue-service.openFromLoanDefault's 'new_unreviewed',
 * handleReinstatementEffective's 'waiting_blocked'), so those tasks were
 * orphaned: invisible on every work screen (tasks-repo.ts's ownerFilter also
 * takes `queues`) and rejected from the case view with "This task is
 * assigned to someone else" for every non-manager/admin user — exactly the
 * finding's own repro shape.
 *
 * BEFORE this fix: both tests below FAIL.
 * AFTER this fix: both PASS.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '../lib/auth/current-user.ts';
import { completeTask, createFollowUp, TaskServiceError } from '../lib/services/task-service.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { inboxForUser } from '../lib/repositories/tasks-repo.ts';
import { auditEvents } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('CurrentUser.queues + task-service queue coverage (P1 regression)', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('REGRESSION: a coordinator can complete a queue-only task (assigneeId null) using EXACTLY the shape app/actions.ts builds from getCurrentUser()', async () => {
    // A queue-only task with no assignee — exactly the shape
    // openFromLoanDefault (queue 'new_unreviewed') and
    // handleReinstatementEffective (queue 'waiting_blocked') produce.
    const task = await createFollowUp(handle.db, {
      title: 'Initial review: loan default recovery case',
      dueDate: futureDate(3),
      queue: 'new_unreviewed',
    });
    expect(task.assigneeId).toBeNull();

    const user = await getCurrentUser();
    expect(user.roles).toContain('coordinator');

    // This is the EXACT argument shape completeTaskAction now builds:
    // actorExternalId/actorRole/actorRoles/actorQueues all sourced from
    // getCurrentUser(), never from form data.
    const completed = await completeTask(handle.db, {
      taskId: task.id,
      actorExternalId: user.id,
      actorRole: user.roles[0] ?? null,
      actorRoles: user.roles,
      actorQueues: user.queues,
      correlationId: null,
    });

    expect(completed.status).toBe('completed');
  });

  it('a caller whose roles cover no queues (CurrentUser.queues resolves empty) is still correctly denied on a queue-only task', async () => {
    const task = await createFollowUp(handle.db, { title: 'Follow up', dueDate: futureDate(), queue: 'new_unreviewed' });

    await expect(
      completeTask(handle.db, {
        taskId: task.id,
        actorExternalId: 'sales-user',
        actorRole: 'sales',
        actorRoles: ['sales'],
        actorQueues: [], // sales covers no queues per ROLE_QUEUES
        correlationId: null,
      }),
    ).rejects.toBeInstanceOf(TaskServiceError);
  });

  it("REGRESSION: a queue-only 'new_unreviewed' intake task (exactly openFromLoanDefault's shape) appears in the caller's work-screen inbox via inboxForUser({ queues: user.queues })", async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { task } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Loan default received from Loan Services; opening recovery case.',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review: loan default recovery case', dueDate: futureDate(3), queue: 'new_unreviewed' },
    });
    expect(task.assigneeId).toBeNull();

    const user = await getCurrentUser();
    // Without queues threaded through, this caller (no direct assignment)
    // would see nothing in newUnreviewed for this queue-only task.
    const inbox = await inboxForUser(handle.db, { assigneeId: user.id, queues: user.queues });

    expect(inbox.newUnreviewed.some((t) => t.id === task.id)).toBe(true);
  });

  it('REGRESSION (round 3, P2): a named assignee outranks queue coverage — a coordinator covering the queue CANNOT complete a task individually assigned to someone else', async () => {
    // Exactly Probe D's shape: a task with BOTH assignee_id and queue set.
    const task = await createFollowUp(handle.db, {
      title: 'Verify possession/vacancy before release',
      dueDate: futureDate(),
      assigneeId: 'alice',
      queue: 'new_unreviewed',
    });

    const user = await getCurrentUser(); // dev-user, roles: ['coordinator'], queues: ['new_unreviewed', 'waiting_blocked']
    expect(user.roles).toContain('coordinator');
    expect(user.roles).not.toContain('manager');
    expect(user.roles).not.toContain('admin');

    // BEFORE this fix: this succeeded (queue coverage alone was sufficient),
    // completing Alice's individually-assigned task as bob with
    // overrodeOwnership recorded as false — indistinguishable from Alice
    // completing her own task.
    await expect(
      completeTask(handle.db, {
        taskId: task.id,
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
        actorRoles: user.roles,
        actorQueues: user.queues,
      }),
    ).rejects.toBeInstanceOf(TaskServiceError);
  });

  it('REGRESSION (round 3, P2): a manager/admin CAN complete a task assigned to someone else, and the override is stamped on the audit row', async () => {
    const task = await createFollowUp(handle.db, {
      title: 'Verify possession/vacancy before release',
      dueDate: futureDate(),
      assigneeId: 'alice',
      queue: 'new_unreviewed',
    });

    const completed = await completeTask(handle.db, {
      taskId: task.id,
      actorExternalId: 'manager-bob',
      actorRole: 'manager',
      actorRoles: ['manager'],
      actorQueues: ['new_unreviewed', 'waiting_blocked'],
    });
    expect(completed.status).toBe('completed');

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, task.id));
    const completeAudit = audits.find((a) => a.action === 'task_completed');
    const after = completeAudit?.after as { overrodeOwnership?: boolean; authorizationBasis?: string } | null;
    expect(after?.overrodeOwnership).toBe(true);
    expect(after?.authorizationBasis).toBe('role_override');
  });

  it('a queue-only completion (no named assignee) stamps authorizationBasis:"queue" on the audit row, distinct from a role override', async () => {
    const task = await createFollowUp(handle.db, { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' });

    await completeTask(handle.db, {
      taskId: task.id,
      actorExternalId: 'coordinator-a',
      actorRole: 'coordinator',
      actorRoles: ['coordinator'],
      actorQueues: ['new_unreviewed', 'waiting_blocked'],
    });

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, task.id));
    const completeAudit = audits.find((a) => a.action === 'task_completed');
    const after = completeAudit?.after as { overrodeOwnership?: boolean; authorizationBasis?: string } | null;
    expect(after?.overrodeOwnership).toBe(false);
    expect(after?.authorizationBasis).toBe('queue');
  });
});
