/**
 * issues-query-repo.test.ts — coverage for lib/repositories/issues-query-repo.ts
 * (docs/notion-redesign.md "Scale work" §1-2): filters, sort (incl. the
 * literal-allowlist fallback for hostile input), free-text search, keyset
 * pagination (incl. stability under concurrent inserts), and countIssues
 * matching listIssues' true total.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countIssues,
  DEFAULT_SORT,
  listIssues,
  type IssueListRow,
} from '../lib/repositories/issues-query-repo.ts';
import { issues, type Issue, type NewIssue, type NewPropertyRef } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDb, type TestDbHandle } from './helpers/pglite.ts';
import { makeProperty } from './helpers/fixtures.ts';

let counter = 0;

async function makeIssue(
  db: TestDb,
  overrides: Partial<NewIssue> & { propertyOverrides?: Partial<NewPropertyRef> } = {},
): Promise<Issue> {
  counter += 1;
  const { propertyOverrides, propertyRefId, ...issueOverrides } = overrides;
  const resolvedPropertyRefId = propertyRefId ?? (await makeProperty(db, propertyOverrides)).id;
  const [row] = await db
    .insert(issues)
    .values({
      issueType: 'default_recovery',
      propertyRefId: resolvedPropertyRefId,
      summary: `Test issue ${counter}`,
      priority: 'normal',
      lifecycleStatus: 'intake',
      ...issueOverrides,
    })
    .returning();
  if (!row) throw new Error('makeIssue: insert returned no row');
  return row;
}

describe('issues-query-repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  describe('filters', () => {
    it('issueTypes narrows to the matching types', async () => {
      await makeIssue(handle.db, { issueType: 'default_recovery' });
      await makeIssue(handle.db, { issueType: 'covenant_violation' });
      const result = await listIssues(handle.db, { filters: { issueTypes: ['covenant_violation'] } });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.issue.issueType).toBe('covenant_violation');
    });

    it('lifecycleStatuses narrows to the matching statuses', async () => {
      await makeIssue(handle.db, { lifecycleStatus: 'intake' });
      await makeIssue(handle.db, { lifecycleStatus: 'active', coordinatorId: 'alice' });
      const result = await listIssues(handle.db, { filters: { lifecycleStatuses: ['active'] } });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.issue.lifecycleStatus).toBe('active');
    });

    it('priorities narrows to the matching priorities', async () => {
      await makeIssue(handle.db, { priority: 'urgent' });
      await makeIssue(handle.db, { priority: 'low' });
      const result = await listIssues(handle.db, { filters: { priorities: ['urgent'] } });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.issue.priority).toBe('urgent');
    });

    it('states narrows via the joined property_refs.state', async () => {
      await makeIssue(handle.db, { propertyOverrides: { state: 'TX' } });
      await makeIssue(handle.db, { propertyOverrides: { state: 'OK' } });
      const result = await listIssues(handle.db, { filters: { states: ['OK'] } });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.property.state).toBe('OK');
    });

    it('coordinatorOrQueue matches EITHER coordinator_id OR queue', async () => {
      const byCoordinator = await makeIssue(handle.db, { coordinatorId: 'alice', lifecycleStatus: 'active' });
      const byQueue = await makeIssue(handle.db, { queue: 'legal_queue' });
      await makeIssue(handle.db, { coordinatorId: 'bob', lifecycleStatus: 'active' });

      const result = await listIssues(handle.db, { filters: { coordinatorOrQueue: 'alice' } });
      expect(result.rows.map((r) => r.issue.id)).toEqual([byCoordinator.id]);

      const result2 = await listIssues(handle.db, { filters: { coordinatorOrQueue: 'legal_queue' } });
      expect(result2.rows.map((r) => r.issue.id)).toEqual([byQueue.id]);
    });

    it('overdueOnly matches issues with an open/in_progress task past due_date, not issues with no overdue task', async () => {
      const overdue = await makeIssue(handle.db);
      const notOverdue = await makeIssue(handle.db);
      await handle.client.exec(`
        insert into tasks (issue_id, assignee_id, title, status, due_date)
        values ('${overdue.id}', 'bulk-user', 'Overdue task', 'open', '2000-01-01')
      `);
      await handle.client.exec(`
        insert into tasks (issue_id, assignee_id, title, status, due_date)
        values ('${notOverdue.id}', 'bulk-user', 'Future task', 'open', '2999-01-01')
      `);

      const result = await listIssues(handle.db, { filters: { overdueOnly: true }, today: '2026-01-01' });
      expect(result.rows.map((r) => r.issue.id)).toEqual([overdue.id]);
    });

    it('combining filters ANDs them together', async () => {
      const match = await makeIssue(handle.db, { issueType: 'covenant_violation', priority: 'urgent' });
      await makeIssue(handle.db, { issueType: 'covenant_violation', priority: 'low' });
      await makeIssue(handle.db, { issueType: 'default_recovery', priority: 'urgent' });

      const result = await listIssues(handle.db, {
        filters: { issueTypes: ['covenant_violation'], priorities: ['urgent'] },
      });
      expect(result.rows.map((r) => r.issue.id)).toEqual([match.id]);
    });
  });

  describe('search', () => {
    it('matches via summary full-text OR property display_name ILIKE prefix', async () => {
      const viaSummary = await makeIssue(handle.db, {
        summary: 'Vacant lot needs mowing before listing',
        propertyOverrides: { displayName: 'Oak Ridge Lot 12' },
      });
      const viaDisplayName = await makeIssue(handle.db, {
        summary: 'Fence repair requested by neighbor',
        propertyOverrides: { displayName: 'Vacant Meadow Tract' },
      });
      await makeIssue(handle.db, {
        summary: 'Unrelated buyer cleanup case',
        propertyOverrides: { displayName: 'Sunset Ranch' },
      });

      const result = await listIssues(handle.db, { filters: { searchText: 'vacant' } });
      const ids = result.rows.map((r) => r.issue.id).sort();
      expect(ids).toEqual([viaSummary.id, viaDisplayName.id].sort());
    });

    it('a hostile search string is safely parameterized (no throw, no match)', async () => {
      await makeIssue(handle.db, { summary: 'Ordinary case' });
      await expect(
        listIssues(handle.db, { filters: { searchText: "'; drop table issues; --" } }),
      ).resolves.toBeDefined();
      const result = await listIssues(handle.db, { filters: { searchText: "'; drop table issues; --" } });
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('sort', () => {
    it('defaults to updated_at desc, id desc when no sort is given', async () => {
      const a = await makeIssue(handle.db, { updatedAt: new Date('2026-01-01T00:00:00Z') });
      const b = await makeIssue(handle.db, { updatedAt: new Date('2026-01-03T00:00:00Z') });
      const c = await makeIssue(handle.db, { updatedAt: new Date('2026-01-02T00:00:00Z') });

      const result = await listIssues(handle.db);
      expect(result.sort).toEqual(DEFAULT_SORT);
      expect(result.rows.map((r) => r.issue.id)).toEqual([b.id, c.id, a.id]);
    });

    it('sorts by an allowlisted key, ascending', async () => {
      const a = await makeIssue(handle.db, { priority: 'urgent' });
      const b = await makeIssue(handle.db, { priority: 'low' });
      const c = await makeIssue(handle.db, { priority: 'normal' });

      const result = await listIssues(handle.db, { sort: { key: 'priority', direction: 'asc' } });
      const order = result.rows.map((r) => r.issue.id);
      // Plain text ascending: 'low' < 'normal' < 'urgent'.
      expect(order).toEqual([b.id, c.id, a.id]);
    });

    it('sorts by the nullable property_display_name key without erroring on NULL display names', async () => {
      const withName = await makeIssue(handle.db, { propertyOverrides: { displayName: 'Zephyr Tract' } });
      const withoutName = await makeIssue(handle.db, { propertyOverrides: { displayName: null } });

      const result = await listIssues(handle.db, { sort: { key: 'property_display_name', direction: 'asc' } });
      expect(result.rows.map((r) => r.issue.id)).toEqual([withoutName.id, withName.id]);
    });

    it('an unrecognized sort key falls back to the default sort key rather than throwing', async () => {
      await makeIssue(handle.db);
      const result = await listIssues(handle.db, { sort: { key: "id; drop table issues; --" } });
      expect(result.sort).toEqual(DEFAULT_SORT);
    });

    it('an unrecognized sort direction falls back to the default direction rather than throwing', async () => {
      await makeIssue(handle.db);
      const result = await listIssues(handle.db, { sort: { key: 'priority', direction: 'sideways' } });
      expect(result.sort.direction).toBe('desc');
    });
  });

  describe('pagination', () => {
    it('paginates via keyset cursor, "Load next" style, covering every row exactly once', async () => {
      const created: Issue[] = [];
      for (let i = 0; i < 5; i += 1) {
        created.push(await makeIssue(handle.db, { updatedAt: new Date(Date.UTC(2026, 0, 10 - i)) }));
      }
      // Descending updated_at: created[0] newest ... created[4] oldest.

      const page1 = await listIssues(handle.db, { limit: 2 });
      expect(page1.rows.map((r) => r.issue.id)).toEqual([created[0]!.id, created[1]!.id]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listIssues(handle.db, { limit: 2, cursor: page1.nextCursor });
      expect(page2.rows.map((r) => r.issue.id)).toEqual([created[2]!.id, created[3]!.id]);
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await listIssues(handle.db, { limit: 2, cursor: page2.nextCursor });
      expect(page3.rows.map((r) => r.issue.id)).toEqual([created[4]!.id]);
      expect(page3.nextCursor).toBeNull();
    });

    it('keyset pagination is stable under concurrent inserts: no skipped or duplicated rows across pages', async () => {
      const created: Issue[] = [];
      for (let i = 0; i < 5; i += 1) {
        created.push(await makeIssue(handle.db, { updatedAt: new Date(Date.UTC(2026, 0, 20 - i * 2)) }));
      }
      // created[0]=Jan20 (newest) ... created[4]=Jan12 (oldest), desc order.

      const page1 = await listIssues(handle.db, { limit: 2 });
      expect(page1.rows.map((r) => r.issue.id)).toEqual([created[0]!.id, created[1]!.id]);

      // Simulate a new issue arriving between page loads, sorting BEFORE the
      // cursor boundary (i.e. it would land on page 1 if refetched from
      // scratch) — it must not leak into page 2, and must not push a
      // legitimate page-2 row out.
      const inserted = await makeIssue(handle.db, { updatedAt: new Date(Date.UTC(2026, 0, 19)) });
      // And one sorting AFTER everything already fetched, which must not
      // cause page 2 to skip anything either.
      const insertedOld = await makeIssue(handle.db, { updatedAt: new Date(Date.UTC(2026, 0, 1)) });

      const page2 = await listIssues(handle.db, { limit: 2, cursor: page1.nextCursor });
      expect(page2.rows.map((r) => r.issue.id)).toEqual([created[2]!.id, created[3]!.id]);
      expect(page2.rows.map((r) => r.issue.id)).not.toContain(inserted.id);

      const page3 = await listIssues(handle.db, { limit: 2, cursor: page2.nextCursor });
      // Two rows remain after the created[3] boundary: created[4] (Jan 12)
      // and insertedOld (Jan 1, older still) — both correctly belong on
      // this page under desc order; insertedOld arriving after page 1/2
      // were already fetched does not cause anything to be skipped.
      expect(page3.rows.map((r) => r.issue.id)).toEqual([created[4]!.id, insertedOld.id]);
      expect(page3.nextCursor).toBeNull();

      // Refetching from scratch now sees all 7 rows, with `inserted` between
      // created[0] and created[1], confirming pages 1-3 above were a
      // consistent snapshot of the original 5, not a corrupted mix.
      const fresh = await listIssues(handle.db, { limit: 10 });
      expect(fresh.rows.map((r) => r.issue.id)).toEqual([
        created[0]!.id,
        inserted.id,
        created[1]!.id,
        created[2]!.id,
        created[3]!.id,
        created[4]!.id,
        insertedOld.id,
      ]);
    });

    it('a malformed cursor (garbage base64/JSON) falls back to the first page rather than throwing', async () => {
      const a = await makeIssue(handle.db, { updatedAt: new Date('2026-01-02T00:00:00Z') });
      const b = await makeIssue(handle.db, { updatedAt: new Date('2026-01-01T00:00:00Z') });

      const withGarbage = await listIssues(handle.db, { cursor: 'not-valid-base64url-json!!!' });
      const withNoCursor = await listIssues(handle.db);
      expect(withGarbage.rows.map((r: IssueListRow) => r.issue.id)).toEqual(withNoCursor.rows.map((r) => r.issue.id));
      expect(withGarbage.rows.map((r) => r.issue.id)).toEqual([a.id, b.id]);
    });

    it('a structurally-valid cursor whose sortValue does not fit the current sort falls back to the first page', async () => {
      await makeIssue(handle.db);
      // A cursor minted for a text sort key (garbage as a timestamp) reused
      // against the default (timestamp) sort.
      const bogusTimestampCursor = Buffer.from(JSON.stringify(['not-a-timestamp', '11111111-1111-1111-1111-111111111111'])).toString(
        'base64url',
      );
      await expect(listIssues(handle.db, { cursor: bogusTimestampCursor })).resolves.toBeDefined();
    });

    it('limit is clamped to a sane bound and a non-numeric limit falls back to the default', async () => {
      for (let i = 0; i < 3; i += 1) {
        await makeIssue(handle.db);
      }
      const result = await listIssues(handle.db, { limit: -5 });
      expect(result.rows).toHaveLength(3);
      const result2 = await listIssues(handle.db, { limit: Number.NaN });
      expect(result2.rows).toHaveLength(3);
    });
  });

  describe('countIssues', () => {
    it('matches the true total across paginated listIssues calls, for the same filters', async () => {
      for (let i = 0; i < 7; i += 1) {
        await makeIssue(handle.db, { priority: 'urgent', updatedAt: new Date(Date.UTC(2026, 0, 1 + i)) });
      }
      await makeIssue(handle.db, { priority: 'low' });

      const total = await countIssues(handle.db, { filters: { priorities: ['urgent'] } });
      expect(total).toBe(7);

      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await listIssues(handle.db, { filters: { priorities: ['urgent'] }, limit: 3, cursor });
        for (const row of page.rows) seen.add(row.issue.id);
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen.size).toBe(total);
    });

    it('respects the same filters as listIssues (zero when nothing matches)', async () => {
      await makeIssue(handle.db, { priority: 'low' });
      const total = await countIssues(handle.db, { filters: { priorities: ['urgent'] } });
      expect(total).toBe(0);
    });
  });

  describe('malformed filter input', () => {
    it('non-array / wrong-typed filter values are dropped, not thrown', async () => {
      await makeIssue(handle.db);
      // @ts-expect-error deliberately hostile shapes to prove the repo never throws on them
      await expect(listIssues(handle.db, { filters: { issueTypes: 'not-an-array', priorities: [{ evil: true }] } })).resolves.toBeDefined();
    });

    it('an issueType value not in the CHECK-constraint allowlist matches nothing rather than erroring', async () => {
      await makeIssue(handle.db, { issueType: 'covenant_violation' });
      const result = await listIssues(handle.db, { filters: { issueTypes: ['not_a_real_type'] } });
      expect(result.rows).toHaveLength(0);
    });
  });
});
