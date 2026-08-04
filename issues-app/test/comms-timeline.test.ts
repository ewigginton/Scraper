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
import {
  communicationEvents,
  communicationLinks,
  notices,
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
  });
});
