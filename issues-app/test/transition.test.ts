import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { transitionPhase, TransitionError, IMPLEMENTED_PREREQUISITE_NAMES } from '../lib/services/transition-engine.ts';
import type { TransitionDefinition } from '../lib/services/transition-engine.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { applyHold } from '../lib/services/hold-service.ts';
import { auditEvents, bids, configEntries, configVersions, issues, phaseInstances, possessionRecords, vendors } from '../lib/db/schema.ts';
import * as configRepo from '../lib/repositories/config-repo.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('transition-engine', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function baseIssue() {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const created = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Test recovery case',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    return { property, owner, ...created };
  }

  it('executes an allowed transition, writing a new phase_instances row and an audit row', async () => {
    const { issue, phaseInstance: intakePhase } = await baseIssue();

    const result = await transitionPhase(handle.db, issue.id, 'legal_vs', { roles: ['coordinator'], actorId: null, reason: 'starting legal/VS review' });

    expect(result.newPhase.phaseKey).toBe('legal_vs');
    expect(result.newPhase.status).toBe('open');
    expect(result.previousPhase.id).toBe(intakePhase.id);
    expect(result.previousPhase.status).toBe('completed');
    expect(result.issue.currentPhaseInstanceId).toBe(result.newPhase.id);

    const [reloadedIntakePhase] = await handle.db.select().from(phaseInstances).where(eq(phaseInstances.id, intakePhase.id));
    expect(reloadedIntakePhase?.status).toBe('completed');
    expect(reloadedIntakePhase?.endedAt).not.toBeNull();

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, issue.id));
    const transitionAudit = audits.find((a) => a.action === 'phase_transitioned');
    expect(transitionAudit).toBeDefined();
    expect(transitionAudit?.reason).toBe('starting legal/VS review');
  });

  it('rejects a disallowed transition with a typed error listing available destinations', async () => {
    const { issue } = await baseIssue();

    await expect(transitionPhase(handle.db, issue.id, 'cleanup', { roles: ['coordinator'] })).rejects.toMatchObject({
      name: 'TransitionError',
      code: 'disallowed_transition',
    });

    try {
      await transitionPhase(handle.db, issue.id, 'cleanup', { roles: ['coordinator'] });
      expect.unreachable('expected transitionPhase to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      const transitionErr = err as TransitionError;
      expect(transitionErr.reasons).toEqual(expect.arrayContaining(['legal_vs', 'recovery_review']));
    }
  });

  it('rechecks role permission server-side and rejects an unauthorized role', async () => {
    const { issue } = await baseIssue();

    await expect(transitionPhase(handle.db, issue.id, 'legal_vs', { roles: ['sales'] })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rejects when a named prerequisite is not met (people_linked)', async () => {
    const property = await makeProperty(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Case with no linked people yet',
      noPeopleException: 'Owner contact not yet identified from loan default feed',
      initialTask: { title: 'Identify owner', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    await expect(transitionPhase(handle.db, issue.id, 'legal_vs', { roles: ['coordinator'] })).rejects.toMatchObject({
      code: 'prerequisites_not_met',
    });
  });

  it('leaves the issue in its original phase after a rejected transition (atomicity)', async () => {
    const { issue, phaseInstance } = await baseIssue();

    await expect(transitionPhase(handle.db, issue.id, 'cleanup', { roles: ['coordinator'] })).rejects.toThrow();

    const [reloaded] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(reloaded?.currentPhaseInstanceId).toBe(phaseInstance.id);
  });

  it('enforces two_complete_bids_if_over_threshold using the threshold amount from config', async () => {
    // Publish a new, superseding config version whose default_recovery
    // transitions include the two_complete_bids_if_over_threshold
    // prerequisite, and whose threshold is set to a value convenient for
    // this test. config-as-data (spec §12) means this is exactly how an
    // admin would introduce/tune such a rule; it does not touch the
    // shipped seed migration.
    const [version] = await handle.db
      .insert(configVersions)
      .values({ configKey: 'phase_1_defaults', versionLabel: 'test-two-bid', effectiveFrom: new Date() })
      .returning();
    await handle.db.insert(configEntries).values([
      {
        configVersionId: version!.id,
        entryKey: 'transitions',
        entryValue: {
          default_recovery: [
            {
              from_phase: 'intake',
              to_phase: 'taking_bids',
              prerequisites: ['two_complete_bids_if_over_threshold'],
              description: 'test-only direct jump for threshold enforcement',
            },
          ],
        },
      },
      {
        configVersionId: version!.id,
        entryKey: 'thresholds',
        entryValue: { second_bid_threshold_usd: 1000 },
      },
    ]);
    configRepo.clearCache();

    const { issue } = await baseIssue();
    const vendorPerson = await makePerson(handle.db, { kind: 'org', displayName: 'Vendor A' });
    const [vendor] = await handle.db.insert(vendors).values({ personRefId: vendorPerson.id, displayName: 'Vendor A' }).returning();

    // One bid at $1,200 (over the $1,000 threshold), status 'submitted' (not complete) -> should block.
    await handle.db.insert(bids).values({ issueId: issue.id, vendorId: vendor!.id, scope: 'Cleanup', amountCents: 120000, status: 'submitted' });

    await expect(transitionPhase(handle.db, issue.id, 'taking_bids', { roles: ['coordinator'] })).rejects.toMatchObject({
      code: 'prerequisites_not_met',
    });

    // A second complete bid brings it to 2 complete bids over threshold -> should pass.
    await handle.db.insert(bids).values({ issueId: issue.id, vendorId: vendor!.id, scope: 'Cleanup', amountCents: 130000, status: 'complete' });
    await handle.db.insert(bids).values({ issueId: issue.id, vendorId: vendor!.id, scope: 'Cleanup', amountCents: 140000, status: 'accepted' });

    const result = await transitionPhase(handle.db, issue.id, 'taking_bids', { roles: ['coordinator'] });
    expect(result.newPhase.phaseKey).toBe('taking_bids');
  });

  it('does not require a second bid when the top bid is under threshold', async () => {
    const [version] = await handle.db
      .insert(configVersions)
      .values({ configKey: 'phase_1_defaults', versionLabel: 'test-two-bid-under', effectiveFrom: new Date() })
      .returning();
    await handle.db.insert(configEntries).values([
      {
        configVersionId: version!.id,
        entryKey: 'transitions',
        entryValue: {
          default_recovery: [
            {
              from_phase: 'intake',
              to_phase: 'taking_bids',
              prerequisites: ['two_complete_bids_if_over_threshold'],
            },
          ],
        },
      },
      {
        configVersionId: version!.id,
        entryKey: 'thresholds',
        entryValue: { second_bid_threshold_usd: 1000 },
      },
    ]);
    configRepo.clearCache();

    const { issue } = await baseIssue();
    const vendorPerson = await makePerson(handle.db, { kind: 'org', displayName: 'Vendor B' });
    const [vendor] = await handle.db.insert(vendors).values({ personRefId: vendorPerson.id, displayName: 'Vendor B' }).returning();
    await handle.db.insert(bids).values({ issueId: issue.id, vendorId: vendor!.id, scope: 'Cleanup', amountCents: 50000, status: 'submitted' });

    const result = await transitionPhase(handle.db, issue.id, 'taking_bids', { roles: ['coordinator'] });
    expect(result.newPhase.phaseKey).toBe('taking_bids');
  });

  describe('gates_release (adversarial-review fix: release path must consult eligibility-service)', () => {
    async function supersedingGatesReleaseConfig() {
      const [version] = await handle.db
        .insert(configVersions)
        .values({ configKey: 'phase_1_defaults', versionLabel: 'test-gates-release', effectiveFrom: new Date() })
        .returning();
      await handle.db.insert(configEntries).values({
        configVersionId: version!.id,
        entryKey: 'transitions',
        entryValue: {
          default_recovery: [
            {
              from_phase: 'intake',
              to_phase: 'released',
              prerequisites: [],
              gates_release: true,
              description: 'test-only direct jump for the gates_release fix',
            },
          ],
        },
      });
      configRepo.clearCache();
    }

    it('OPS-MV-002 / §28.3: blocks a gates_release transition when the property is not eligible, and audits the denial', async () => {
      await supersedingGatesReleaseConfig();
      const { issue, property, phaseInstance } = await baseIssue();
      await applyHold(handle.db, { propertyRefId: property.id, holdType: 'legal', reason: 'Pending litigation' });

      await expect(transitionPhase(handle.db, issue.id, 'released', { roles: ['coordinator'] })).rejects.toMatchObject({
        code: 'not_eligible',
      });

      // The issue never actually reached `released`.
      const [reloaded] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
      expect(reloaded?.currentPhaseInstanceId).toBe(phaseInstance.id);

      const denialAudits = await handle.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.objectId, issue.id), eq(auditEvents.action, 'phase_transition_denied')));
      expect(denialAudits.length).toBeGreaterThanOrEqual(1);
    });

    it('allows the gates_release transition once the property clears eligibility (possession verified, map link + price review recorded, no other open gating issue)', async () => {
      await supersedingGatesReleaseConfig();
      const { issue, property } = await baseIssue();

      // Clear every eligibility blocker for this property/issue. map_link
      // and price_reviewed_at are Property-Operations-owned facts on the
      // issue itself (see 20260731090400 migration); the issue BEING
      // transitioned is excluded from the "still-open gating issue" check
      // by transitionPhase's gates_release logic (excludeIssueId) since no
      // OTHER release-gating issue exists on this property.
      await handle.db
        .update(issues)
        .set({ mapLink: 'https://maps.example.com/x', priceReviewedAt: new Date() })
        .where(eq(issues.id, issue.id));
      await handle.db.insert(possessionRecords).values({ issueId: issue.id, propertyRefId: property.id, possessionStatus: 'cleared' });

      const result = await transitionPhase(handle.db, issue.id, 'released', { roles: ['coordinator'] });
      expect(result.newPhase.phaseKey).toBe('released');
    });
  });

  it('every prerequisite name in the currently-effective config "transitions" entry resolves to a real checker', async () => {
    // Guards the transition-engine/seed-config coupling: a typo'd or
    // newly-added prerequisite name in a future migration would otherwise
    // only be caught at runtime, on whichever transition first exercises
    // it (fail-closed per transitionPhase's 'unimplemented_prerequisite'
    // error) — possibly in production. Reads the SAME currently-effective
    // version transitionPhase itself reads (configRepo.get), so this
    // matches actual runtime resolution rather than also flagging
    // superseded (effective_to-less but out-ranked) older versions that
    // transitionPhase never selects.
    const byIssueType = await configRepo.get<Record<string, TransitionDefinition[]>>(handle.db, 'phase_1_defaults', 'transitions');
    expect(byIssueType).toBeDefined();

    const unresolved: string[] = [];
    for (const [issueType, defs] of Object.entries(byIssueType ?? {})) {
      for (const def of defs) {
        for (const name of def.prerequisites ?? []) {
          if (!IMPLEMENTED_PREREQUISITE_NAMES.has(name)) {
            unresolved.push(`${issueType}: ${def.from_phase} -> ${def.to_phase}: "${name}"`);
          }
        }
      }
    }

    expect(unresolved).toEqual([]);
  });
});
