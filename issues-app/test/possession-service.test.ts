/**
 * possession-service.test.ts — direct coverage for the possession-records
 * write path added by this review (previously there was NO command
 * anywhere in lib/services/ that could write possession_records at all —
 * only test fixtures inserted into it directly, which is exactly what made
 * the release-track workflow structurally unreachable through the shipped
 * command layer for any real property).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { recordPossession, PossessionServiceError } from '../lib/services/possession-service.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { IssueAuthorizationError } from '../lib/services/issue-authz.ts';
import { auditEvents, domainEvents, holds, possessionRecords } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('possession-service: recordPossession', () => {
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

  it('rejects with no issueId', async () => {
    await expect(recordPossession(handle.db, { issueId: '', possessionStatus: 'cleared' })).rejects.toMatchObject({
      code: 'issue_id_required',
    });
  });

  it('rejects an unknown issue id', async () => {
    await expect(
      recordPossession(handle.db, { issueId: '00000000-0000-0000-0000-000000000000', possessionStatus: 'cleared' }),
    ).rejects.toMatchObject({ code: 'issue_not_found' });
  });

  it('records a possession observation, audits it, and stamps the property from the issue', async () => {
    const { issue, property } = await baseIssue();

    const record = await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'vacancy_verified',
      notes: 'Confirmed vacant on drive-by',
      actorExternalId: 'coordinator-a',
      actorRole: 'coordinator',
      actorRoles: ['coordinator'],
    });

    expect(record.propertyRefId).toBe(property.id);
    expect(record.possessionStatus).toBe('vacancy_verified');

    const [reloaded] = await handle.db.select().from(possessionRecords).where(eq(possessionRecords.id, record.id));
    expect(reloaded?.possessionStatus).toBe('vacancy_verified');

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, record.id));
    const audit = audits.find((a) => a.action === 'possession_recorded');
    expect(audit).toBeDefined();
    expect(audit?.actorExternalId).toBe('coordinator-a');
  });

  it('is append-only: a second observation adds a new row rather than mutating the first', async () => {
    const { issue } = await baseIssue();
    const first = await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'vacancy_unverified',
      actorRoles: ['coordinator'],
    });
    const second = await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'vacancy_verified',
      actorRoles: ['coordinator'],
    });

    expect(first.id).not.toBe(second.id);
    const all = await handle.db.select().from(possessionRecords).where(eq(possessionRecords.issueId, issue.id));
    expect(all).toHaveLength(2);
  });

  it('ADVERSARIAL-REVIEW REGRESSION (round 2, P1 IDOR): rejects an actor with no coordinator/manager/admin role, even for a valid issue', async () => {
    const { issue } = await baseIssue();

    await expect(
      recordPossession(handle.db, {
        issueId: issue.id,
        possessionStatus: 'vacancy_verified',
        actorExternalId: 'sales-user',
        actorRole: 'sales',
        actorRoles: ['sales'],
      }),
    ).rejects.toBeInstanceOf(IssueAuthorizationError);

    // Must not have written anything — the whole point of the check is to
    // reject BEFORE any write.
    const all = await handle.db.select().from(possessionRecords).where(eq(possessionRecords.issueId, issue.id));
    expect(all).toHaveLength(0);
  });

  it('rejects with no actorRoles at all (the pre-fix shape every unauthenticated/misconfigured caller would have produced)', async () => {
    const { issue } = await baseIssue();
    await expect(recordPossession(handle.db, { issueId: issue.id, possessionStatus: 'vacancy_verified' })).rejects.toBeInstanceOf(
      IssueAuthorizationError,
    );
  });

  it('ADVERSARIAL-REVIEW REGRESSION (P2 / P0 companion, spec §29.6): a negative possession status creates a blocking occupancy hold and a review task', async () => {
    const { issue, property } = await baseIssue();

    await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'occupied_or_suspected',
      actorExternalId: 'coordinator-a',
      actorRoles: ['coordinator'],
    });

    const activeHolds = await handle.db.select().from(holds).where(eq(holds.propertyRefId, property.id));
    const occupancyHold = activeHolds.find((h) => h.holdType === 'occupancy');
    expect(occupancyHold).toBeDefined();
    expect(occupancyHold?.releasedAt).toBeNull();
  });

  it('a later vacancy_verified observation releases the occupancy hold a prior negative observation created', async () => {
    const { issue, property } = await baseIssue();

    await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'occupied_or_suspected',
      actorExternalId: 'coordinator-a',
      actorRoles: ['coordinator'],
    });
    await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'vacancy_verified',
      actorExternalId: 'coordinator-a',
      actorRoles: ['coordinator'],
    });

    const activeHolds = await handle.db.select().from(holds).where(eq(holds.propertyRefId, property.id));
    const occupancyHold = activeHolds.find((h) => h.holdType === 'occupancy');
    expect(occupancyHold?.releasedAt).not.toBeNull();
  });

  it('REGRESSION (round 3, P1): superseding a possession-created occupancy hold routes through hold-service.releaseHold, so it is audited and publishes hold_released', async () => {
    const { issue, property } = await baseIssue();

    await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'occupied_or_suspected',
      actorExternalId: 'coordinator-a',
      actorRoles: ['coordinator'],
    });

    const activeHolds = await handle.db.select().from(holds).where(eq(holds.propertyRefId, property.id));
    const occupancyHold = activeHolds.find((h) => h.holdType === 'occupancy');
    expect(occupancyHold).toBeDefined();

    // Snapshot before the superseding call so we can assert on NEW rows only.
    const auditsBefore = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, occupancyHold!.id));
    const domainEventsBefore = await handle.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.eventType, 'property_operations.hold_released'));

    await recordPossession(handle.db, {
      issueId: issue.id,
      possessionStatus: 'vacancy_verified',
      actorExternalId: 'coordinator-a',
      actorRoles: ['coordinator'],
    });

    // BEFORE this fix: possession-service called holdsRepo.release directly,
    // so neither of these rows would exist — the hold would flip to
    // released with zero trace in audit_events or domain_events.
    const auditsAfter = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, occupancyHold!.id));
    const releaseAudit = auditsAfter.find((a) => a.action === 'hold_released');
    expect(releaseAudit).toBeDefined();
    expect(auditsAfter.length).toBeGreaterThan(auditsBefore.length);

    const domainEventsAfter = await handle.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.eventType, 'property_operations.hold_released'));
    expect(domainEventsAfter.length).toBeGreaterThan(domainEventsBefore.length);
    expect(domainEventsAfter.some((e) => e.payload && (e.payload as { holdId?: string }).holdId === occupancyHold!.id)).toBe(true);
  });

  it('REGRESSION (round 3, P1): a resolved observation on one issue does NOT release an occupancy hold raised by a different issue on the same property', async () => {
    const { issue: issueA, property } = await baseIssue();
    const owner = await makePerson(handle.db);
    const { issue: issueB } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Second, unrelated recovery case on the same property',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    await recordPossession(handle.db, {
      issueId: issueA.id,
      possessionStatus: 'occupied_or_suspected',
      actorExternalId: 'coordinator-a',
      actorRoles: ['coordinator'],
    });

    // A coordinator records vacancy_verified on the UNRELATED issue B for
    // the same property — must NOT release issue A's occupancy hold.
    await recordPossession(handle.db, {
      issueId: issueB.id,
      possessionStatus: 'vacancy_verified',
      actorExternalId: 'coordinator-b',
      actorRoles: ['coordinator'],
    });

    const activeHolds = await handle.db.select().from(holds).where(eq(holds.propertyRefId, property.id));
    const occupancyHold = activeHolds.find((h) => h.holdType === 'occupancy' && h.issueId === issueA.id);
    expect(occupancyHold?.releasedAt).toBeNull();
  });
});
