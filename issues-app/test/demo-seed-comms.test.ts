/**
 * demo-seed-comms.test.ts — idempotency regression coverage for
 * scripts/demo-seed-comms.ts's seedDemoComms(). Before the fix, a second
 * run against an already-seeded database crashed on the very first insert
 * via communication_events_provider_dedup_idx (provider_event_id was a
 * per-run counter that always restarted at 1), and nothing wrapped the
 * inserts in a transaction, so an interrupted rerun could commit a
 * partially-duplicated database.
 *
 * FAILS before the fix: the second seedDemoComms(db) call throws a unique
 * constraint violation. PASSES after: reruns are a safe delete-and-refresh
 * (row counts stay stable, not doubled).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDemoComms } from '../scripts/demo-seed-comms.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { communicationEvents, communicationLinks } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

async function seedFixtureIssue(db: TestDb) {
  const property = await makeProperty(db);
  const owner = await makePerson(db, { displayName: 'Demo Owner' });
  const { issue } = await createIssue(db, {
    issueType: 'covenant_violation',
    propertyRefId: property.id,
    summary: 'Fixture case for demo-seed-comms idempotency coverage',
    people: [{ personRefId: owner.id, role: 'owner' }],
    initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    actorExternalId: 'test-seeder',
    actorRole: 'coordinator',
  });
  return { property, owner, issue };
}

describe('seedDemoComms idempotency', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('returns null (no crash) when there are no issue_people rows to seed against', async () => {
    const result = await seedDemoComms(handle.db);
    expect(result).toBeNull();
  });

  it('running twice against the same seeded database does not throw and does not duplicate rows', async () => {
    await seedFixtureIssue(handle.db);

    const first = await seedDemoComms(handle.db);
    expect(first).not.toBeNull();
    expect(first!.commsInserted).toBeGreaterThan(0);

    const eventsAfterFirst = await handle.db.select().from(communicationEvents);
    const linksAfterFirst = await handle.db.select().from(communicationLinks);
    expect(eventsAfterFirst.length).toBe(first!.commsInserted);

    // The regression: this used to throw
    // "duplicate key value violates unique constraint
    // communication_events_provider_dedup_idx" on the very first insert.
    await expect(seedDemoComms(handle.db)).resolves.not.toThrow();

    const second = await seedDemoComms(handle.db);
    expect(second).not.toBeNull();

    const eventsAfterRerun = await handle.db.select().from(communicationEvents);
    const linksAfterRerun = await handle.db.select().from(communicationLinks);

    // Idempotent: a rerun replaces, not appends — row counts stay stable
    // rather than growing with each invocation.
    expect(eventsAfterRerun.length).toBe(eventsAfterFirst.length);
    expect(linksAfterRerun.length).toBe(linksAfterFirst.length);
  });

  it('every seeded communication_event carries a unique provider_event_id within a single run', async () => {
    await seedFixtureIssue(handle.db);
    await seedDemoComms(handle.db);

    const events = await handle.db.select().from(communicationEvents).where(eq(communicationEvents.providerSystem, 'demo-seed-comms'));
    const ids = events.map((e) => e.providerEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
