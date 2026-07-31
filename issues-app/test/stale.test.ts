import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { acknowledgeStale, createIssue, IssueValidationError } from '../lib/services/issue-service.ts';
import { auditEvents, staleAcknowledgments } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty, pastDate } from './helpers/fixtures.ts';

describe('acknowledgeStale (spec §31.2)', () => {
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
    return createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Case gone quiet',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });
  }

  it('requires an explanation', async () => {
    const { issue } = await baseIssue();
    await expect(
      acknowledgeStale(handle.db, {
        issueId: issue.id,
        explanation: '',
        newTask: { title: 'Follow up', dueDate: futureDate(), queue: 'upcoming' },
        acknowledgedBy: 'coordinator-1',
      }),
    ).rejects.toBeInstanceOf(IssueValidationError);
  });

  it('requires a new next task with a future due date', async () => {
    const { issue } = await baseIssue();
    await expect(
      acknowledgeStale(handle.db, {
        issueId: issue.id,
        explanation: 'Waiting on attorney update',
        newTask: { title: 'Follow up', dueDate: pastDate(), queue: 'upcoming' },
        acknowledgedBy: 'coordinator-1',
      }),
    ).rejects.toBeInstanceOf(IssueValidationError);

    await expect(
      acknowledgeStale(handle.db, {
        issueId: issue.id,
        explanation: 'Waiting on attorney update',
        // @ts-expect-error intentionally omitting newTask for the validation test
        newTask: undefined,
        acknowledgedBy: 'coordinator-1',
      }),
    ).rejects.toBeInstanceOf(IssueValidationError);
  });

  it('requires the new task to have an assignee or a queue', async () => {
    const { issue } = await baseIssue();
    await expect(
      acknowledgeStale(handle.db, {
        issueId: issue.id,
        explanation: 'Waiting on attorney update',
        newTask: { title: 'Follow up', dueDate: futureDate() },
        acknowledgedBy: 'coordinator-1',
      }),
    ).rejects.toBeInstanceOf(IssueValidationError);
  });

  it('accepts a valid acknowledgment: creates the new task and records the acknowledgment, audited', async () => {
    const { issue } = await baseIssue();
    const actor = await makePerson(handle.db, { displayName: 'Coordinator One' });

    const { acknowledgment, task } = await acknowledgeStale(handle.db, {
      issueId: issue.id,
      explanation: 'Waiting on attorney update; checked in with counsel today.',
      newTask: { title: 'Check attorney status again', dueDate: futureDate(5), assigneeId: 'coordinator-1' },
      acknowledgedBy: 'coordinator-1',
      actorId: actor.id,
      actorRole: 'coordinator',
    });

    expect(acknowledgment.statusExplanation).toBe('Waiting on attorney update; checked in with counsel today.');
    expect(acknowledgment.acknowledgedBy).toBe('coordinator-1');
    expect(acknowledgment.acknowledgedAt).not.toBeNull();
    expect(acknowledgment.newNextTaskId).toBe(task.id);
    expect(task.title).toBe('Check attorney status again');
    expect(task.assigneeId).toBe('coordinator-1');

    const [reloadedAck] = await handle.db.select().from(staleAcknowledgments).where(eq(staleAcknowledgments.id, acknowledgment.id));
    expect(reloadedAck).toBeDefined();

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, acknowledgment.id));
    const ackAudit = audits.find((a) => a.action === 'stale_case_acknowledged');
    expect(ackAudit).toBeDefined();
    expect(ackAudit?.actorId).toBe(actor.id);
    expect(ackAudit?.reason).toBe('Waiting on attorney update; checked in with counsel today.');
  });

  it('updates an existing stale_acknowledgments row (flagged-but-not-yet-acknowledged) rather than always creating a new one', async () => {
    const { issue } = await baseIssue();
    const [flagged] = await handle.db
      .insert(staleAcknowledgments)
      .values({ issueId: issue.id, flaggedAt: new Date(), ageDays: 21 })
      .returning();

    const { acknowledgment } = await acknowledgeStale(handle.db, {
      issueId: issue.id,
      staleAcknowledgmentId: flagged!.id,
      explanation: 'Confirmed still waiting on vendor scheduling.',
      newTask: { title: 'Check vendor schedule', dueDate: futureDate(3), queue: 'action_dates' },
      acknowledgedBy: 'coordinator-2',
    });

    expect(acknowledgment.id).toBe(flagged!.id);
    expect(acknowledgment.ageDays).toBe(21);
    expect(acknowledgment.acknowledgedBy).toBe('coordinator-2');

    const all = await handle.db.select().from(staleAcknowledgments).where(eq(staleAcknowledgments.issueId, issue.id));
    expect(all).toHaveLength(1);
  });
});
