/* SCRATCH — adversarial round-3 verification. Delete before shipping. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { transitionPhase, TransitionError } from '../lib/services/transition-engine.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { applyHold, releaseHold, HoldServiceError } from '../lib/services/hold-service.ts';
import { recordPossession } from '../lib/services/possession-service.ts';
import { completeTask } from '../lib/services/task-service.ts';
import { checkReleaseEligibility } from '../lib/services/eligibility-service.ts';
import { auditEvents, domainEvents, holds, tasks, vendorJobs, vendors, possessionRecords } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('ADVERSARIAL round-3', () => {
  let handle: TestDbHandle;
  beforeEach(async () => { handle = await createTestDb(); });
  afterEach(async () => { await closeTestDb(handle); });

  async function recovery(propertyId?: string) {
    const property = propertyId ? { id: propertyId } : await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const created = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Test recovery case for adversarial review',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    return { property, owner, ...created };
  }

  // ---------------------------------------------------------------
  // A. transitionPhase ctx.holdsToReleaseIds bypasses hold-service entirely
  // ---------------------------------------------------------------
  it('A: transitionPhase releases a manager-authority legal hold for a plain coordinator, unaudited', async () => {
    const { issue, property } = await recovery();
    const hold = await applyHold(handle.db, {
      propertyRefId: property.id,
      issueId: issue.id,
      holdType: 'legal',
      reason: 'Attorney representation asserted',
      releaseAuthority: 'manager',
      actorExternalId: 'manager-a',
    });

    const auditsBefore = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, hold.id));
    const eventsBefore = await handle.db.select().from(domainEvents).where(eq(domainEvents.eventType, 'property_operations.hold_released'));

    // A plain coordinator. releaseHold would refuse this:
    await expect(
      releaseHold(handle.db, { holdId: hold.id, releasedBy: 'coord', actorRoles: ['coordinator'], reason: 'x' }),
    ).rejects.toBeInstanceOf(HoldServiceError);

    // ...but transitionPhase does it with no authority check at all.
    await transitionPhase(handle.db, issue.id, 'legal_vs', {
      roles: ['coordinator'],
      actorExternalId: 'coordinator-a',
      holdsToReleaseIds: [hold.id],
    });

    const [reloaded] = await handle.db.select().from(holds).where(eq(holds.id, hold.id));
    console.log('A: releasedAt =', reloaded?.releasedAt, 'releasedBy =', reloaded?.releasedBy);
    expect(reloaded?.releasedAt).not.toBeNull(); // bypass succeeded

    const auditsAfter = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, hold.id));
    const eventsAfter = await handle.db.select().from(domainEvents).where(eq(domainEvents.eventType, 'property_operations.hold_released'));
    console.log('A: hold audits before/after =', auditsBefore.length, auditsAfter.length);
    console.log('A: hold_released events before/after =', eventsBefore.length, eventsAfter.length);
    expect(auditsAfter.length).toBe(auditsBefore.length); // NO audit row
    expect(eventsAfter.length).toBe(eventsBefore.length); // NO domain event
  });

  // ---------------------------------------------------------------
  // B. transitionPhase ctx.holdsToApply raw-inserts (no audit / no event)
  // ---------------------------------------------------------------
  it('B: transitionPhase applies a hold with no audit row and no hold_applied event', async () => {
    const { issue, property } = await recovery();
    const eventsBefore = await handle.db.select().from(domainEvents).where(eq(domainEvents.eventType, 'property_operations.hold_applied'));
    const res = await transitionPhase(handle.db, issue.id, 'legal_vs', {
      roles: ['coordinator'],
      holdsToApply: [{ holdType: 'legal', reason: 'applied via transition' } as never],
    });
    const applied = res.appliedHolds[0]!;
    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, applied.id));
    const eventsAfter = await handle.db.select().from(domainEvents).where(eq(domainEvents.eventType, 'property_operations.hold_applied'));
    console.log('B: audits for applied hold =', audits.length, ' hold_applied events before/after =', eventsBefore.length, eventsAfter.length);
    expect(audits.length).toBe(0);
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  // ---------------------------------------------------------------
  // C. transitionPhase ctx.tasksToCloseIds bypasses task ownership + audit
  // ---------------------------------------------------------------
  it('C: transitionPhase completes another user\'s named-assignee task with no ownership check and no audit', async () => {
    const { issue } = await recovery();
    const [t] = await handle.db.insert(tasks).values({
      issueId: issue.id, assigneeId: 'alice', title: 'Alice-only verification', dueDate: futureDate(),
    }).returning();

    // task-service refuses this for a non-owner coordinator:
    await expect(
      completeTask(handle.db, { taskId: t!.id, actorExternalId: 'bob', actorRoles: ['coordinator'], actorQueues: ['new_unreviewed'] }),
    ).rejects.toMatchObject({ code: 'task_not_authorized' });

    await transitionPhase(handle.db, issue.id, 'legal_vs', { roles: ['coordinator'], actorExternalId: 'bob', tasksToCloseIds: [t!.id] });
    const [reloaded] = await handle.db.select().from(tasks).where(eq(tasks.id, t!.id));
    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, t!.id));
    console.log('C: status =', reloaded?.status, ' audits =', audits.map((a) => a.action));
    expect(reloaded?.status).toBe('completed');
  });

  // ---------------------------------------------------------------
  // D. recordPossession(vacancy) throws HoldServiceError when an occupancy
  //    hold on the same issue has a non-matching release_authority.
  // ---------------------------------------------------------------
  it('D: a coordinator cannot record vacancy_verified when a manager-authority occupancy hold exists on that issue', async () => {
    const { issue, property } = await recovery();
    await applyHold(handle.db, {
      propertyRefId: property.id, issueId: issue.id, holdType: 'occupancy',
      reason: 'Neighbour reported occupants', actorExternalId: 'manager-a',
      // releaseAuthority unset -> defaults to manager/admin in releaseHold
    });

    let caught: unknown;
    try {
      await recordPossession(handle.db, {
        issueId: issue.id, possessionStatus: 'vacancy_verified',
        actorExternalId: 'coordinator-a', actorRoles: ['coordinator'],
      });
    } catch (e) { caught = e; }
    console.log('D: threw =', caught instanceof HoldServiceError, (caught as Error)?.constructor?.name, (caught as Error)?.message);
    expect(caught).toBeInstanceOf(HoldServiceError);
  });

  // ---------------------------------------------------------------
  // E. alreadyHeld is property-wide but release is issue-scoped
  // ---------------------------------------------------------------
  it('E: a second issue recording occupancy gets NO hold and NO review task', async () => {
    const a = await recovery();
    const b = await recovery(a.property.id);

    await recordPossession(handle.db, { issueId: a.issue.id, possessionStatus: 'occupied_or_suspected', actorExternalId: 'c-a', actorRoles: ['coordinator'] });
    await recordPossession(handle.db, { issueId: b.issue.id, possessionStatus: 'occupied_or_suspected', actorExternalId: 'c-b', actorRoles: ['coordinator'] });

    const all = await handle.db.select().from(holds).where(eq(holds.propertyRefId, a.property.id));
    const bHolds = all.filter((h) => h.issueId === b.issue.id && h.holdType === 'occupancy');
    const bTasks = (await handle.db.select().from(tasks).where(eq(tasks.issueId, b.issue.id))).filter((t) => t.title.startsWith('Verify possession'));
    console.log('E: issue-B occupancy holds =', bHolds.length, ' issue-B review tasks =', bTasks.length);
    expect(bHolds.length).toBe(0);
    expect(bTasks.length).toBe(0);

    // Now A records vacancy: releases A's hold. Property left with zero occupancy
    // holds despite B's unresolved observation.
    await recordPossession(handle.db, { issueId: a.issue.id, possessionStatus: 'vacancy_verified', actorExternalId: 'c-a', actorRoles: ['coordinator'] });
    const after = await handle.db.select().from(holds).where(eq(holds.propertyRefId, a.property.id));
    const activeOcc = after.filter((h) => h.holdType === 'occupancy' && h.releasedAt === null);
    console.log('E: active occupancy holds after A vacancy =', activeOcc.length);
    const elig = await checkReleaseEligibility(handle.db, a.property.id, { excludeIssueId: a.issue.id });
    console.log('E: blockers =', elig.blockers.map((x) => x.code));
  });

  // ---------------------------------------------------------------
  // F. P0 re-verification: full default_recovery walk to released with a
  //    'stored' possession record must be blocked.
  // ---------------------------------------------------------------
  it('F: default_recovery cannot reach released with possession=stored', async () => {
    const { issue, property } = await recovery();
    // walk to relisting
    await transitionPhase(handle.db, issue.id, 'legal_vs', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'attorney', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'recovery_review', { roles: ['coordinator'] });
    // map_link_present needed
    const { issues: issuesTable } = await import('../lib/db/schema.ts');
    await handle.db.update(issuesTable).set({ mapLink: 'https://maps.example/x' }).where(eq(issuesTable.id, issue.id));
    await transitionPhase(handle.db, issue.id, 'taking_bids', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'cleanup', { roles: ['coordinator'] });
    await recordPossession(handle.db, { issueId: issue.id, possessionStatus: 'cleared', actorExternalId: 'c', actorRoles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'relisting', { roles: ['coordinator'] });
    // now record 'stored' — negative evidence
    await recordPossession(handle.db, { issueId: issue.id, possessionStatus: 'stored', actorExternalId: 'c', actorRoles: ['coordinator'] });
    await expect(
      transitionPhase(handle.db, issue.id, 'released', { roles: ['manager'], priceReviewedAt: new Date() }),
    ).rejects.toBeInstanceOf(TransitionError);
    const recs = await handle.db.select().from(possessionRecords).where(eq(possessionRecords.propertyRefId, property.id));
    console.log('F: possession records =', recs.map((r) => r.possessionStatus));
  });
});
