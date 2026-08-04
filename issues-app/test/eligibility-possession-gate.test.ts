/**
 * eligibility-possession-gate.test.ts — regression coverage for the ROUND-2
 * P0 finding: eligibility-service.ts's possessionBlocker used to be
 * suppressed for ANY property whose open issues were all `property_legal`,
 * even when a possession_records row explicitly documented occupancy
 * (POSITIVE evidence), not merely the absence of a record. That let a
 * property with occupants/personal property on site pass a `gates_release`
 * transition to `released` with no blocker, no denial audit, and no UI
 * warning — violating DESIGN.md's safety core ("no property may pass
 * release while ... unresolved possession ... exists" is a property-level
 * statement, not scoped to a particular issue type).
 *
 * BEFORE this fix: all three tests below FAIL (transitions succeed /
 * blockers come back empty where they must not).
 * AFTER this fix: all three PASS.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { createIssue } from '../lib/services/issue-service.ts';
import { transitionPhase, TransitionError } from '../lib/services/transition-engine.ts';
import { recordPossession } from '../lib/services/possession-service.ts';
import { checkReleaseEligibility } from '../lib/services/eligibility-service.ts';
import { issues, phaseInstances } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('eligibility-service: possessionBlocker is evidence-driven, not issue-type-scoped (P0 regression)', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('REGRESSION 1: a property_legal release is blocked once possession is recorded as occupied_or_suspected', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'property_legal',
      propertyRefId: property.id,
      summary: 'Boundary dispute',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    await recordPossession(handle.db, { issueId: issue.id, possessionStatus: 'occupied_or_suspected', actorRoles: ['coordinator'] });

    await transitionPhase(handle.db, issue.id, 'legal_review', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'resolution', { roles: ['manager'] });

    // Must NOT reach `released` while possession is positively unresolved —
    // either the occupancy hold (no_blocking_holds) or the possession
    // blocker itself must stop this.
    await expect(transitionPhase(handle.db, issue.id, 'released', { roles: ['manager'] })).rejects.toBeInstanceOf(TransitionError);
  });

  it('REGRESSION 2: checkReleaseEligibility reports possession_unresolved for a property_legal-only property with a negative possession record', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'property_legal',
      propertyRefId: property.id,
      summary: 'Boundary dispute',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    await recordPossession(handle.db, { issueId: issue.id, possessionStatus: 'personal_property_present', actorRoles: ['coordinator'] });

    const result = await checkReleaseEligibility(handle.db, property.id, { excludeIssueId: issue.id });
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
  });

  it('REGRESSION 3: a CLOSED default_recovery issue documenting occupied_or_suspected still blocks release under an unrelated open property_legal issue', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);

    const recovery = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Prior recovery case (documents occupancy)',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    await recordPossession(handle.db, { issueId: recovery.issue.id, possessionStatus: 'occupied_or_suspected', actorRoles: ['coordinator'] });
    // Directly mark the recovery issue's lifecycle_status closed (no
    // command in this lane closes an issue standalone outside a full
    // transition walk to `closed`) so it is no longer among the property's
    // "open issues" possessionRequired/openIssuePhaseBlockers consider —
    // exactly the finding's trigger #3 shape: a CLOSED issue that
    // documents occupancy, plus one open property_legal issue.
    await handle.db.update(issues).set({ lifecycleStatus: 'closed' }).where(eq(issues.id, recovery.issue.id));

    const { issue: legal } = await createIssue(handle.db, {
      issueType: 'property_legal',
      propertyRefId: property.id,
      summary: 'Separate legal matter, unrelated to the recovery case',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    const result = await checkReleaseEligibility(handle.db, property.id, { excludeIssueId: legal.id });
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
  });

  it.each(['unknown', 'removal_authorized', 'stored', 'transferred', 'disposed'] as const)(
    'REGRESSION (round 3): checkReleaseEligibility reports possession_unresolved for a property_legal-only property with possessionStatus=%s (the 5 statuses the round-2 negative-list omitted)',
    async (possessionStatus) => {
      const property = await makeProperty(handle.db);
      const owner = await makePerson(handle.db);
      const { issue } = await createIssue(handle.db, {
        issueType: 'property_legal',
        propertyRefId: property.id,
        summary: 'Boundary dispute',
        people: [{ personRefId: owner.id, role: 'owner' }],
        initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
      });

      await recordPossession(handle.db, { issueId: issue.id, possessionStatus, actorRoles: ['coordinator'] });

      const result = await checkReleaseEligibility(handle.db, property.id, { excludeIssueId: issue.id });
      expect(result.eligible).toBe(false);
      expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
    },
  );

  it('REGRESSION (round 3): a property_legal transition to released is blocked when possession is "removal_authorized" (authorization to remove is not removal)', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'property_legal',
      propertyRefId: property.id,
      summary: 'Boundary dispute',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    await recordPossession(handle.db, { issueId: issue.id, possessionStatus: 'removal_authorized', actorRoles: ['coordinator'] });

    await transitionPhase(handle.db, issue.id, 'legal_review', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'resolution', { roles: ['manager'] });

    await expect(transitionPhase(handle.db, issue.id, 'released', { roles: ['manager'] })).rejects.toBeInstanceOf(TransitionError);

    // Confirm the property never actually reached `released` — the reject
    // assertion above proves the command failed, this proves no partial
    // state change slipped through despite it.
    const [phaseInstance] = await handle.db
      .select()
      .from(phaseInstances)
      .where(eq(phaseInstances.issueId, issue.id))
      .orderBy(desc(phaseInstances.createdAt))
      .limit(1);
    expect(phaseInstance?.phaseKey).not.toBe('released');
  });

  it('does NOT weaken the existing no-record property_legal skip: no possession record at all is still not blocked', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'property_legal',
      propertyRefId: property.id,
      summary: 'Boundary dispute, no possession evidence either way',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    const result = await checkReleaseEligibility(handle.db, property.id, { excludeIssueId: issue.id });
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(false);
  });
});
