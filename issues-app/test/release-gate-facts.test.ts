/**
 * release-gate-facts.test.ts — regression coverage for the "release-track
 * workflow is structurally unreachable" adversarial-review finding:
 *
 *  1. issue-service.recordPriceReview: the new standalone write path for
 *     issues.price_reviewed_at.
 *  2. transitionPhase's ordering fix: ctx.priceReviewedAt passed on a
 *     transitionPhase call now satisfies THAT SAME call's own
 *     price_review_complete prerequisite / gates_release eligibility check,
 *     instead of only ever helping a strictly later, separate call.
 *  3. eligibility-service's possessionBlocker is now scoped to
 *     default_recovery/market_readiness issues, so a property_legal release
 *     is no longer blocked by an unrelated vacancy/possession check its own
 *     transition never names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { recordPriceReview } from '../lib/services/issue-service.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { transitionPhase } from '../lib/services/transition-engine.ts';
import { recordPossession } from '../lib/services/possession-service.ts';
import { checkReleaseEligibility } from '../lib/services/eligibility-service.ts';
import { auditEvents, issues } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('release-gate facts: recordPriceReview', () => {
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

  it('rejects an unknown issue id', async () => {
    await expect(
      recordPriceReview(handle.db, { issueId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ code: 'issue_validation_failed' });
  });

  it('writes issues.price_reviewed_at and audits it', async () => {
    const { issue } = await baseIssue();
    expect(issue.priceReviewedAt).toBeNull();

    const updated = await recordPriceReview(handle.db, { issueId: issue.id, actorExternalId: 'coordinator-a', actorRoles: ['coordinator'] });
    expect(updated.priceReviewedAt).not.toBeNull();

    const [reloaded] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(reloaded?.priceReviewedAt).not.toBeNull();

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, issue.id));
    expect(audits.some((a) => a.action === 'price_review_recorded')).toBe(true);
  });
});

describe('release-gate facts: transitionPhase ordering fix (ctx.priceReviewedAt on the SAME call)', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('ADVERSARIAL-REVIEW REGRESSION: a same-call ctx.priceReviewedAt satisfies that same call\'s price_review_complete prerequisite', async () => {
    // Walk a real default_recovery issue all the way to relisting -> released
    // (the seeded v2 transition that names BOTH no_blocking_holds,
    // vacancy_verified, AND price_review_complete, and gates_release) using
    // ONLY the shipped command layer: transitionPhase + recordPossession +
    // the map_link/coordinator supplied at intake. Before the ordering fix,
    // passing ctx.priceReviewedAt on this exact call still failed with
    // "no price review has ever been recorded" because the prerequisite
    // checker read the issue row fetched before ctx.priceReviewedAt was
    // ever applied.
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Full recovery walk',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
      mapLink: 'https://maps.example.com/full-walk',
    });

    await transitionPhase(handle.db, issue.id, 'recovery_review', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'taking_bids', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'cleanup', { roles: ['coordinator'] });
    await recordPossession(handle.db, { issueId: issue.id, possessionStatus: 'cleared', actorRoles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'relisting', { roles: ['coordinator'] });

    // The final hop names price_review_complete AND gates_release together
    // — this is the exact call the finding says can never succeed via
    // ctx.priceReviewedAt passed on itself.
    const result = await transitionPhase(handle.db, issue.id, 'released', {
      roles: ['coordinator'],
      priceReviewedAt: new Date(),
    });
    expect(result.newPhase.phaseKey).toBe('released');
  });
});

describe('release-gate facts: possessionBlocker is scoped away from property_legal', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('ADVERSARIAL-REVIEW REGRESSION: a property_legal release is not blocked by an unresolved vacancy/possession check', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'property_legal',
      propertyRefId: property.id,
      summary: 'Boundary dispute',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
    // No possession_records row ever created for this property.

    const result = await checkReleaseEligibility(handle.db, property.id, { excludeIssueId: issue.id });
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(false);

    // And the full command-layer walk (legal_review -> resolution -> released)
    // succeeds without ever touching possession_records at all.
    await transitionPhase(handle.db, issue.id, 'legal_review', { roles: ['coordinator'] });
    await transitionPhase(handle.db, issue.id, 'resolution', { roles: ['manager'] });
    const released = await transitionPhase(handle.db, issue.id, 'released', { roles: ['manager'] });
    expect(released.newPhase.phaseKey).toBe('released');
  });

  it('a default_recovery release is STILL blocked by unresolved possession (scoping does not weaken the existing protection)', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Still needs vacancy verification',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
  });
});
