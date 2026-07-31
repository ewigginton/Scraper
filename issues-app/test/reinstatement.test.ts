import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createIssue, handleReinstatementEffective } from '../lib/services/issue-service.ts';
import { holds, issues, phaseInstances, tasks, vendorJobs, bids, vendors, approvals, auditEvents } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('handleReinstatementEffective (spec §28.5)', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function setUpCaseWithWorkInProgress() {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue, phaseInstance } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Default recovery in progress',
      coordinatorId: 'coordinator-1',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    // Simulate work already started: an accepted bid + a scheduled vendor job + a pending approval.
    const vendorPerson = await makePerson(handle.db, { kind: 'org', displayName: 'Cleanup Vendor' });
    const [vendor] = await handle.db.insert(vendors).values({ personRefId: vendorPerson.id, displayName: 'Cleanup Vendor' }).returning();
    const [bid] = await handle.db
      .insert(bids)
      .values({ issueId: issue.id, vendorId: vendor!.id, scope: 'Full cleanup', amountCents: 250000, status: 'accepted' })
      .returning();
    const [job] = await handle.db
      .insert(vendorJobs)
      .values({ issueId: issue.id, bidId: bid!.id, vendorId: vendor!.id, status: 'in_progress' })
      .returning();
    const [approval] = await handle.db
      .insert(approvals)
      .values({ requestedAction: 'release_property', objectTable: 'issues', objectId: issue.id, requesterId: owner.id, decision: 'pending' })
      .returning();

    return { property, owner, issue, phaseInstance, vendor, bid, job, approval };
  }

  it('moves open cleanup/recovery work into a reinstatement_review phase and blocks the issue', async () => {
    const { property, issue, phaseInstance } = await setUpCaseWithWorkInProgress();

    const result = await handleReinstatementEffective(handle.db, {
      idempotencyKey: 'reinstatement-1',
      propertyRefId: property.id,
      reason: 'Loan reinstated; payment plan approved',
    });

    expect(result.status).toBe('processed');
    if (result.status !== 'processed') throw new Error('unreachable');
    expect(result.result.affectedIssues).toHaveLength(1);
    expect(result.result.affectedIssues[0]?.issueId).toBe(issue.id);

    const [oldPhase] = await handle.db.select().from(phaseInstances).where(eq(phaseInstances.id, phaseInstance.id));
    expect(oldPhase?.status).toBe('blocked');
    expect(oldPhase?.exitOutcome).toBe('reinstatement_effective');

    const reviewPhaseId = result.result.affectedIssues[0]!.reviewPhaseInstanceId;
    const [reviewPhase] = await handle.db.select().from(phaseInstances).where(eq(phaseInstances.id, reviewPhaseId));
    expect(reviewPhase?.phaseKey).toBe('reinstatement_review');
    expect(reviewPhase?.status).toBe('open');

    const [reloadedIssue] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(reloadedIssue?.currentPhaseInstanceId).toBe(reviewPhaseId);
    expect(reloadedIssue?.lifecycleStatus).toBe('blocked');
  });

  it('creates an urgent task for the coordinator', async () => {
    const { property, issue } = await setUpCaseWithWorkInProgress();

    const result = await handleReinstatementEffective(handle.db, {
      idempotencyKey: 'reinstatement-2',
      propertyRefId: property.id,
      coordinatorId: 'coordinator-1',
    });
    if (result.status !== 'processed') throw new Error('unreachable');

    const urgentTaskId = result.result.affectedIssues[0]!.urgentTaskId;
    const [task] = await handle.db.select().from(tasks).where(eq(tasks.id, urgentTaskId));
    expect(task?.priority).toBe('urgent');
    expect(task?.assigneeId).toBe('coordinator-1');
    expect(task?.issueId).toBe(issue.id);
    expect(task?.status).toBe('open');
  });

  it('preserves all prior work: bids, vendor jobs, and costs are not deleted or altered', async () => {
    const { property, bid, job } = await setUpCaseWithWorkInProgress();

    await handleReinstatementEffective(handle.db, { idempotencyKey: 'reinstatement-3', propertyRefId: property.id });

    const [reloadedBid] = await handle.db.select().from(bids).where(eq(bids.id, bid!.id));
    expect(reloadedBid).toBeDefined();
    expect(reloadedBid?.status).toBe('accepted');

    const [reloadedJob] = await handle.db.select().from(vendorJobs).where(eq(vendorJobs.id, job!.id));
    expect(reloadedJob).toBeDefined();
    expect(reloadedJob?.status).toBe('in_progress');
  });

  it('cancels the stale pending approval', async () => {
    const { property, approval } = await setUpCaseWithWorkInProgress();

    await handleReinstatementEffective(handle.db, { idempotencyKey: 'reinstatement-4', propertyRefId: property.id });

    const [reloadedApproval] = await handle.db.select().from(approvals).where(eq(approvals.id, approval!.id));
    expect(reloadedApproval?.decision).toBe('withdrawn');
  });

  it('applies an existing_contract_active hold on the property', async () => {
    const { property } = await setUpCaseWithWorkInProgress();

    await handleReinstatementEffective(handle.db, { idempotencyKey: 'reinstatement-5', propertyRefId: property.id });

    const activeHolds = await handle.db.select().from(holds).where(eq(holds.propertyRefId, property.id));
    const contractHold = activeHolds.find((h) => h.holdType === 'existing_contract_active');
    expect(contractHold).toBeDefined();
    expect(contractHold?.releasedAt).toBeNull();
  });

  it('is idempotent: a duplicate reinstatement event does not create a second review phase or a second hold', async () => {
    const { property } = await setUpCaseWithWorkInProgress();

    const first = await handleReinstatementEffective(handle.db, { idempotencyKey: 'reinstatement-dup', propertyRefId: property.id });
    const second = await handleReinstatementEffective(handle.db, { idempotencyKey: 'reinstatement-dup', propertyRefId: property.id });

    expect(first.status).toBe('processed');
    expect(second.status).toBe('skipped_duplicate');

    const activeHolds = await handle.db.select().from(holds).where(eq(holds.propertyRefId, property.id));
    const contractHolds = activeHolds.filter((h) => h.holdType === 'existing_contract_active');
    expect(contractHolds).toHaveLength(1);

    const reviewPhases = await handle.db.select().from(phaseInstances).where(eq(phaseInstances.phaseKey, 'reinstatement_review'));
    expect(reviewPhases).toHaveLength(1);
  });

  it('records the triggering event and resulting state change in the audit timeline', async () => {
    const { property, issue } = await setUpCaseWithWorkInProgress();

    await handleReinstatementEffective(handle.db, { idempotencyKey: 'reinstatement-6', propertyRefId: property.id, reason: 'Reinstatement approved' });

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, issue.id));
    const reinstatementAudit = audits.find((a) => a.action === 'reinstatement_effective_applied');
    expect(reinstatementAudit).toBeDefined();
    expect(reinstatementAudit?.reason).toBe('Reinstatement approved');
  });
});
