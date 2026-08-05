/**
 * service-gaps.test.ts — direct coverage for service functions the prior
 * adversarial review flagged as having NO test at all: hold-service's
 * releaseHold + applyStopWork, task-service's completeTask/rescheduleTask/
 * createFollowUp, and payment-service's approvePaymentRequest's W-9 gate.
 * Also documents (empirically) whether PGlite's single-connection driver
 * can support a real two-transaction concurrency test for the
 * pg_advisory_xact_lock claims in hold-service.ts/transition-engine.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyHold, applyStopWork, HoldServiceError, releaseHold } from '../lib/services/hold-service.ts';
import { completeTask, createFollowUp, rescheduleTask, TaskServiceError } from '../lib/services/task-service.ts';
import { approvePaymentRequest, PaymentRequestBlockedError, submitPaymentRequest } from '../lib/services/payment-service.ts';
import { auditEvents, holds, tasks, vendors } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('hold-service: releaseHold', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('rejects release without a reason', async () => {
    const property = await makeProperty(handle.db);
    const hold = await applyHold(handle.db, { propertyRefId: property.id, holdType: 'legal', reason: 'Pending litigation' });
    await expect(
      releaseHold(handle.db, { holdId: hold.id, releasedBy: 'actor-manager', actorRoles: ['manager'], reason: '' }),
    ).rejects.toMatchObject({ code: 'reason_required' });
  });

  it('rejects release for a hold ID that does not exist', async () => {
    await expect(
      releaseHold(handle.db, {
        holdId: '00000000-0000-0000-0000-000000000000',
        releasedBy: 'actor-manager',
        actorRoles: ['manager'],
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'hold_not_found' });
  });

  it('rejects releasing an already-released hold (double-release)', async () => {
    const property = await makeProperty(handle.db);
    const hold = await applyHold(handle.db, { propertyRefId: property.id, holdType: 'legal', reason: 'Pending litigation' });
    await releaseHold(handle.db, { holdId: hold.id, releasedBy: 'actor-manager', actorRoles: ['manager'], reason: 'Cleared' });

    await expect(
      releaseHold(handle.db, { holdId: hold.id, releasedBy: 'actor-manager', actorRoles: ['manager'], reason: 'Again' }),
    ).rejects.toMatchObject({ code: 'hold_already_released' });
  });

  it('AUTHORITY CHECK: rejects release when the actor lacks the default authority role (manager/admin) and no per-hold release_authority is set', async () => {
    const property = await makeProperty(handle.db);
    const hold = await applyHold(handle.db, { propertyRefId: property.id, holdType: 'other', reason: 'Needs review' });
    expect(hold.releaseAuthority).toBeNull();

    await expect(
      releaseHold(handle.db, { holdId: hold.id, releasedBy: 'actor-coordinator', actorRoles: ['coordinator'], reason: 'Trying to release' }),
    ).rejects.toMatchObject({ code: 'release_not_authorized' });

    // The hold must still be active in the DB — not just a rejected promise.
    const [reloaded] = await handle.db.select().from(holds).where(eq(holds.id, hold.id));
    expect(reloaded?.releasedAt).toBeNull();
  });

  it('AUTHORITY CHECK: rejects release when the actor lacks the SPECIFIC per-hold release_authority role, even though they hold the default manager role', async () => {
    const property = await makeProperty(handle.db);
    const hold = await applyHold(handle.db, {
      propertyRefId: property.id,
      holdType: 'legal',
      reason: 'Legal review required',
      releaseAuthority: 'legal_counsel',
    });

    // Actor has 'manager' (which would satisfy the DEFAULT authority) but
    // NOT 'legal_counsel' (the specific authority this hold names) — must
    // still be denied, proving the specific role check isn't short-circuited
    // by the default-role fallback.
    await expect(
      releaseHold(handle.db, { holdId: hold.id, releasedBy: 'actor-manager', actorRoles: ['manager'], reason: 'Trying anyway' }),
    ).rejects.toMatchObject({ code: 'release_not_authorized' });

    const released = await releaseHold(handle.db, {
      holdId: hold.id,
      releasedBy: 'actor-legal',
      actorRoles: ['legal_counsel'],
      reason: 'Cleared by counsel',
    });
    expect(released.releasedAt).not.toBeNull();
  });

  it('succeeds for an admin (default authority) and audits hold_released with before/after state', async () => {
    const property = await makeProperty(handle.db);
    const hold = await applyHold(handle.db, { propertyRefId: property.id, holdType: 'legal', reason: 'Pending litigation' });
    const actor = await makePerson(handle.db);

    const released = await releaseHold(handle.db, {
      holdId: hold.id,
      releasedBy: 'actor-admin',
      actorRoles: ['admin'],
      reason: 'Litigation resolved',
      actorId: actor.id,
    });

    expect(released.releasedAt).not.toBeNull();
    expect(released.releasedBy).toBe('actor-admin');

    const [reloaded] = await handle.db.select().from(holds).where(eq(holds.id, hold.id));
    expect(reloaded?.releasedAt).not.toBeNull();

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, hold.id));
    const releaseAudit = audits.find((a) => a.action === 'hold_released');
    expect(releaseAudit).toBeDefined();
    expect(releaseAudit?.reason).toBe('Litigation resolved');
    const before = releaseAudit?.before as { releasedAt: unknown } | null;
    expect(before?.releasedAt).toBeNull();
  });

  it('ADVERSARIAL-REVIEW REGRESSION: releasing a hold with only a Hub staff (actorExternalId) identity, no person_refs actorId, still records an attributable actor on the audit row', async () => {
    const property = await makeProperty(handle.db);
    const hold = await applyHold(handle.db, { propertyRefId: property.id, holdType: 'legal', reason: 'Pending litigation' });

    // Exactly the shape every server action produces: no actorId (Hub
    // staff identity is not a person_refs uuid), only actorExternalId.
    await releaseHold(handle.db, {
      holdId: hold.id,
      releasedBy: 'actor-manager',
      actorRoles: ['manager'],
      reason: 'Litigation resolved',
      actorId: null,
      actorExternalId: 'hub-staff-42',
    });

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, hold.id));
    const releaseAudit = audits.find((a) => a.action === 'hold_released');
    expect(releaseAudit).toBeDefined();
    expect(releaseAudit?.actorExternalId).toBe('hub-staff-42');
  });
});

describe('hold-service: applyStopWork', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('rejects a missing reported condition', async () => {
    const property = await makeProperty(handle.db);
    await expect(
      applyStopWork(handle.db, {
        propertyRefId: property.id,
        reportedCondition: '   ',
        source: 'field report',
        reviewerId: 'user-1',
        reviewDate: futureDate(),
      }),
    ).rejects.toMatchObject({ code: 'reported_condition_required' });
  });

  it('rejects a missing reviewer', async () => {
    const property = await makeProperty(handle.db);
    await expect(
      applyStopWork(handle.db, {
        propertyRefId: property.id,
        reportedCondition: 'Possible endangered species habitat reported',
        source: 'field report',
        reviewerId: '',
        reviewDate: futureDate(),
      }),
    ).rejects.toMatchObject({ code: 'reviewer_required' });
  });

  it('rejects a missing review date', async () => {
    const property = await makeProperty(handle.db);
    await expect(
      applyStopWork(handle.db, {
        propertyRefId: property.id,
        reportedCondition: 'Possible endangered species habitat reported',
        source: 'field report',
        reviewerId: 'user-1',
        reviewDate: '',
      }),
    ).rejects.toMatchObject({ code: 'review_date_required' });
  });

  it('creates a stop_work hold AND a review task, both audited, and the hold defaults release_authority to manager', async () => {
    const property = await makeProperty(handle.db);

    const result = await applyStopWork(handle.db, {
      propertyRefId: property.id,
      reportedCondition: 'Possible endangered species habitat reported',
      source: 'field report',
      reviewerId: 'user-1',
      reviewDate: futureDate(),
    });

    expect(result.hold.holdType).toBe('stop_work');
    expect(result.hold.releaseAuthority).toBe('manager');
    expect(result.hold.reason).toBe('Possible endangered species habitat reported');
    expect(result.reviewTaskId).toBeTruthy();

    const [task] = await handle.db.select().from(tasks).where(eq(tasks.id, result.reviewTaskId));
    expect(task).toBeDefined();
    expect(task?.priority).toBe('urgent');
    expect(task?.assigneeId).toBe('user-1');

    // hold_applied audit exists (via applyHold)
    const holdAudits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, result.hold.id));
    expect(holdAudits.some((a) => a.action === 'hold_applied')).toBe(true);

    // task_follow_up_created audit exists (adversarial-review fix: the raw
    // insert this replaced left no audit row at all — regression-guard it).
    const taskAudits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, result.reviewTaskId));
    expect(taskAudits.some((a) => a.action === 'task_follow_up_created')).toBe(true);
  });

  it('a stop_work hold actually blocks a gates_release transition (integration with the eligibility chokepoint)', async () => {
    const property = await makeProperty(handle.db);
    await applyStopWork(handle.db, {
      propertyRefId: property.id,
      reportedCondition: 'Unsafe structure reported on site',
      source: 'field report',
      reviewerId: 'user-1',
      reviewDate: futureDate(),
    });

    const { checkReleaseEligibility } = await import('../lib/services/eligibility-service.ts');
    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.eligible).toBe(false);
  });
});

describe('task-service: completeTask', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('rejects an unknown task id', async () => {
    await expect(completeTask(handle.db, { taskId: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({
      code: 'task_not_found',
    });
  });

  it('marks the task completed in the DB (not just the return value), sets verifiedCompletionDate, and audits before/after', async () => {
    const task = await createFollowUp(handle.db, { title: 'Verify cleanup', dueDate: futureDate(), queue: 'new_unreviewed' });
    expect(task.status).not.toBe('completed');

    const completed = await completeTask(handle.db, { taskId: task.id, verifiedCompletionDate: '2026-08-01', actorQueues: ['new_unreviewed'] });
    expect(completed.status).toBe('completed');
    expect(completed.verifiedCompletionDate).toBe('2026-08-01');

    const [reloaded] = await handle.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(reloaded?.status).toBe('completed');
    expect(reloaded?.verifiedCompletionDate).toBe('2026-08-01');

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, task.id));
    const completeAudit = audits.find((a) => a.action === 'task_completed');
    expect(completeAudit).toBeDefined();
    const before = completeAudit?.before as { status: string } | null;
    const after = completeAudit?.after as { status: string } | null;
    expect(before?.status).toBe(task.status);
    expect(after?.status).toBe('completed');
  });

  it('defaults verifiedCompletionDate to today when not supplied (spec §7: verified date is CCL confirming, never inferred from a promise, but still recorded when explicitly completing now)', async () => {
    const task = await createFollowUp(handle.db, { title: 'Verify cleanup', dueDate: futureDate(), queue: 'new_unreviewed' });
    const completed = await completeTask(handle.db, { taskId: task.id, actorQueues: ['new_unreviewed'] });
    const today = new Date().toISOString().slice(0, 10);
    expect(completed.verifiedCompletionDate).toBe(today);
  });

  it('preserves existing completionEvidenceId when not overridden, and updates it when supplied', async () => {
    const task = await createFollowUp(handle.db, { title: 'Verify cleanup', dueDate: futureDate(), queue: 'new_unreviewed' });
    const completed = await completeTask(handle.db, { taskId: task.id, completionEvidenceId: null, actorQueues: ['new_unreviewed'] });
    expect(completed.completionEvidenceId).toBeNull();
  });
});

describe('task-service: rescheduleTask', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('rejects a missing new due date', async () => {
    const task = await createFollowUp(handle.db, { title: 'Follow up', dueDate: futureDate(), queue: 'new_unreviewed' });
    await expect(rescheduleTask(handle.db, { taskId: task.id, newDueDate: '' })).rejects.toMatchObject({
      code: 'due_date_required',
    });
  });

  it('rejects an unknown task id', async () => {
    await expect(
      rescheduleTask(handle.db, { taskId: '00000000-0000-0000-0000-000000000000', newDueDate: futureDate() }),
    ).rejects.toMatchObject({ code: 'task_not_found' });
  });

  it('updates the due date in the DB and audits before/after dates + reason', async () => {
    const task = await createFollowUp(handle.db, { title: 'Follow up', dueDate: futureDate(3), queue: 'new_unreviewed' });
    const newDate = futureDate(30);

    const updated = await rescheduleTask(handle.db, { taskId: task.id, newDueDate: newDate, reason: 'Vendor delay', actorQueues: ['new_unreviewed'] });
    expect(updated.dueDate).toBe(newDate);

    const [reloaded] = await handle.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(reloaded?.dueDate).toBe(newDate);

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, task.id));
    const rescheduleAudit = audits.find((a) => a.action === 'task_rescheduled');
    expect(rescheduleAudit).toBeDefined();
    expect(rescheduleAudit?.reason).toBe('Vendor delay');
    expect((rescheduleAudit?.before as { dueDate: string } | null)?.dueDate).toBe(task.dueDate);
    expect((rescheduleAudit?.after as { dueDate: string } | null)?.dueDate).toBe(newDate);
  });
});

// =====================================================================
// ADVERSARIAL-REVIEW FIX (P1 IDOR): completeTask/rescheduleTask used to
// accept an arbitrary taskId with NO ownership/role check at all — any
// authenticated caller could complete or reschedule anyone else's task,
// including a release-gating verification task, just by supplying its
// uuid (repro H4 from the review: assigneeId 'alice', completed by
// 'mallory', no error, assignee untouched). These tests cover the fix:
// owner succeeds, a stranger is denied, a manager override succeeds and is
// recorded on the audit row.
// =====================================================================
describe('task-service: completeTask/rescheduleTask ownership (IDOR fix)', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('denies a stranger with no ownership, queue coverage, or override role', async () => {
    const task = await createFollowUp(handle.db, { title: 'Verify vacancy before release', dueDate: futureDate(), assigneeId: 'alice' });

    await expect(
      completeTask(handle.db, { taskId: task.id, actorExternalId: 'mallory', actorRoles: ['coordinator'] }),
    ).rejects.toMatchObject({ code: 'task_not_authorized' });

    const [reloaded] = await handle.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(reloaded?.status).not.toBe('completed');
    expect(reloaded?.assigneeId).toBe('alice');
  });

  it('allows the assigned owner to complete their own task', async () => {
    const task = await createFollowUp(handle.db, { title: 'Verify vacancy before release', dueDate: futureDate(), assigneeId: 'alice' });

    const completed = await completeTask(handle.db, { taskId: task.id, actorExternalId: 'alice', actorRoles: ['coordinator'] });
    expect(completed.status).toBe('completed');
  });

  it('allows a caller covering the task\'s queue even without direct assignment', async () => {
    const task = await createFollowUp(handle.db, { title: 'Follow up', dueDate: futureDate(), queue: 'overdue' });

    const updated = await rescheduleTask(handle.db, {
      taskId: task.id,
      newDueDate: futureDate(30),
      actorExternalId: 'someone-else-entirely',
      actorQueues: ['overdue'],
    });
    expect(updated.dueDate).toBe(futureDate(30));
  });

  it('allows a manager/admin to override ownership, and records the override on the audit row', async () => {
    const task = await createFollowUp(handle.db, { title: 'Verify vacancy before release', dueDate: futureDate(), assigneeId: 'alice' });

    const completed = await completeTask(handle.db, {
      taskId: task.id,
      actorExternalId: 'manager-bob',
      actorRoles: ['manager'],
    });
    expect(completed.status).toBe('completed');

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, task.id));
    const completeAudit = audits.find((a) => a.action === 'task_completed');
    expect((completeAudit?.after as { overrodeOwnership?: boolean } | null)?.overrodeOwnership).toBe(true);
  });
});

describe('task-service: createFollowUp', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('rejects a missing title, missing due date, and missing assignee+queue, all in one combined error message', async () => {
    await expect(createFollowUp(handle.db, { title: '', dueDate: '', description: null })).rejects.toMatchObject({
      code: 'follow_up_validation_failed',
    });
    try {
      await createFollowUp(handle.db, { title: '', dueDate: '' });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/title/);
      expect(message).toMatch(/due date/);
      expect(message).toMatch(/assignee or a queue/);
    }
  });

  it('accepts an assignee with no queue, and a queue with no assignee', async () => {
    const byAssignee = await createFollowUp(handle.db, { title: 'A', dueDate: futureDate(), assigneeId: 'user-1' });
    expect(byAssignee.assigneeId).toBe('user-1');
    const byQueue = await createFollowUp(handle.db, { title: 'B', dueDate: futureDate(), queue: 'new_unreviewed' });
    expect(byQueue.queue).toBe('new_unreviewed');
  });

  it('persists the row in the DB (not just returns it) and audits task_follow_up_created with after = created row', async () => {
    const created = await createFollowUp(handle.db, {
      title: 'Chase down utility shutoff confirmation',
      dueDate: futureDate(),
      queue: 'new_unreviewed',
      priority: 'high',
    });

    const [reloaded] = await handle.db.select().from(tasks).where(eq(tasks.id, created.id));
    expect(reloaded).toBeDefined();
    expect(reloaded?.title).toBe('Chase down utility shutoff confirmation');
    expect(reloaded?.priority).toBe('high');

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, created.id));
    const createAudit = audits.find((a) => a.action === 'task_follow_up_created');
    expect(createAudit).toBeDefined();
    expect(createAudit?.before).toBeNull();
    expect((createAudit?.after as { title: string } | null)?.title).toBe('Chase down utility shutoff confirmation');
  });

  it('defaults priority to normal when not supplied', async () => {
    const created = await createFollowUp(handle.db, { title: 'Default priority task', dueDate: futureDate(), queue: 'new_unreviewed' });
    expect(created.priority).toBe('normal');
  });
});

describe('payment-service: approvePaymentRequest W-9 gate', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function makeVendor(w9Status: 'not_collected' | 'requested' | 'received' | 'verified' | 'expired') {
    const person = await makePerson(handle.db, { kind: 'org', displayName: `Vendor (${w9Status})` });
    const [vendor] = await handle.db.insert(vendors).values({ personRefId: person.id, displayName: `Vendor (${w9Status})`, w9Status }).returning();
    if (!vendor) throw new Error('vendor insert failed');
    return vendor;
  }

  async function makePaymentRequest(vendorId: string) {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { createIssue } = await import('../lib/services/issue-service.ts');
    const { issue } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Cleanup case',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    return submitPaymentRequest(handle.db, { issueId: issue.id, vendorId, amountCents: 50000 });
  }

  it('rejects approval for an unknown payment request id', async () => {
    const approver = await makePerson(handle.db);
    await expect(
      approvePaymentRequest(handle.db, { paymentRequestId: '00000000-0000-0000-0000-000000000000', approverId: approver.id }),
    ).rejects.toMatchObject({ code: 'payment_request_not_found' });
  });

  it.each(['not_collected', 'requested', 'expired'] as const)(
    'BLOCKS approval when vendor W-9 status is "%s"',
    async (w9Status) => {
      const vendor = await makeVendor(w9Status);
      const paymentRequest = await makePaymentRequest(vendor.id);
      const approver = await makePerson(handle.db);

      await expect(
        approvePaymentRequest(handle.db, { paymentRequestId: paymentRequest.id, approverId: approver.id }),
      ).rejects.toBeInstanceOf(PaymentRequestBlockedError);
      await expect(
        approvePaymentRequest(handle.db, { paymentRequestId: paymentRequest.id, approverId: approver.id }),
      ).rejects.toMatchObject({ code: 'w9_required' });
    },
  );

  it.each(['received', 'verified'] as const)('ALLOWS approval when vendor W-9 status is "%s"', async (w9Status) => {
    const vendor = await makeVendor(w9Status);
    const paymentRequest = await makePaymentRequest(vendor.id);
    const approver = await makePerson(handle.db);

    const approved = await approvePaymentRequest(handle.db, { paymentRequestId: paymentRequest.id, approverId: approver.id });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(approver.id);

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, paymentRequest.id));
    expect(audits.some((a) => a.action === 'payment_request_approved')).toBe(true);
  });

  it('a blocked approval leaves the payment request status unchanged in the DB (fail-closed, no partial write)', async () => {
    const vendor = await makeVendor('not_collected');
    const paymentRequest = await makePaymentRequest(vendor.id);
    const approver = await makePerson(handle.db);

    await expect(approvePaymentRequest(handle.db, { paymentRequestId: paymentRequest.id, approverId: approver.id })).rejects.toThrow();

    const { paymentRequests } = await import('../lib/db/schema.ts');
    const [reloaded] = await handle.db.select().from(paymentRequests).where(eq(paymentRequests.id, paymentRequest.id));
    expect(reloaded?.status).toBe('submitted');
    expect(reloaded?.approvedBy).toBeNull();
  });
});

/**
 * Concurrency / advisory-lock claim (hold-service.ts lockProperty,
 * transition-engine.ts's equivalent pg_advisory_xact_lock call): both
 * modules claim a concurrent applyHold/releaseHold vs. transitionPhase on
 * the SAME property can no longer race under READ COMMITTED because one
 * transaction blocks on the other's advisory lock.
 *
 * FINDING (documented, not silently skipped): PGlite's JS driver serializes
 * ALL `client.transaction(...)` calls on a single PGlite instance itself —
 * a second `.transaction()` call does not even START (no BEGIN is issued)
 * until the first one's callback has fully resolved and committed. This
 * was verified empirically: two overlapping `client.transaction()` calls
 * against the same in-memory PGlite client run strictly back-to-back
 * (A:begin -> A:locked -> A:commit -> B:begin -> B:locked), never
 * interleaved, regardless of whether pg_advisory_xact_lock is called at
 * all. PGlite exposes only a single logical connection per instance (no
 * connection pool, and this suite uses in-memory instances with no shared
 * on-disk file another PGlite instance could attach to), so there is no
 * way, using this test harness's PGlite setup, to get two truly concurrent
 * transactions on the same tables to observe whether the advisory lock
 * itself (as opposed to PGlite's own driver-level transaction queueing)
 * is what prevents the TOCTOU race. This test asserts the empirical
 * serialization behavior as a regression guard and documents the gap
 * rather than asserting something the harness cannot actually prove.
 */
describe('advisory-lock concurrency claim (documented as untestable with PGlite)', () => {
  let handle: TestDbHandle;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('PGlite serializes concurrent client.transaction() calls on one instance (no interleaving is observable), so the advisory lock\'s marginal effect over PGlite\'s own serialization is not testable here', async () => {
    const property = await makeProperty(handle.db);
    const events: string[] = [];

    async function slowHold() {
      await handle.db.transaction(async (tx) => {
        events.push('hold:begin');
        await applyHold(tx, { propertyRefId: property.id, holdType: 'other', reason: 'concurrency probe A' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push('hold:end');
      });
    }

    async function secondHold() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await handle.db.transaction(async (tx) => {
        events.push('hold2:begin');
        await applyHold(tx, { propertyRefId: property.id, holdType: 'other', reason: 'concurrency probe B' });
        events.push('hold2:end');
      });
    }

    await Promise.all([slowHold(), secondHold()]);

    // If PGlite were truly interleaving these two transactions, hold2:begin
    // could appear before hold:end. It never does, under this driver.
    const hold2BeginIndex = events.indexOf('hold2:begin');
    const holdEndIndex = events.indexOf('hold:end');
    expect(hold2BeginIndex).toBeGreaterThan(holdEndIndex);

    const propertyHolds = await handle.db.select().from(holds).where(eq(holds.propertyRefId, property.id));
    expect(propertyHolds).toHaveLength(2);
  });
});
