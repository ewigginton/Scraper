/**
 * tasks-repo.test.ts — regression coverage for lib/repositories/tasks-repo.ts's
 * inboxForUser, which previously had NO dedicated test file at all.
 *
 * Covers two adversarial-review findings:
 *  1. noticesDue applied no owner/queue scoping whatsoever (contradicting its
 *     own doc comment), so every user's "Letters / Notices Due" queue showed
 *     every pending/sent notice company-wide.
 *  2. None of the seven queue queries applied any LIMIT/pagination.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inboxForUser } from '../lib/repositories/tasks-repo.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { notices, tasks } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('tasks-repo: inboxForUser', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function baseIssue(coordinatorId: string | null, queue: string | null = null) {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const recipient = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'covenant_violation',
      propertyRefId: property.id,
      summary: 'Covenant case',
      coordinatorId,
      queue,
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), assigneeId: coordinatorId, queue },
    });
    return { property, owner, recipient, issue };
  }

  it('ADVERSARIAL-REVIEW REGRESSION: noticesDue is scoped to the caller (assigneeId matches issue.coordinatorId), not company-wide', async () => {
    const { issue: mine, recipient: myRecipient } = await baseIssue('coordinator-a');
    const { issue: someoneElses, recipient: theirRecipient } = await baseIssue('coordinator-b');

    await handle.db.insert(notices).values({
      issueId: mine.id,
      templateVersion: 'v1',
      recipientPersonRefId: myRecipient.id,
      status: 'pending',
    });
    await handle.db.insert(notices).values({
      issueId: someoneElses.id,
      templateVersion: 'v1',
      recipientPersonRefId: theirRecipient.id,
      status: 'pending',
    });

    const inboxA = await inboxForUser(handle.db, { assigneeId: 'coordinator-a' });
    expect(inboxA.noticesDue).toHaveLength(1);
    expect(inboxA.noticesDue[0]?.issueId).toBe(mine.id);

    const inboxUnrelated = await inboxForUser(handle.db, { assigneeId: 'someone-else-entirely' });
    expect(inboxUnrelated.noticesDue).toHaveLength(0);
  });

  it('noticesDue scopes by queue too, matching issue.queue rather than the notice or the coordinator', async () => {
    const { issue: queued, recipient } = await baseIssue(null, 'legal_queue');

    await handle.db.insert(notices).values({
      issueId: queued.id,
      templateVersion: 'v1',
      recipientPersonRefId: recipient.id,
      status: 'sent',
    });

    const inWrongQueue = await inboxForUser(handle.db, { queues: ['other_queue'] });
    expect(inWrongQueue.noticesDue).toHaveLength(0);

    const inRightQueue = await inboxForUser(handle.db, { queues: ['legal_queue'] });
    expect(inRightQueue.noticesDue).toHaveLength(1);
  });

  it('noticesDue still excludes resolved/expired notices once scoped', async () => {
    const { issue, recipient } = await baseIssue('coordinator-c');
    await handle.db.insert(notices).values({
      issueId: issue.id,
      templateVersion: 'v1',
      recipientPersonRefId: recipient.id,
      status: 'cured',
    });

    const inbox = await inboxForUser(handle.db, { assigneeId: 'coordinator-c' });
    expect(inbox.noticesDue).toHaveLength(0);
  });

  it('every queue is bounded by a default LIMIT so an unbounded task volume does not return every row', async () => {
    const property = await makeProperty(handle.db);
    for (let i = 0; i < 12; i += 1) {
      await handle.db.insert(tasks).values({
        propertyRefId: property.id,
        assigneeId: 'bulk-user',
        title: `overdue task ${i}`,
        status: 'open',
        dueDate: '2000-01-01',
      });
    }

    const inbox = await inboxForUser(handle.db, { assigneeId: 'bulk-user', queueLimit: 5 });
    expect(inbox.overdue).toHaveLength(5);
  });

  it('ADVERSARIAL-REVIEW REGRESSION (round 2, P2): the LIMIT truncation is deterministic (ORDER BY due_date), not row-order-dependent', async () => {
    const property = await makeProperty(handle.db);
    // Insert in DESCENDING due-date order (latest due date first) so that
    // "whatever order Postgres/PGlite happens to store/return rows in"
    // (insertion/physical order, absent an ORDER BY) would surface the
    // LATEST due dates first — the opposite of what a bounded "overdue"
    // queue must prioritize showing. With a deterministic
    // `ORDER BY due_date asc` this insertion order is irrelevant.
    const dueDates = ['2000-01-06', '2000-01-05', '2000-01-04', '2000-01-03', '2000-01-02', '2000-01-01'];
    for (const dueDate of dueDates) {
      await handle.db.insert(tasks).values({
        propertyRefId: property.id,
        assigneeId: 'ordering-user',
        title: `overdue task due ${dueDate}`,
        status: 'open',
        dueDate,
      });
    }

    const inbox = await inboxForUser(handle.db, { assigneeId: 'ordering-user', queueLimit: 3 });
    expect(inbox.overdue).toHaveLength(3);
    // Must be deterministically the 3 EARLIEST due dates, in ascending
    // order — never the 3 latest (which insertion order would surface
    // without an ORDER BY), and never a row-order-dependent mix.
    expect(inbox.overdue.map((t) => t.dueDate)).toEqual(['2000-01-01', '2000-01-02', '2000-01-03']);
  });

  // P2 regression (round 5): the round-2 fix above made the LIMIT
  // truncation deterministic by ORDER BY due_date, but the SECOND
  // ORDER BY column — the due-date tie-break — was the bare
  // `asc(tasks.priority)` TEXT column, which sorts LEXICOGRAPHICALLY on
  // the SAME {low, normal, high, urgent} CHECK domain as issues.priority.
  // ASCII-wise 'high' < 'low' < 'normal' < 'urgent', so within one
  // due-date group the real order came back `high, low, normal, urgent`
  // — urgent tasks sorted LAST and would be the first rows a tight
  // `queueLimit` truncates away. Seeding all FOUR priorities on one due
  // date (not just three) is what catches this — the finding's own root
  // cause was a test suite that only ever seeded three.
  it('P2 regression (round 5): within a due-date tie, queues order by business priority rank (urgent > high > normal > low), not lexicographically', async () => {
    const property = await makeProperty(handle.db);
    const sameDueDate = '2030-06-15'; // future date -> lands in `upcoming`, not `overdue`
    const priorities: Array<'low' | 'normal' | 'high' | 'urgent'> = ['high', 'low', 'normal', 'urgent'];
    for (const priority of priorities) {
      await handle.db.insert(tasks).values({
        propertyRefId: property.id,
        assigneeId: 'priority-tie-user',
        title: `task priority=${priority}`,
        status: 'open',
        dueDate: sameDueDate,
        priority,
      });
    }

    const inbox = await inboxForUser(handle.db, { assigneeId: 'priority-tie-user', today: '2030-06-01' });
    expect(inbox.upcoming.map((t) => t.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('P2 regression (round 5): the SAME business-rank tie-break applies to the overdue queue, where the finding\'s own harm lands (limit truncation dropping urgent tasks first)', async () => {
    const property = await makeProperty(handle.db);
    const sameDueDate = '2000-06-15';
    const priorities: Array<'low' | 'normal' | 'high' | 'urgent'> = ['high', 'low', 'normal', 'urgent'];
    for (const priority of priorities) {
      await handle.db.insert(tasks).values({
        propertyRefId: property.id,
        assigneeId: 'priority-tie-user-3',
        title: `overdue task priority=${priority}`,
        status: 'open',
        dueDate: sameDueDate,
        priority,
      });
    }

    // A tight limit of 2 -- with the old lexicographic tie-break this would
    // keep 'high' and 'low' and silently drop 'urgent' entirely.
    const inbox = await inboxForUser(handle.db, { assigneeId: 'priority-tie-user-3', queueLimit: 2 });
    expect(inbox.overdue.map((t) => t.priority)).toEqual(['urgent', 'high']);
  });

  it('P2 regression (round 5): the SAME business-rank tie-break applies to the waitingBlocked queue', async () => {
    const property = await makeProperty(handle.db);
    const sameDueDate = '2030-06-15';
    const priorities: Array<'low' | 'normal' | 'high' | 'urgent'> = ['high', 'low', 'normal', 'urgent'];
    for (const priority of priorities) {
      await handle.db.insert(tasks).values({
        propertyRefId: property.id,
        assigneeId: 'priority-tie-user-2',
        title: `waiting task priority=${priority}`,
        status: 'open',
        dueDate: sameDueDate,
        priority,
        waitingReason: 'awaiting response',
      });
    }

    const inbox = await inboxForUser(handle.db, { assigneeId: 'priority-tie-user-2', today: '2030-06-01' });
    expect(inbox.waitingBlocked.map((t) => t.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
  });
});
