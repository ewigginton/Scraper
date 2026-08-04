/**
 * people-timeline-page.test.ts — regression coverage for
 * lib/repositories/people-repo.ts's personTimelinePage.
 *
 * Before the fix, fromDate/toDate were applied as an in-memory `.filter()`
 * AFTER timeline-repo.personTimeline had already fetched and paginated an
 * unfiltered page, instead of being folded into `filters` and pushed down
 * to SQL the way timeline-repo.TimelineFilters (and every sibling caller,
 * e.g. app/issues/[id]/timeline/page.tsx) already supports. That produced
 * two observable bugs this file exercises directly:
 *  1. under-filled pages (fewer rows than `limit` even though more
 *     matching rows exist), and
 *  2. a `nextCursor` computed from the UNFILTERED batch, so it stays
 *     truthy ("load more") even when zero further matching rows exist.
 *
 * FAILS before the fix: personTimelinePage's result (entries + nextCursor)
 * differs from calling timelineRepo.personTimeline directly with the same
 * date range folded into `filters` — the two paths should be identical
 * once fixed, since personTimelinePage is meant to be a thin pass-through.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { personTimelinePage } from '../lib/repositories/people-repo.ts';
import * as timelineRepo from '../lib/repositories/timeline-repo.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { communicationEvents, communicationLinks, type NewCommunicationEvent } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

async function insertComm(db: TestDb, opts: { personId: string; occurredAt: Date; providerEventId: string }) {
  const values: NewCommunicationEvent = {
    channel: 'text',
    direction: 'outbound',
    providerSystem: 'test',
    providerEventId: opts.providerEventId,
    occurredAt: opts.occurredAt,
    toPersonRefId: opts.personId,
    summary: 'Test communication',
  };
  const [row] = await db.insert(communicationEvents).values(values).returning();
  if (!row) throw new Error('insertComm: insert returned no row');
  await db.insert(communicationLinks).values({ communicationEventId: row.id, personRefId: opts.personId });
  return row;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe('personTimelinePage date-range filtering', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function setup() {
    const property = await makeProperty(handle.db);
    const person = await makePerson(handle.db, { displayName: 'Timeline Filter Subject' });
    await createIssue(handle.db, {
      issueType: 'covenant_violation',
      propertyRefId: property.id,
      summary: 'Fixture case for personTimelinePage date filter coverage',
      people: [{ personRefId: person.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
      actorExternalId: 'test-seeder',
      actorRole: 'coordinator',
    });

    // 6 comms, newest first: offsets 1,2,3,4,5,6 days ago. A fromDate of
    // "2 days ago" (calendar day, midnight UTC) matches only offsets 1 and
    // 2 — offset 3 (3 days ago at noon UTC) falls before that midnight
    // cutoff and does not match, nor does anything older.
    const offsets = [1, 2, 3, 4, 5, 6];
    for (const n of offsets) {
      await insertComm(handle.db, { personId: person.id, occurredAt: daysAgo(n), providerEventId: `comm-${n}` });
    }
    return person;
  }

  it('applies fromDate as SQL pushdown, matching timelineRepo.personTimeline called directly with the same filters', async () => {
    const person = await setup();
    const fromDate = isoDay(daysAgo(2));

    const viaWrapper = await personTimelinePage(handle.db, {
      personRefId: person.id,
      filters: { kinds: ['communication'] },
      fromDate,
      limit: 10,
    });

    const viaDirect = await timelineRepo.personTimeline(handle.db, {
      personRefId: person.id,
      filters: { kinds: ['communication'], fromDate },
      limit: 10,
    });

    expect(viaWrapper.entries.map((e) => e.sourceId)).toEqual(viaDirect.entries.map((e) => e.sourceId));
    expect(viaWrapper.nextCursor).toBe(viaDirect.nextCursor);
    // Only the 2 comms within the last 2 days should match.
    expect(viaWrapper.entries.length).toBe(2);
  });

  it('does not leave a stale/truthy nextCursor when the raw (unfiltered) fetch hits its page limit but nothing beyond the returned rows actually matches the date filter', async () => {
    const person = await setup();
    const fromDate = isoDay(daysAgo(2));

    // limit=2 exactly matches the true (date-filtered) matching count, but
    // is smaller than the total UNFILTERED row count (6) — under the bug,
    // the raw fetch (which ignores fromDate entirely) hits its own
    // pagination limit against the 6 unfiltered rows and reports "more
    // available" via nextCursor, even though every remaining row is older
    // than fromDate and none of them would ever match.
    const result = await personTimelinePage(handle.db, {
      personRefId: person.id,
      filters: { kinds: ['communication'] },
      fromDate,
      limit: 2,
    });

    expect(result.entries.length).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  it('applies toDate as an inclusive end-of-day SQL pushdown bound', async () => {
    const person = await setup();
    const toDate = isoDay(daysAgo(5)); // keeps only the day=5 and day=6 comms

    const result = await personTimelinePage(handle.db, {
      personRefId: person.id,
      filters: { kinds: ['communication'] },
      toDate,
      limit: 10,
    });

    expect(result.entries.length).toBe(2);
  });
});
