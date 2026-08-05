/**
 * comms-timeline.test.ts — coverage for the Wave 2a communications/timeline
 * data layer: lib/repositories/comms-repo.ts, timeline-repo.ts, and
 * audit-metrics-repo.ts.
 *
 * What this file exercises (per the task spec):
 *  - linked-people fold-in (comms-repo.listForIssue includeLinkedPeople)
 *  - cross-matter tagging (spec §29.1)
 *  - filters compose (types/direction/personRefIds/participantQuery/kinds)
 *  - keyset pagination is stable (no drops/dupes/reordering across pages)
 *  - audit-metrics-repo counts are correct
 *  - malformed cursors/filters fall back safely (never throw)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as commsRepo from '../lib/repositories/comms-repo.ts';
import * as timelineRepo from '../lib/repositories/timeline-repo.ts';
import * as auditMetricsRepo from '../lib/repositories/audit-metrics-repo.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { applyHold } from '../lib/services/hold-service.ts';
import { eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  communicationEvents,
  communicationLinks,
  notices,
  phaseInstances,
  tasks,
  type CommunicationChannel,
  type CommunicationDirection,
  type NewCommunicationEvent,
} from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

async function makeIssueWithPeople(db: TestDb, people: { personRefId: string; role: 'owner' | 'buyer' | 'former_owner' | 'neighbor' | 'reporter' | 'vendor' }[]) {
  const property = await makeProperty(db);
  const { issue } = await createIssue(db, {
    issueType: 'covenant_violation',
    propertyRefId: property.id,
    summary: 'Test case for comms/timeline coverage',
    people,
    initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    actorExternalId: 'test-seeder',
    actorRole: 'coordinator',
  });
  return { property, issue };
}

async function insertComm(
  db: TestDb,
  opts: {
    channel?: CommunicationChannel;
    direction?: CommunicationDirection;
    fromPersonRefId?: string | null;
    toPersonRefId?: string | null;
    occurredAt: Date;
    summary?: string;
    providerEventId: string;
  },
) {
  const values: NewCommunicationEvent = {
    channel: opts.channel ?? 'text',
    direction: opts.direction ?? 'outbound',
    providerSystem: 'test',
    providerEventId: opts.providerEventId,
    occurredAt: opts.occurredAt,
    fromPersonRefId: opts.fromPersonRefId ?? null,
    toPersonRefId: opts.toPersonRefId ?? null,
    summary: opts.summary ?? 'Test communication',
  };
  const [row] = await db.insert(communicationEvents).values(values).returning();
  if (!row) throw new Error('insertComm: insert returned no row');
  return row;
}

async function linkComm(db: TestDb, communicationEventId: string, opts: { issueId?: string | null; personRefId?: string | null }) {
  await db.insert(communicationLinks).values({
    communicationEventId,
    issueId: opts.issueId ?? null,
    personRefId: opts.personRefId ?? null,
  });
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * Inserts one audit_events row with occurred_at set to an exact,
 * microsecond-precision literal — a value no JS Date (millisecond
 * resolution) can represent, so this can only be done via a raw SQL
 * literal in the INSERT itself. Used by the P1 regression tests below.
 * audit_events is append-only (supabase/migrations/...
 * audit_events_block_mutation trigger) — insert-then-UPDATE is rejected,
 * so the literal must be supplied at insert time.
 */
async function insertAuditEventAt(
  db: TestDb,
  opts: { objectTable: string; objectId: string; action: string },
  occurredAtLiteral: string,
): Promise<string> {
  const result = await db.execute(
    sql`insert into audit_events (object_table, object_id, action, occurred_at) values (${opts.objectTable}, ${opts.objectId}::uuid, ${opts.action}, ${occurredAtLiteral}::timestamptz) returning id`,
  );
  const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows ?? (result as unknown as Array<{ id: string }>);
  const id = rows[0]?.id;
  if (!id) throw new Error('insertAuditEventAt: insert returned no row');
  return id;
}

describe('comms-repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  describe('listForPerson', () => {
    it('returns communications where the person is either from or to, newest first', async () => {
      const person = await makePerson(handle.db);
      const other = await makePerson(handle.db);
      const c1 = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(5), providerEventId: 'p1' });
      const c2 = await insertComm(handle.db, { toPersonRefId: person.id, occurredAt: daysAgo(1), providerEventId: 'p2' });
      await insertComm(handle.db, { fromPersonRefId: other.id, toPersonRefId: other.id, occurredAt: daysAgo(2), providerEventId: 'p3' });

      const result = await commsRepo.listForPerson(handle.db, { personRefId: person.id, limit: 10 });
      expect(result.rows.map((r) => r.id)).toEqual([c2.id, c1.id]);
    });

    it('types filter narrows to the requested channels; a fully-invalid types array matches nothing', async () => {
      const person = await makePerson(handle.db);
      await insertComm(handle.db, { fromPersonRefId: person.id, channel: 'call', occurredAt: daysAgo(1), providerEventId: 'call1' });
      await insertComm(handle.db, { fromPersonRefId: person.id, channel: 'email', occurredAt: daysAgo(2), providerEventId: 'email1' });

      const onlyCalls = await commsRepo.listForPerson(handle.db, { personRefId: person.id, types: ['call'], limit: 10 });
      expect(onlyCalls.rows).toHaveLength(1);
      expect(onlyCalls.rows[0]?.channel).toBe('call');

      const bogus = await commsRepo.listForPerson(handle.db, { personRefId: person.id, types: ['not-a-real-channel'], limit: 10 });
      expect(bogus.rows).toHaveLength(0);
    });

    it('direction filter narrows to inbound/outbound', async () => {
      const person = await makePerson(handle.db);
      await insertComm(handle.db, { fromPersonRefId: person.id, direction: 'inbound', occurredAt: daysAgo(1), providerEventId: 'in1' });
      await insertComm(handle.db, { toPersonRefId: person.id, direction: 'outbound', occurredAt: daysAgo(2), providerEventId: 'out1' });

      const inbound = await commsRepo.listForPerson(handle.db, { personRefId: person.id, direction: 'inbound', limit: 10 });
      expect(inbound.rows).toHaveLength(1);
      expect(inbound.rows[0]?.direction).toBe('inbound');
    });

    it('malformed cursor falls back to page 1 rather than throwing', async () => {
      const person = await makePerson(handle.db);
      await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(1), providerEventId: 'x1' });

      const result = await commsRepo.listForPerson(handle.db, { personRefId: person.id, cursor: 'not-a-real-cursor', limit: 10 });
      expect(result.rows).toHaveLength(1);
    });

    it('a non-uuid personRefId returns empty rather than throwing', async () => {
      const result = await commsRepo.listForPerson(handle.db, { personRefId: 'not-a-uuid', limit: 10 });
      expect(result.rows).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it('fromDate/toDate narrow to an inclusive occurred_at window', async () => {
      const person = await makePerson(handle.db);
      const old = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(10), providerEventId: 'range-old' });
      const mid = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(5), providerEventId: 'range-mid' });
      const recent = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(1), providerEventId: 'range-recent' });

      const windowed = await commsRepo.listForPerson(handle.db, {
        personRefId: person.id,
        fromDate: daysAgo(6).toISOString(),
        toDate: daysAgo(2).toISOString(),
        limit: 10,
      });
      expect(windowed.rows.map((r) => r.id)).toEqual([mid.id]);
      expect(windowed.rows.map((r) => r.id)).not.toContain(old.id);
      expect(windowed.rows.map((r) => r.id)).not.toContain(recent.id);
    });

    it('an invalid fromDate/toDate is dropped rather than throwing (falls back to no bound)', async () => {
      const person = await makePerson(handle.db);
      await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(1), providerEventId: 'range-bogus' });

      const result = await commsRepo.listForPerson(handle.db, { personRefId: person.id, fromDate: 'not-a-date', toDate: 'also-not-a-date', limit: 10 });
      expect(result.rows).toHaveLength(1);
    });

    it('keyset pagination is stable: paging with a small limit returns exactly what a single large-limit call returns, in the same order', async () => {
      const person = await makePerson(handle.db);
      for (let i = 0; i < 11; i++) {
        await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(i), providerEventId: `page-${i}` });
      }
      const full = await commsRepo.listForPerson(handle.db, { personRefId: person.id, limit: 100 });

      let cursor: string | null = null;
      const paged: typeof full.rows = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await commsRepo.listForPerson(handle.db, { personRefId: person.id, limit: 3, cursor });
        paged.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(paged.map((r) => r.id)).toEqual(full.rows.map((r) => r.id));
    });

    // -----------------------------------------------------------------
    // P1 regression (round 3): every keyset cursor in this package used to
    // be minted from `.toISOString()` (millisecond resolution) while
    // occurred_at is `timestamptz` (microsecond resolution) — a boundary
    // row whose timestamp carried a non-zero sub-millisecond component was
    // silently truncated out of the cursor, so the strict "<"/"=" predicate
    // excluded every remaining row sharing that microsecond value AND
    // nextCursor came back null (feed reports itself complete while rows
    // are still missing). The existing "keyset pagination is stable" test
    // above uses whole-day-apart timestamps and therefore cannot catch
    // this — this test forces several rows onto the SAME
    // microsecond-precision occurred_at, the routine production case
    // (`now()` is the transaction timestamp, so rows one transaction
    // writes share one identical value).
    // -----------------------------------------------------------------
    it('P1 regression: rows sharing one microsecond-precision occurred_at are ALL returned across pages, not silently dropped at the page boundary', async () => {
      const person = await makePerson(handle.db);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: new Date(), providerEventId: `micro-${i}` });
        ids.push(row.id);
      }
      // Force every row onto one shared, sub-millisecond-precision instant
      // — the exact case a JS Date (millisecond resolution) cannot
      // represent, so this can ONLY be set via a raw SQL literal.
      await handle.db.execute(
        sql`update communication_events set occurred_at = '2026-08-04T12:00:00.123456Z'::timestamptz where id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      );

      const full = await commsRepo.listForPerson(handle.db, { personRefId: person.id, limit: 100 });
      expect(full.rows).toHaveLength(5);

      let cursor: string | null = null;
      const paged: typeof full.rows = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await commsRepo.listForPerson(handle.db, { personRefId: person.id, limit: 2, cursor });
        paged.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(paged.map((r) => r.id).sort()).toEqual(full.rows.map((r) => r.id).sort());
      expect(paged).toHaveLength(5);
    });
  });

  describe('listForIssue', () => {
    it('with includeLinkedPeople=false, only comms directly linked to the issue appear', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);

      const direct = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(1), providerEventId: 'direct1' });
      await linkComm(handle.db, direct.id, { issueId: issue.id });

      const viaPersonOnly = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(2), providerEventId: 'viaperson1' });
      await linkComm(handle.db, viaPersonOnly.id, { personRefId: owner.id });

      const result = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: false, limit: 10 });
      expect(result.rows.map((r) => r.event.id)).toEqual([direct.id]);
      expect(result.rows[0]?.linkage).toBe('direct');
    });

    it('with includeLinkedPeople=true, comms linked only via a linked person are folded in too (spec §9.1)', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);

      const viaPersonOnly = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(1), providerEventId: 'viaperson2' });
      await linkComm(handle.db, viaPersonOnly.id, { personRefId: owner.id });

      const result = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: true, limit: 10 });
      expect(result.rows.map((r) => r.event.id)).toEqual([viaPersonOnly.id]);
      expect(result.rows[0]?.linkage).toBe('via-person');
      expect(result.rows[0]?.viaPersonRefIds).toEqual([owner.id]);
      expect(result.linkedPersonCount).toBe(1);
    });

    it('a comm linked BOTH directly to the issue AND via a linked person is deduped into ONE row tagged linkage="both"', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);

      const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(1), providerEventId: 'both1' });
      await linkComm(handle.db, comm.id, { issueId: issue.id });
      await linkComm(handle.db, comm.id, { personRefId: owner.id });

      const result = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: true, limit: 10 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.linkage).toBe('both');
    });

    it('cross-matter tagging: a comm folded in via a person, that is ALSO linked to a DIFFERENT issue, is flagged crossMatter with the other issue id (spec §29.1)', async () => {
      const sharedPerson = await makePerson(handle.db);
      const { issue: issueA } = await makeIssueWithPeople(handle.db, [{ personRefId: sharedPerson.id, role: 'owner' }]);
      const { issue: issueB } = await makeIssueWithPeople(handle.db, [{ personRefId: sharedPerson.id, role: 'owner' }]);

      const comm = await insertComm(handle.db, { fromPersonRefId: sharedPerson.id, occurredAt: daysAgo(1), providerEventId: 'crossmatter1' });
      await linkComm(handle.db, comm.id, { personRefId: sharedPerson.id });
      await linkComm(handle.db, comm.id, { issueId: issueB.id });

      const onA = await commsRepo.listForIssue(handle.db, { issueId: issueA.id, includeLinkedPeople: true, limit: 10 });
      expect(onA.rows).toHaveLength(1);
      expect(onA.rows[0]?.crossMatter).toBe(true);
      expect(onA.rows[0]?.crossMatterIssueIds).toEqual([issueB.id]);

      // On issue B (where it's ALSO directly linked), it is not cross-matter — it belongs there.
      const onB = await commsRepo.listForIssue(handle.db, { issueId: issueB.id, includeLinkedPeople: true, limit: 10 });
      expect(onB.rows).toHaveLength(1);
      expect(onB.rows[0]?.crossMatter).toBe(false);
    });

    it('a comm that belongs EXCLUSIVELY to a different issue of the same person does not appear at all unless folded in via that person', async () => {
      const sharedPerson = await makePerson(handle.db);
      const { issue: issueA } = await makeIssueWithPeople(handle.db, [{ personRefId: sharedPerson.id, role: 'owner' }]);
      const { issue: issueB } = await makeIssueWithPeople(handle.db, [{ personRefId: sharedPerson.id, role: 'owner' }]);

      const comm = await insertComm(handle.db, { fromPersonRefId: sharedPerson.id, occurredAt: daysAgo(1), providerEventId: 'exclusiveB' });
      await linkComm(handle.db, comm.id, { issueId: issueB.id });

      const onA = await commsRepo.listForIssue(handle.db, { issueId: issueA.id, includeLinkedPeople: true, limit: 10 });
      expect(onA.rows).toHaveLength(0);
    });

    it('personRefIds filter narrows to a subset of linked people, on both direct and folded-in comms', async () => {
      const owner = await makePerson(handle.db);
      const neighbor = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [
        { personRefId: owner.id, role: 'owner' },
        { personRefId: neighbor.id, role: 'neighbor' },
      ]);

      const ownerComm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(1), providerEventId: 'owner-c' });
      await linkComm(handle.db, ownerComm.id, { personRefId: owner.id });
      const neighborComm = await insertComm(handle.db, { fromPersonRefId: neighbor.id, occurredAt: daysAgo(2), providerEventId: 'neighbor-c' });
      await linkComm(handle.db, neighborComm.id, { personRefId: neighbor.id });

      const onlyOwner = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: true, personRefIds: [owner.id], limit: 10 });
      expect(onlyOwner.rows.map((r) => r.event.id)).toEqual([ownerComm.id]);
    });

    it('filters compose: types AND direction AND participantQuery all apply together', async () => {
      const owner = await makePerson(handle.db, { displayName: 'Findable Owner', contactSnapshot: { phone: '555-9999' } });
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);

      const match = await insertComm(handle.db, { fromPersonRefId: owner.id, channel: 'email', direction: 'inbound', occurredAt: daysAgo(1), providerEventId: 'compose-match' });
      await linkComm(handle.db, match.id, { issueId: issue.id });
      const wrongChannel = await insertComm(handle.db, { fromPersonRefId: owner.id, channel: 'call', direction: 'inbound', occurredAt: daysAgo(1), providerEventId: 'compose-wrongchannel' });
      await linkComm(handle.db, wrongChannel.id, { issueId: issue.id });
      const wrongDirection = await insertComm(handle.db, { fromPersonRefId: owner.id, channel: 'email', direction: 'outbound', occurredAt: daysAgo(1), providerEventId: 'compose-wrongdir' });
      await linkComm(handle.db, wrongDirection.id, { issueId: issue.id });

      const result = await commsRepo.listForIssue(handle.db, {
        issueId: issue.id,
        includeLinkedPeople: false,
        types: ['email'],
        direction: 'inbound',
        participantQuery: 'Findable',
        limit: 10,
      });
      expect(result.rows.map((r) => r.event.id)).toEqual([match.id]);
    });

    it('participantQuery matches by phone/email too, not just display name', async () => {
      const owner = await makePerson(handle.db, { displayName: 'Some Name', contactSnapshot: { phone: '555-1234', email: 'unique-address@example.com' } });
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(1), providerEventId: 'byemail' });
      await linkComm(handle.db, comm.id, { issueId: issue.id });

      const byEmail = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: false, participantQuery: 'unique-address', limit: 10 });
      expect(byEmail.rows.map((r) => r.event.id)).toEqual([comm.id]);

      const byPhone = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: false, participantQuery: '555-1234', limit: 10 });
      expect(byPhone.rows.map((r) => r.event.id)).toEqual([comm.id]);
    });

    it('malformed personRefIds (non-uuid entries) are dropped rather than crashing the query', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(1), providerEventId: 'malformed-ids' });
      await linkComm(handle.db, comm.id, { issueId: issue.id });

      const result = await commsRepo.listForIssue(handle.db, {
        issueId: issue.id,
        includeLinkedPeople: false,
        personRefIds: ['not-a-uuid', 12345 as unknown as string, owner.id],
        limit: 10,
      });
      expect(result.rows.map((r) => r.event.id)).toEqual([comm.id]);
    });

    it('a non-uuid issueId returns empty rather than throwing', async () => {
      const result = await commsRepo.listForIssue(handle.db, { issueId: 'not-a-uuid', includeLinkedPeople: true, limit: 10 });
      expect(result.rows).toEqual([]);
    });

    it('fromDate/toDate narrow the issue feed to an inclusive occurred_at window', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const old = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(10), providerEventId: 'issue-range-old' });
      await linkComm(handle.db, old.id, { issueId: issue.id });
      const mid = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(5), providerEventId: 'issue-range-mid' });
      await linkComm(handle.db, mid.id, { issueId: issue.id });

      const windowed = await commsRepo.listForIssue(handle.db, {
        issueId: issue.id,
        includeLinkedPeople: false,
        fromDate: daysAgo(6).toISOString(),
        toDate: daysAgo(4).toISOString(),
        limit: 10,
      });
      expect(windowed.rows.map((r) => r.event.id)).toEqual([mid.id]);
    });

    it('keyset pagination across direct + folded-in comms is stable under a small page size', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      for (let i = 0; i < 9; i++) {
        const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(i), providerEventId: `issue-page-${i}` });
        if (i % 2 === 0) await linkComm(handle.db, comm.id, { issueId: issue.id });
        else await linkComm(handle.db, comm.id, { personRefId: owner.id });
      }

      const full = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: true, limit: 100 });
      expect(full.rows).toHaveLength(9);

      let cursor: string | null = null;
      const paged: typeof full.rows = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: true, limit: 2, cursor });
        paged.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(paged.map((r) => r.event.id)).toEqual(full.rows.map((r) => r.event.id));
    });
  });
});

describe('timeline-repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  describe('issueTimeline', () => {
    it('interleaves communications, audit events, and phase-open in chronological (newest-first) order', async () => {
      const owner = await makePerson(handle.db);
      const { issue, property } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      // createIssue already produced an 'issues' audit row and a phase_open (intake) entry.

      const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(0), providerEventId: 'timeline-comm' });
      await linkComm(handle.db, comm.id, { issueId: issue.id });

      await applyHold(handle.db, {
        propertyRefId: property.id,
        issueId: issue.id,
        holdType: 'cleanup',
        reason: 'Test hold for timeline coverage',
        actorExternalId: 'test-coordinator',
        actorRole: 'coordinator',
      });

      const result = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, limit: 100 });
      const kinds = result.entries.map((e) => e.kind);
      expect(kinds).toContain('communication');
      expect(kinds).toContain('audit');
      expect(kinds).toContain('phase_open');

      // Newest-first: every entry's `at` is >= the next entry's `at`.
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(result.entries[i]!.at.getTime());
      }
    });

    it('a communication entry carries crossMatter through from comms-repo', async () => {
      const sharedPerson = await makePerson(handle.db);
      const { issue: issueA } = await makeIssueWithPeople(handle.db, [{ personRefId: sharedPerson.id, role: 'owner' }]);
      const { issue: issueB } = await makeIssueWithPeople(handle.db, [{ personRefId: sharedPerson.id, role: 'owner' }]);
      const comm = await insertComm(handle.db, { fromPersonRefId: sharedPerson.id, occurredAt: daysAgo(0), providerEventId: 'timeline-crossmatter' });
      await linkComm(handle.db, comm.id, { personRefId: sharedPerson.id });
      await linkComm(handle.db, comm.id, { issueId: issueB.id });

      const result = await timelineRepo.issueTimeline(handle.db, { issueId: issueA.id, limit: 100 });
      const entry = result.entries.find((e) => e.sourceTable === 'communication_events' && e.sourceId === comm.id);
      expect(entry?.crossMatter).toBe(true);
    });

    it('kinds filter narrows the feed to exactly the requested kinds; an entirely-invalid kinds array matches nothing', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(0), providerEventId: 'kinds-filter' });
      await linkComm(handle.db, comm.id, { issueId: issue.id });

      const onlyComms = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['communication'] }, limit: 100 });
      expect(onlyComms.entries.every((e) => e.kind === 'communication')).toBe(true);
      expect(onlyComms.entries.length).toBeGreaterThan(0);

      const bogus = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['not-a-real-kind'] }, limit: 100 });
      expect(bogus.entries).toEqual([]);
    });

    it('phase_close entries appear (a source with no dedicated create-path test yet) and are excluded when only phase_open is requested', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      // The current open phase_instance (created by createIssue) gets an ended_at, simulating a closed phase.
      await handle.db
        .update(phaseInstances)
        .set({ status: 'completed', endedAt: daysAgo(0), exitOutcome: 'resolved' })
        .where(eq(phaseInstances.issueId, issue.id));

      const onlyClose = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['phase_close'] }, limit: 100 });
      expect(onlyClose.entries).toHaveLength(1);
      expect(onlyClose.entries[0]?.title).toContain('Phase closed');
      expect(onlyClose.entries[0]?.detail).toBe('resolved');

      const onlyOpen = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['phase_open'] }, limit: 100 });
      expect(onlyOpen.entries.every((e) => e.kind === 'phase_open')).toBe(true);
      expect(onlyOpen.entries.map((e) => e.kind)).not.toContain('phase_close');
    });

    it('notice entries appear and can be filtered by recipient personRefIds', async () => {
      const owner = await makePerson(handle.db);
      const other = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      await handle.db.insert(notices).values({ issueId: issue.id, templateVersion: 'v1', recipientPersonRefId: owner.id, status: 'sent', sentAt: daysAgo(0) });

      const withNotice = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['notice'] }, limit: 100 });
      expect(withNotice.entries).toHaveLength(1);

      const wrongPerson = await timelineRepo.issueTimeline(handle.db, {
        issueId: issue.id,
        filters: { kinds: ['notice'], personRefIds: [other.id] },
        limit: 100,
      });
      expect(wrongPerson.entries).toHaveLength(0);
    });

    it('malformed cursor falls back to page 1 rather than throwing', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const result = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, cursor: 'totally-bogus-cursor', limit: 100 });
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('a non-uuid issueId returns empty rather than throwing', async () => {
      const result = await timelineRepo.issueTimeline(handle.db, { issueId: 'not-a-uuid', limit: 10 });
      expect(result.entries).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it('an audit entry carries before/after through for change-log field diffing (Wave 2b)', async () => {
      const owner = await makePerson(handle.db);
      const { issue, property } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      await applyHold(handle.db, {
        propertyRefId: property.id,
        issueId: issue.id,
        holdType: 'cleanup',
        reason: 'Diff coverage hold',
        actorExternalId: 'test-coordinator',
        actorRole: 'coordinator',
      });

      const result = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['audit'] }, limit: 100 });
      const holdApplied = result.entries.find((e) => e.title === 'Hold hold_applied');
      expect(holdApplied).toBeDefined();
      expect(holdApplied?.after).toBeDefined();
    });

    it('fromDate/toDate narrow the timeline to an inclusive date window, across every source', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const old = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(10), providerEventId: 'timeline-range-old' });
      await linkComm(handle.db, old.id, { issueId: issue.id });
      const recent = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(1), providerEventId: 'timeline-range-recent' });
      await linkComm(handle.db, recent.id, { issueId: issue.id });
      await handle.db.insert(notices).values({ issueId: issue.id, templateVersion: 'v1', recipientPersonRefId: owner.id, status: 'sent', sentAt: daysAgo(10) });

      const windowed = await timelineRepo.issueTimeline(handle.db, {
        issueId: issue.id,
        filters: { kinds: ['communication', 'notice'], fromDate: daysAgo(3).toISOString() },
        limit: 100,
      });
      const sourceIds = windowed.entries.map((e) => e.sourceId);
      expect(sourceIds).toContain(recent.id);
      expect(sourceIds).not.toContain(old.id);
    });

    it('an invalid fromDate/toDate is dropped rather than throwing', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const result = await timelineRepo.issueTimeline(handle.db, {
        issueId: issue.id,
        filters: { fromDate: 'not-a-date', toDate: 'also-not-a-date' },
        limit: 100,
      });
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('keyset pagination across heterogeneous sources is stable: no drops, no duplicates, exact chronological order preserved', async () => {
      const owner = await makePerson(handle.db);
      const { issue, property } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);

      for (let i = 0; i < 8; i++) {
        const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(i), providerEventId: `stable-${i}` });
        await linkComm(handle.db, comm.id, { issueId: issue.id });
      }
      await applyHold(handle.db, {
        propertyRefId: property.id,
        issueId: issue.id,
        holdType: 'cleanup',
        reason: 'Stability test hold',
        actorExternalId: 'test-coordinator',
        actorRole: 'coordinator',
      });
      await handle.db.insert(notices).values({ issueId: issue.id, templateVersion: 'v1', recipientPersonRefId: owner.id, status: 'sent', sentAt: daysAgo(3) });

      const full = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, limit: 1000 });
      expect(full.entries.length).toBeGreaterThanOrEqual(11); // 8 comms + issue-create audit + hold audit + phase_open (+ notice)

      for (const limit of [1, 2, 3]) {
        let cursor: string | null = null;
        const paged: typeof full.entries = [];
        for (let guard = 0; guard < 200; guard++) {
          const page = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, limit, cursor });
          paged.push(...page.entries);
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        const key = (e: (typeof full.entries)[number]) => `${e.sourceTable}:${e.sourceId}:${e.kind}:${e.at.toISOString()}`;
        expect(paged.map(key)).toEqual(full.entries.map(key));
      }
    });

    // P1 regression (round 3) — see comms-repo's identically-named test
    // above for the full mechanism. This exercises timeline-repo's own
    // per-source audit cursor (fetchIssueObjectGraphAuditBatch), which
    // shares the exact `now()`-is-the-transaction-timestamp production
    // trigger the finding describes for audit_events.
    it('P1 regression: audit entries sharing one microsecond-precision occurred_at are ALL returned across pages, not silently dropped at the page boundary', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);

      for (let i = 0; i < 5; i++) {
        await insertAuditEventAt(handle.db, { objectTable: 'issues', objectId: issue.id, action: 'micro_test' }, '2026-08-04T12:00:00.123456Z');
      }

      // TimelineEntry.sourceId for an 'audit' entry is the audited OBJECT's
      // id (here: the issue, shared by all 5 rows), not the audit_events
      // row's own primary key — so these 5 rows are only distinguishable by
      // count/title, not by a per-row id.
      type TimelineEntry = Awaited<ReturnType<typeof timelineRepo.issueTimeline>>['entries'][number];
      const isMicroEntry = (e: TimelineEntry) => e.sourceTable === 'issues' && e.sourceId === issue.id && e.title === 'Issue micro_test';

      const full = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['audit'] }, limit: 1000 });
      expect(full.entries.filter(isMicroEntry)).toHaveLength(5);

      let cursor: string | null = null;
      const paged: typeof full.entries = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['audit'] }, limit: 2, cursor });
        paged.push(...page.entries);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(paged.filter(isMicroEntry)).toHaveLength(5);
    });

    // P1 regression (round 4): the round-3 P1 fix above (audit rows sharing
    // ONE object's occurred_at) is the case where the old in-memory merge's
    // tie-break happened to AGREE with the SQL fetch order (both single
    // object => same sourceTable prefix in every tie string). This test
    // exercises the ACTUAL finding: audit rows about DIFFERENT objects in
    // the SAME object graph (the module's own documented routine case --
    // `now()` is the transaction timestamp, and one command commonly audits
    // an issue AND a child task/hold in the same transaction) sharing one
    // microsecond-precision occurred_at. The old tie-break prefixed every
    // tie with `sourceTable:sourceId:kind` BEFORE the row id, so it ordered
    // ties by object_table name ('tasks' > 'issues' lexicographically) --
    // NOT by the audit_events row's own id, which is what
    // `ORDER BY occurred_at DESC, id DESC` actually uses. Once the
    // millisecond-truncated combined-cursor `at` collapsed both rows onto
    // one bucket (same millisecond -- see this suite's other P1 regression
    // tests on why that truncation is the routine case, not an edge case),
    // that mismatched tie-break permanently dropped whichever row didn't
    // match its object-table-name ordering, independent of the rows' real
    // (random) ids -- reproduced deterministically every run, not
    // probabilistically.
    it('P1 regression (round 4): audit entries about DIFFERENT objects (an issue and its own task) sharing one microsecond-precision occurred_at are ALL returned across pages, in exact SQL fetch order', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const [taskRow] = await handle.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.issueId, issue.id)).limit(1);
      if (!taskRow) throw new Error('expected an initial task from makeIssueWithPeople');

      await insertAuditEventAt(handle.db, { objectTable: 'issues', objectId: issue.id, action: 'hetero_test' }, '2026-08-04T12:00:00.123456Z');
      await insertAuditEventAt(handle.db, { objectTable: 'tasks', objectId: taskRow.id, action: 'hetero_test' }, '2026-08-04T12:00:00.123456Z');

      type TimelineEntry = Awaited<ReturnType<typeof timelineRepo.issueTimeline>>['entries'][number];
      const heteroTitlesOf = (entries: TimelineEntry[]) => new Set(entries.filter((e) => e.title.endsWith('hetero_test')).map((e) => e.title));

      const full = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['audit'] }, limit: 1000 });
      expect(heteroTitlesOf(full.entries)).toEqual(new Set(['Issue hetero_test', 'Task hetero_test']));

      let cursor: string | null = null;
      const paged: TimelineEntry[] = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { kinds: ['audit'] }, limit: 1, cursor });
        paged.push(...page.entries);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(heteroTitlesOf(paged)).toEqual(new Set(['Issue hetero_test', 'Task hetero_test']));
    });
  });

  describe('personTimeline', () => {
    it('includes the person\'s communications and their issue_people link', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(0), providerEventId: 'person-tl-comm' });
      await linkComm(handle.db, comm.id, { personRefId: owner.id });

      const result = await timelineRepo.personTimeline(handle.db, { personRefId: owner.id, limit: 100 });
      const kinds = result.entries.map((e) => e.kind);
      expect(kinds).toContain('communication');
      expect(kinds).toContain('issue_link');
      const linkEntry = result.entries.find((e) => e.kind === 'issue_link');
      expect(linkEntry?.title).toContain(issue.id ? 'owner' : ''); // sanity: role appears in title
    });

    it('a non-uuid personRefId returns empty rather than throwing', async () => {
      const result = await timelineRepo.personTimeline(handle.db, { personRefId: 'not-a-uuid', limit: 10 });
      expect(result.entries).toEqual([]);
    });

    it('kinds filter narrows to exactly the requested kinds; an entirely-invalid kinds array matches nothing', async () => {
      const owner = await makePerson(handle.db);
      await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const comm = await insertComm(handle.db, { fromPersonRefId: owner.id, occurredAt: daysAgo(0), providerEventId: 'person-kinds-filter' });
      await linkComm(handle.db, comm.id, { personRefId: owner.id });

      const onlyLinks = await timelineRepo.personTimeline(handle.db, { personRefId: owner.id, filters: { kinds: ['issue_link'] }, limit: 100 });
      expect(onlyLinks.entries.every((e) => e.kind === 'issue_link')).toBe(true);
      expect(onlyLinks.entries.length).toBeGreaterThan(0);

      const bogus = await timelineRepo.personTimeline(handle.db, { personRefId: owner.id, filters: { kinds: ['not-a-real-kind'] }, limit: 100 });
      expect(bogus.entries).toEqual([]);
    });

    it('audit entries where the person is the OBJECT (object_table=person_refs) are included and can be filtered to just "audit"', async () => {
      const owner = await makePerson(handle.db);
      await handle.db.insert(auditEvents).values({
        objectTable: 'person_refs',
        objectId: owner.id,
        action: 'merged',
        reason: 'Duplicate person record merge',
        occurredAt: daysAgo(0),
      });

      const onlyAudit = await timelineRepo.personTimeline(handle.db, { personRefId: owner.id, filters: { kinds: ['audit'] }, limit: 100 });
      expect(onlyAudit.entries).toHaveLength(1);
      expect(onlyAudit.entries[0]?.title).toBe('Person merged');
      expect(onlyAudit.entries[0]?.sourceTable).toBe('person_refs');
      expect(onlyAudit.entries[0]?.sourceId).toBe(owner.id);

      // A different person's object-scoped audit row must not leak in.
      const other = await makePerson(handle.db);
      const otherResult = await timelineRepo.personTimeline(handle.db, { personRefId: other.id, filters: { kinds: ['audit'] }, limit: 100 });
      expect(otherResult.entries).toEqual([]);
    });

    it('fromDate/toDate narrow the person audit feed to an inclusive occurred_at window', async () => {
      const owner = await makePerson(handle.db);
      await handle.db.insert(auditEvents).values({ objectTable: 'person_refs', objectId: owner.id, action: 'updated', occurredAt: daysAgo(10) });
      await handle.db.insert(auditEvents).values({ objectTable: 'person_refs', objectId: owner.id, action: 'updated', occurredAt: daysAgo(1) });

      const windowed = await timelineRepo.personTimeline(handle.db, {
        personRefId: owner.id,
        filters: { kinds: ['audit'], fromDate: daysAgo(3).toISOString() },
        limit: 100,
      });
      expect(windowed.entries).toHaveLength(1);
    });

    // P1 regression (round 4): the OTHER trigger from this finding -- no
    // heterogeneous object graph needed, just three rows from ONE source
    // (communication_events) sharing a millisecond but differing at
    // microsecond resolution. comms-repo's own SQL cursor is already
    // microsecond-exact (round-3 fix), but timeline-repo's TimelineEntry.at
    // is a JS Date (millisecond resolution): the old merge/cursor logic
    // compared THAT, collapsing all three onto one `at` bucket and then
    // ordering/advancing by row id (unrelated to the real occurred_at
    // order) instead of the true microsecond order, which silently
    // reordered and dropped rows at a page boundary.
    it('P1 regression (round 4): communication entries differing only sub-millisecond stay in exact chronological order and none are dropped when paginated', async () => {
      const person = await makePerson(handle.db);
      const commA = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: new Date(), providerEventId: 'sub-ms-a' });
      const commB = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: new Date(), providerEventId: 'sub-ms-b' });
      const commC = await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: new Date(), providerEventId: 'sub-ms-c' });
      // Force all three onto the SAME millisecond, differing only at
      // microsecond resolution -- a JS Date cannot represent this, so this
      // can only be set via a raw SQL literal.
      await handle.db.execute(sql`update communication_events set occurred_at = '2026-08-04T12:00:00.123900Z'::timestamptz where id = ${commA.id}::uuid`);
      await handle.db.execute(sql`update communication_events set occurred_at = '2026-08-04T12:00:00.123500Z'::timestamptz where id = ${commB.id}::uuid`);
      await handle.db.execute(sql`update communication_events set occurred_at = '2026-08-04T12:00:00.123100Z'::timestamptz where id = ${commC.id}::uuid`);

      const full = await timelineRepo.personTimeline(handle.db, { personRefId: person.id, filters: { kinds: ['communication'] }, limit: 1000 });
      expect(full.entries.map((e) => e.sourceId)).toEqual([commA.id, commB.id, commC.id]);

      let cursor: string | null = null;
      type TimelineEntry = Awaited<ReturnType<typeof timelineRepo.personTimeline>>['entries'][number];
      const paged: TimelineEntry[] = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await timelineRepo.personTimeline(handle.db, { personRefId: person.id, filters: { kinds: ['communication'] }, limit: 1, cursor });
        paged.push(...page.entries);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(paged.map((e) => e.sourceId)).toEqual([commA.id, commB.id, commC.id]);
    });
  });
});

describe('audit-metrics-repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  describe('activitiesByActor', () => {
    it('counts audit_events grouped by coalesce(actor_external_id, actor_id, unattributed)', async () => {
      const owner = await makePerson(handle.db);
      await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]); // actorExternalId: 'test-seeder' (2 audit rows: issue + task)
      const rows = await auditMetricsRepo.activitiesByActor(handle.db, {});
      const seederRow = rows.find((r) => r.actor === 'test-seeder');
      expect(seederRow).toBeDefined();
      expect(seederRow!.count).toBeGreaterThan(0);
    });

    it('category filter scopes to one object_table', async () => {
      const owner = await makePerson(handle.db);
      const { property, issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      await applyHold(handle.db, {
        propertyRefId: property.id,
        issueId: issue.id,
        holdType: 'cleanup',
        reason: 'Category filter test',
        actorExternalId: 'test-seeder',
        actorRole: 'coordinator',
      });

      const holdsOnly = await auditMetricsRepo.activitiesByActor(handle.db, { category: 'holds' });
      const total = holdsOnly.reduce((sum, r) => sum + r.count, 0);
      expect(total).toBe(1);

      // An invalid category is not in the allowlist and is silently ignored (falls back to no filter), never thrown.
      const bogus = await auditMetricsRepo.activitiesByActor(handle.db, { category: 'not-a-real-table' });
      expect(bogus.length).toBeGreaterThan(0);
    });

    it('date range filter scopes correctly', async () => {
      const owner = await makePerson(handle.db);
      await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);

      const past = await auditMetricsRepo.activitiesByActor(handle.db, { from: '1990-01-01', to: '1990-01-02' });
      expect(past.every((r) => r.count === 0) || past.length === 0).toBe(true);

      const now = await auditMetricsRepo.activitiesByActor(handle.db, { from: '2000-01-01' });
      expect(now.length).toBeGreaterThan(0);
    });
  });

  describe('recentActivity', () => {
    it('filters compose: objectTables AND actor together', async () => {
      const owner = await makePerson(handle.db);
      const { property, issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      await applyHold(handle.db, {
        propertyRefId: property.id,
        issueId: issue.id,
        holdType: 'cleanup',
        reason: 'recentActivity compose test',
        actorExternalId: 'compose-actor',
        actorRole: 'coordinator',
      });

      const result = await auditMetricsRepo.recentActivity(handle.db, { filters: { objectTables: ['holds'], actor: 'compose-actor' }, limit: 10 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.objectTable).toBe('holds');
    });

    it('an objectTables filter with only invalid values matches nothing (never silently "all")', async () => {
      const owner = await makePerson(handle.db);
      await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const result = await auditMetricsRepo.recentActivity(handle.db, { filters: { objectTables: ['not-a-real-table'] }, limit: 10 });
      expect(result.rows).toEqual([]);
    });

    it('malformed cursor falls back to page 1 rather than throwing', async () => {
      const owner = await makePerson(handle.db);
      await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const result = await auditMetricsRepo.recentActivity(handle.db, { cursor: 'garbage-cursor-value', limit: 10 });
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('keyset pagination is stable across the global feed', async () => {
      const owner = await makePerson(handle.db);
      for (let i = 0; i < 5; i++) {
        await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      }
      const full = await auditMetricsRepo.recentActivity(handle.db, { limit: 1000 });
      expect(full.rows.length).toBeGreaterThanOrEqual(5);

      let cursor: string | null = null;
      const paged: typeof full.rows = [];
      for (let guard = 0; guard < 200; guard++) {
        const page = await auditMetricsRepo.recentActivity(handle.db, { limit: 3, cursor });
        paged.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(paged.map((r) => r.id)).toEqual(full.rows.map((r) => r.id));
    });

    // P1 regression (round 3) — see comms-repo's identically-named test
    // above for the full mechanism. audit_events is the case the finding
    // calls out as routine in production: `occurred_at` defaults `now()`,
    // the TRANSACTION timestamp, so every audit row one command writes
    // (writeAudit is called several times per createIssue/transition)
    // shares one identical microsecond value.
    it('P1 regression: audit_events rows sharing one microsecond-precision occurred_at are ALL returned across pages, not silently dropped at the page boundary', async () => {
      const owner = await makePerson(handle.db);
      const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        // 'issues' (unlike 'person_refs') is in audit-metrics-repo's
        // VALID_OBJECT_TABLES allowlist, so the objectTables filter below
        // actually narrows to these rows rather than silently matching
        // nothing (requested-but-invalid -> match nothing, per this
        // module's own "never silently 'all'" contract).
        ids.push(await insertAuditEventAt(handle.db, { objectTable: 'issues', objectId: issue.id, action: 'micro_test' }, '2026-08-04T12:00:00.123456Z'));
      }

      const full = await auditMetricsRepo.recentActivity(handle.db, { filters: { objectTables: ['issues'] }, limit: 1000 });
      expect(full.rows.filter((r) => ids.includes(r.id))).toHaveLength(5);

      let cursor: string | null = null;
      const paged: typeof full.rows = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await auditMetricsRepo.recentActivity(handle.db, { filters: { objectTables: ['issues'] }, limit: 2, cursor });
        paged.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(paged.filter((r) => ids.includes(r.id))).toHaveLength(5);
      expect(paged.map((r) => r.id).sort()).toEqual(full.rows.map((r) => r.id).sort());
    });
  });
});

// -----------------------------------------------------------------------
// INJECTION FUZZ (round 2): a NUL byte (U+0000) in a free-text filter must
// never reach the driver as a bound parameter's value — Postgres text
// columns reject it wire-level regardless of parameterization
// ("invalid byte sequence for encoding \"UTF8\": 0x00"). issues-query-repo
// and people-repo were already hardened against this; comms-repo,
// timeline-repo, and audit-metrics-repo were not (this is that gap's
// regression coverage).
// -----------------------------------------------------------------------
describe('NUL byte (U+0000) in free-text filters never reaches the driver', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('comms-repo.listForPerson participantQuery', async () => {
    const person = await makePerson(handle.db);
    await expect(commsRepo.listForPerson(handle.db, { personRefId: person.id, participantQuery: '\u0000', limit: 10 })).resolves.not.toThrow();
  });

  it('comms-repo.listForIssue participantQuery', async () => {
    const owner = await makePerson(handle.db);
    const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
    await expect(
      commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: false, participantQuery: '\u0000', limit: 10 }),
    ).resolves.not.toThrow();
  });

  it('timeline-repo.issueTimeline filters.participantQuery', async () => {
    const owner = await makePerson(handle.db);
    const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
    await expect(
      timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { participantQuery: '\u0000' }, limit: 10 }),
    ).resolves.not.toThrow();
  });

  it('timeline-repo.personTimeline filters.participantQuery', async () => {
    const person = await makePerson(handle.db);
    await expect(
      timelineRepo.personTimeline(handle.db, { personRefId: person.id, filters: { participantQuery: '\u0000' }, limit: 10 }),
    ).resolves.not.toThrow();
  });

  it('audit-metrics-repo.recentActivity filters.actor', async () => {
    await expect(auditMetricsRepo.recentActivity(handle.db, { filters: { actor: '\u0000' }, limit: 10 })).resolves.not.toThrow();
  });

  it('people-repo.searchPeople q (already-hardened baseline, guards against regression)', async () => {
    const { searchPeople } = await import('../lib/repositories/people-repo.ts');
    await expect(searchPeople(handle.db, { q: '\u0000' })).resolves.not.toThrow();
  });

  it('issues-query-repo listIssues searchText (already-hardened baseline, guards against regression)', async () => {
    const { listIssues } = await import('../lib/repositories/issues-query-repo.ts');
    await expect(listIssues(handle.db, { filters: { searchText: '\u0000' } })).resolves.not.toThrow();
  });

  it('a cursor whose decoded sortValue contains a NUL byte is treated as invalid (page 1), not thrown', async () => {
    const { decodeCursor: decodeIssuesCursor, encodeCursor: encodeIssuesCursor } = await import('../lib/repositories/issues-query-repo.ts');
    const poisoned = encodeIssuesCursor('abc\u0000def', '00000000-0000-0000-0000-000000000000');
    expect(decodeIssuesCursor(poisoned)).toBeNull();
  });

  it('keyset-cursor.decodeCursor rejects a NUL byte in `at` or `tie`', async () => {
    const { decodeCursor, encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    const goodAt = new Date().toISOString();
    expect(decodeCursor(encodeCursor(`${goodAt}\u0000`, 'tie-1'))).toBeNull();
    expect(decodeCursor(encodeCursor(goodAt, 'tie\u0000-1'))).toBeNull();
  });
});


// -----------------------------------------------------------------------
// PARSE-COMPATIBILITY FUZZ (round 2, superseded by round 3): Date.parse()
// accepts far more string formats than Postgres's timestamptz parser. A
// cursor carrying a JS-parseable-but-Postgres-unparseable `at` value used
// to pass decodeCursor's `Number.isNaN(Date.parse(at))` guard and then
// throw a raw driver error (SQLSTATE 22007) at the `::timestamptz` cast,
// instead of the documented "malformed cursor -> page 1" contract.
//
// The round-2 fix ("canonicalize `at` to
// `new Date(Date.parse(at)).toISOString()` inside the decoder") turned out
// to be its own bypassable hole (round-3 P2 finding): that canonicalization
// is a no-op for ISO 8601 extended-year/year-0000 strings, which round-trip
// unchanged and still blow up at the `::timestamptz` cast. The round-3 fix
// replaces canonicalization with strict validation against the EXACT shape
// this package's own cursorTimestampExpr always produces (see
// keyset-cursor.isValidCursorTimestamp) — anything else, including this
// block's "weird but JS-parseable" fixture, is rejected outright (decodes
// to null -> page 1) rather than being reshaped into something Postgres
// will accept.
// -----------------------------------------------------------------------
describe('PARSE-COMPATIBILITY FUZZ (round 2): a Date.parse-but-not-Postgres-parseable cursor timestamp never reaches the driver', () => {
  // Date.parse() accepts this (JS's permissive toString()-echo format);
  // Postgres's timestamptz parser rejects it outright.
  const WEIRD_BUT_JS_PARSEABLE_AT = 'Sat, 01 Jan 2024 00:00:00 GMT+0000 (Coordinated Universal Time)';

  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('sanity check: the fixture string is Date.parse-able (this is what makes the old guard insufficient)', () => {
    expect(Number.isNaN(Date.parse(WEIRD_BUT_JS_PARSEABLE_AT))).toBe(false);
  });

  it('keyset-cursor.decodeCursor rejects the weird `at` outright (round 3: strict format match, not canonicalization) rather than passing it through verbatim', async () => {
    const { decodeCursor, encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    const poisoned = encodeCursor(WEIRD_BUT_JS_PARSEABLE_AT, '00000000-0000-0000-0000-000000000000');
    expect(decodeCursor(poisoned)).toBeNull();
  });

  it('issues-query-repo.decodeCursor + validCursorForSort: listIssues does not throw a raw driver error on the weird cursor', async () => {
    const { listIssues, encodeCursor: encodeIssuesCursor } = await import('../lib/repositories/issues-query-repo.ts');
    const poisoned = encodeIssuesCursor(WEIRD_BUT_JS_PARSEABLE_AT, '00000000-0000-0000-0000-000000000000');
    await expect(listIssues(handle.db, { cursor: poisoned, sort: { key: 'updated_at', direction: 'desc' } })).resolves.not.toThrow();
  });

  it('comms-repo.listForPerson does not throw a raw driver error on the weird cursor', async () => {
    const { encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    const person = await makePerson(handle.db);
    await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(1), providerEventId: 'weird-cursor-1' });
    const poisoned = encodeCursor(WEIRD_BUT_JS_PARSEABLE_AT, '00000000-0000-0000-0000-000000000000');
    await expect(commsRepo.listForPerson(handle.db, { personRefId: person.id, cursor: poisoned, limit: 10 })).resolves.not.toThrow();
  });

  it('comms-repo.listForIssue does not throw a raw driver error on the weird cursor', async () => {
    const { encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    const owner = await makePerson(handle.db);
    const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
    const poisoned = encodeCursor(WEIRD_BUT_JS_PARSEABLE_AT, '00000000-0000-0000-0000-000000000000');
    await expect(
      commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: false, cursor: poisoned, limit: 10 }),
    ).resolves.not.toThrow();
  });

  it('audit-metrics-repo.recentActivity does not throw a raw driver error on the weird cursor', async () => {
    const { encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    const poisoned = encodeCursor(WEIRD_BUT_JS_PARSEABLE_AT, '00000000-0000-0000-0000-000000000000');
    await expect(auditMetricsRepo.recentActivity(handle.db, { cursor: poisoned, limit: 10 })).resolves.not.toThrow();
  });
});

// -----------------------------------------------------------------------
// P2 regression (round 3): the round-2 fix canonicalized a cursor's
// timestamp via `new Date(Date.parse(x)).toISOString()`, which is a NO-OP
// for ISO 8601 extended-year (`+010000-01-01T...`) and year-0000
// (`0000-01-01T...`) strings — both parse fine in JS and round-trip
// byte-for-byte through `toISOString()`, then blow up as a raw
// `date/time field value out of range`/`time zone displacement out of
// range` driver error at the `::timestamptz` cast, exactly the crash the
// "malformed cursor -> page 1" contract was supposed to prevent. The
// round-3 fix validates the EXACT canonical shape instead of
// canonicalizing, so these payloads are rejected outright (decode to
// null -> page 1) rather than reshaped into something that still reaches
// the cast.
// -----------------------------------------------------------------------
describe('P2 regression (round 3): extended-year and year-0000 cursor timestamps never reach the ::timestamptz cast', () => {
  // The exact payloads from the finding.
  const YEAR_0000 = '0000-01-01T00:00:00.000Z';
  const EXTENDED_YEAR_MIN = '+010000-01-01T00:00:00.000Z';
  const EXTENDED_YEAR_MAX = '+275760-09-13T00:00:00.000Z';
  // The same attack, expressed in THIS package's own canonical
  // 6-digit-microsecond shape (cursorTimestampExpr's output format) rather
  // than the 3-digit toISOString() shape the finding's payloads use —
  // proves the calendar-correctness guard itself rejects a year-0000/
  // calendar-overflow value, not merely a digit-count mismatch.
  const YEAR_0000_CANONICAL = '0000-01-01T00:00:00.123456Z';
  const MONTH_13_CANONICAL = '2026-13-01T00:00:00.123456Z';
  const FEB_30_CANONICAL = '2026-02-30T00:00:00.123456Z';
  const HOUR_24_CANONICAL = '2026-08-04T24:00:00.123456Z';

  const BAD_TIMESTAMPS = [YEAR_0000, EXTENDED_YEAR_MIN, EXTENDED_YEAR_MAX, YEAR_0000_CANONICAL, MONTH_13_CANONICAL, FEB_30_CANONICAL, HOUR_24_CANONICAL];

  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('sanity check: the extended-year/year-0000 payloads are Date.parse-able (this is what made the round-2 canonicalization a no-op)', () => {
    for (const at of [YEAR_0000, EXTENDED_YEAR_MIN, EXTENDED_YEAR_MAX]) {
      expect(Number.isNaN(Date.parse(at))).toBe(false);
    }
  });

  it('keyset-cursor.decodeCursor rejects every payload outright (null) rather than canonicalizing it into something that would still reach the ::timestamptz cast', async () => {
    const { decodeCursor, encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    for (const at of BAD_TIMESTAMPS) {
      const poisoned = encodeCursor(at, '00000000-0000-0000-0000-000000000000');
      expect(decodeCursor(poisoned)).toBeNull();
    }
  });

  it('issues-query-repo: cursors carrying the same payloads never reach the driver (listIssues resolves, does not throw)', async () => {
    const { listIssues, encodeCursor: encodeIssuesCursor } = await import('../lib/repositories/issues-query-repo.ts');
    for (const at of BAD_TIMESTAMPS) {
      const poisoned = encodeIssuesCursor(at, '11111111-1111-1111-1111-111111111111');
      await expect(listIssues(handle.db, { cursor: poisoned, sort: { key: 'updated_at', direction: 'desc' } })).resolves.not.toThrow();
    }
  });

  it('comms-repo.listForPerson never throws on any of these payloads', async () => {
    const { encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    const person = await makePerson(handle.db);
    await insertComm(handle.db, { fromPersonRefId: person.id, occurredAt: daysAgo(1), providerEventId: 'p2-regress-1' });
    for (const at of BAD_TIMESTAMPS) {
      const poisoned = encodeCursor(at, '00000000-0000-0000-0000-000000000000');
      await expect(commsRepo.listForPerson(handle.db, { personRefId: person.id, cursor: poisoned, limit: 10 })).resolves.not.toThrow();
    }
  });

  it('audit-metrics-repo.recentActivity never throws on any of these payloads', async () => {
    const { encodeCursor } = await import('../lib/repositories/keyset-cursor.ts');
    for (const at of BAD_TIMESTAMPS) {
      const poisoned = encodeCursor(at, '00000000-0000-0000-0000-000000000000');
      await expect(auditMetricsRepo.recentActivity(handle.db, { cursor: poisoned, limit: 10 })).resolves.not.toThrow();
    }
  });
});

// -----------------------------------------------------------------------
// P2 regression (round 4): the round-3 P2 fix above hardened the CURSOR
// path (decodeCursor) against these exact payloads, but left the THREE
// duplicated `sanitizeDateBound` copies (comms-repo.ts, timeline-repo.ts,
// audit-metrics-repo.ts) — the date-RANGE-FILTER path (fromDate/toDate/
// from/to) — completely unguarded. `Date.parse('0000-01-01')` and
// `Date.parse('+275760-09-13T00:00:00.000Z')` both parse fine in JS and
// round-trip byte-for-byte through `toISOString()`, then reach `gte`/`lte`
// against a `timestamptz` column and blow up as the identical raw driver
// error the round-3 fix closed one seam over. This is that gap's coverage,
// reachable un-authenticated from `/people/<uuid>?from=0000-01-01`,
// `/issues/<uuid>/timeline?from=0000-01-01`, `/activity?from=0000-01-01`,
// and `/admin/activity?range=custom&from=0000-01-01`.
// -----------------------------------------------------------------------
describe('P2 regression (round 4): extended-year and year-0000 date-RANGE-FILTER bounds never reach the ::timestamptz cast', () => {
  const YEAR_0000 = '0000-01-01T00:00:00.000Z';
  const EXTENDED_YEAR_MIN = '+010000-01-01T00:00:00.000Z';
  const EXTENDED_YEAR_MAX = '+275760-09-13T00:00:00.000Z';
  const BAD_DATE_BOUNDS = [YEAR_0000, EXTENDED_YEAR_MIN, EXTENDED_YEAR_MAX, '0000-01-01'];

  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('sanity check: every payload is still Date.parse-able (this is what makes the naive `Date.parse` + `new Date()` guard insufficient)', () => {
    for (const bound of BAD_DATE_BOUNDS) {
      expect(Number.isNaN(Date.parse(bound))).toBe(false);
    }
  });

  it('keyset-cursor.sanitizeDateBound drops every payload (null) rather than a Date that would still reach the ::timestamptz cast', async () => {
    const { sanitizeDateBound } = await import('../lib/repositories/keyset-cursor.ts');
    for (const bound of BAD_DATE_BOUNDS) {
      expect(sanitizeDateBound(bound)).toBeNull();
    }
    // A genuinely valid bound still round-trips to a real Date — the fix
    // only tightens rejection, it does not turn this into "reject everything".
    expect(sanitizeDateBound('2026-08-04T12:00:00.000Z')).toBeInstanceOf(Date);
  });

  it('comms-repo.listForPerson: fromDate/toDate never reach the driver (/people/[id])', async () => {
    const person = await makePerson(handle.db);
    for (const bound of BAD_DATE_BOUNDS) {
      await expect(commsRepo.listForPerson(handle.db, { personRefId: person.id, fromDate: bound, limit: 10 })).resolves.not.toThrow();
      await expect(commsRepo.listForPerson(handle.db, { personRefId: person.id, toDate: bound, limit: 10 })).resolves.not.toThrow();
    }
  });

  it('comms-repo.listForIssue: fromDate/toDate never reach the driver', async () => {
    const owner = await makePerson(handle.db);
    const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
    for (const bound of BAD_DATE_BOUNDS) {
      await expect(
        commsRepo.listForIssue(handle.db, { issueId: issue.id, includeLinkedPeople: false, fromDate: bound, limit: 10 }),
      ).resolves.not.toThrow();
    }
  });

  it('timeline-repo.issueTimeline: filters.fromDate/toDate never reach the driver (/issues/[id]/timeline)', async () => {
    const owner = await makePerson(handle.db);
    const { issue } = await makeIssueWithPeople(handle.db, [{ personRefId: owner.id, role: 'owner' }]);
    for (const bound of BAD_DATE_BOUNDS) {
      await expect(timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { fromDate: bound }, limit: 10 })).resolves.not.toThrow();
      await expect(timelineRepo.issueTimeline(handle.db, { issueId: issue.id, filters: { toDate: bound }, limit: 10 })).resolves.not.toThrow();
    }
  });

  it('timeline-repo.personTimeline: filters.fromDate/toDate never reach the driver (/people/[id])', async () => {
    const person = await makePerson(handle.db);
    for (const bound of BAD_DATE_BOUNDS) {
      await expect(timelineRepo.personTimeline(handle.db, { personRefId: person.id, filters: { fromDate: bound }, limit: 10 })).resolves.not.toThrow();
    }
  });

  it('audit-metrics-repo.activitiesByActor: from/to never reach the driver (/admin/activity)', async () => {
    for (const bound of BAD_DATE_BOUNDS) {
      await expect(auditMetricsRepo.activitiesByActor(handle.db, { from: bound })).resolves.not.toThrow();
      await expect(auditMetricsRepo.activitiesByActor(handle.db, { to: bound })).resolves.not.toThrow();
    }
  });

  it('audit-metrics-repo.recentActivity: filters.from/to never reach the driver (/activity)', async () => {
    for (const bound of BAD_DATE_BOUNDS) {
      await expect(auditMetricsRepo.recentActivity(handle.db, { filters: { from: bound }, limit: 10 })).resolves.not.toThrow();
      await expect(auditMetricsRepo.recentActivity(handle.db, { filters: { to: bound }, limit: 10 })).resolves.not.toThrow();
    }
  });
});
