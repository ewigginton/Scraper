/**
 * issue-lifecycle.test.ts — direct coverage for three service functions the
 * prior adversarial review flagged as having NO test at all:
 * issue-service.reopenAsNewCycle, issue-service.closeIssue, and
 * transition-engine.explainBlockingHolds.
 *
 * reopenAsNewCycle's own idempotency fix (this round) is the primary thing
 * under test here: unlike openFromLoanDefault/handleReinstatementEffective,
 * it previously had NO idempotency protection at all — a retried/
 * double-submitted call inserted a second issue_cycles row (plus a second
 * follow-up task and audit row) and its published domain event embedded a
 * fresh randomUUID() on every call, defeating consumed_events'/
 * domain_events' dedup entirely (DESIGN.md hard rule #5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeIssue, createIssue, reopenAsNewCycle } from '../lib/services/issue-service.ts';
import { explainBlockingHolds } from '../lib/services/transition-engine.ts';
import { applyHold } from '../lib/services/hold-service.ts';
import { auditEvents, domainEvents, issueCycles, issues, tasks } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('issue-service: reopenAsNewCycle', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function closedIssue() {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const created = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Reopen-as-new-cycle fixture',
      coordinatorId: 'coordinator-a',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    await closeIssue(handle.db, { issueId: created.issue.id, reason: 'Resolved for the fixture' });
    return created;
  }

  it('rejects a missing reason', async () => {
    const { issue } = await closedIssue();
    await expect(
      reopenAsNewCycle(handle.db, { issueId: issue.id, reason: '', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ code: 'issue_validation_failed' });
  });

  it('rejects a missing idempotency key', async () => {
    const { issue } = await closedIssue();
    await expect(
      reopenAsNewCycle(handle.db, { issueId: issue.id, reason: 'Owner is back in default', idempotencyKey: '' }),
    ).rejects.toMatchObject({ code: 'issue_validation_failed' });
  });

  it('rejects an unknown issue id', async () => {
    await expect(
      reopenAsNewCycle(handle.db, { issueId: '00000000-0000-0000-0000-000000000000', reason: 'x', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ code: 'issue_validation_failed' });
  });

  it('willHaveOwner guard: rejects reopening an issue with neither coordinator nor queue and no nextTask owner supplied', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const created = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'No coordinator, no queue',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    await closeIssue(handle.db, { issueId: created.issue.id, reason: 'Closed with no owner' });

    await expect(
      reopenAsNewCycle(handle.db, { issueId: created.issue.id, reason: 'Reopen attempt with no owner', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ code: 'issue_validation_failed' });

    // Supplying nextTask.queue satisfies the guard and succeeds.
    const outcome = await reopenAsNewCycle(handle.db, {
      issueId: created.issue.id,
      reason: 'Reopen attempt with a queue supplied',
      idempotencyKey: 'k2',
      nextTask: { title: 'Re-review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    expect(outcome.status).toBe('processed');
  });

  it('reopens a closed issue: sets lifecycle_status active, opens a new issue_cycles row, creates the follow-up task, and audits before/after', async () => {
    const { issue } = await closedIssue();

    const outcome = await reopenAsNewCycle(handle.db, {
      issueId: issue.id,
      reason: 'Owner defaulted again',
      idempotencyKey: 'reopen-1',
      nextTask: { title: 'Re-review the case', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    expect(outcome.status).toBe('processed');
    if (outcome.status !== 'processed') throw new Error('unreachable');
    expect(outcome.result.issue.lifecycleStatus).toBe('active');
    expect(outcome.result.task?.title).toBe('Re-review the case');

    const cycles = await handle.db.select().from(issueCycles).where(eq(issueCycles.issueId, issue.id));
    expect(cycles.length).toBe(1);

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, issue.id));
    const reopenAudit = audits.find((a) => a.action === 'issue_reopened_new_cycle');
    expect(reopenAudit).toBeDefined();
    expect((reopenAudit?.before as { lifecycleStatus: string } | null)?.lifecycleStatus).toBe('closed');
    expect((reopenAudit?.after as { lifecycleStatus: string } | null)?.lifecycleStatus).toBe('active');
  });

  it('ADVERSARIAL-REVIEW REGRESSION: a retried call with the identical idempotency key is a no-op, not a second cycle/task/audit/event', async () => {
    const { issue } = await closedIssue();
    const input = {
      issueId: issue.id,
      reason: 'Owner defaulted again',
      idempotencyKey: 'reopen-retry-key',
      nextTask: { title: 'Re-review the case', dueDate: futureDate(), queue: 'new_unreviewed' },
    } as const;

    const first = await reopenAsNewCycle(handle.db, input);
    expect(first.status).toBe('processed');

    const second = await reopenAsNewCycle(handle.db, input);
    expect(second.status).toBe('skipped_duplicate');

    const cycles = await handle.db.select().from(issueCycles).where(eq(issueCycles.issueId, issue.id));
    expect(cycles.length).toBe(1);

    const allTasks = await handle.db.select().from(tasks).where(eq(tasks.issueId, issue.id));
    expect(allTasks.filter((t) => t.title === 'Re-review the case').length).toBe(1);

    const audits = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.objectId, issue.id));
    expect(audits.filter((a) => a.action === 'issue_reopened_new_cycle').length).toBe(1);

    const events = await handle.db.select().from(domainEvents).where(eq(domainEvents.issueId, issue.id));
    expect(events.filter((e) => e.eventType === 'property_operations.issue_reopened').length).toBe(1);
  });
});

describe('issue-service: closeIssue', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function openIssue() {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    return createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Close-issue fixture',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
  }

  it('rejects a missing reason', async () => {
    const { issue } = await openIssue();
    await expect(closeIssue(handle.db, { issueId: issue.id, reason: '' })).rejects.toMatchObject({
      code: 'issue_validation_failed',
    });
  });

  it('rejects an unknown issue id', async () => {
    await expect(
      closeIssue(handle.db, { issueId: '00000000-0000-0000-0000-000000000000', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'issue_validation_failed' });
  });

  it('sets lifecycle_status to closed and audits before/after', async () => {
    const { issue } = await openIssue();
    const closed = await closeIssue(handle.db, { issueId: issue.id, reason: 'Property released and sold' });
    expect(closed.lifecycleStatus).toBe('closed');

    const [reloaded] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(reloaded?.lifecycleStatus).toBe('closed');

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, issue.id));
    const closeAudit = audits.find((a) => a.action === 'issue_closed');
    expect(closeAudit).toBeDefined();
    expect((closeAudit?.before as { lifecycleStatus: string } | null)?.lifecycleStatus).toBe(issue.lifecycleStatus);
    expect((closeAudit?.after as { lifecycleStatus: string } | null)?.lifecycleStatus).toBe('closed');
  });

  it('closing an already-closed issue is an idempotent no-op: returns the existing row and writes no second audit row', async () => {
    const { issue } = await openIssue();
    const firstClose = await closeIssue(handle.db, { issueId: issue.id, reason: 'First close' });
    const secondClose = await closeIssue(handle.db, { issueId: issue.id, reason: 'Second close attempt' });

    expect(secondClose.id).toBe(firstClose.id);
    expect(secondClose.lifecycleStatus).toBe('closed');

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, issue.id));
    expect(audits.filter((a) => a.action === 'issue_closed').length).toBe(1);
  });
});

describe('transition-engine: explainBlockingHolds', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('delegates to the same eligibility chokepoint as checkReleaseEligibility (DESIGN.md hard rule #1)', async () => {
    const property = await makeProperty(handle.db);
    await applyHold(handle.db, { propertyRefId: property.id, holdType: 'legal', reason: 'Pending litigation' });

    const result = await explainBlockingHolds(handle.db, property.id);
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === 'active_hold_legal')).toBe(true);
  });

  it('a property with no issue history at all is fail-safe blocked (possession unresolved by default, not eligible)', async () => {
    // See eligibility-service.ts's possessionRequired doc comment: a
    // property with zero issues ever opened on it is NOT positive evidence
    // that possession doesn't matter (only "every open issue is
    // property_legal" is), so it fails closed/safe rather than reporting
    // eligible:true — matches test/eligibility.test.ts's "blocks release
    // when possession is unresolved (no possession record at all)".
    const property = await makeProperty(handle.db);
    const result = await explainBlockingHolds(handle.db, property.id);
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
  });
});
