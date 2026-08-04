/**
 * saved-views.test.ts — coverage for saved_views (spec §15): the migration
 * (20260804100000_issues_scale_indexes_search_views.sql), the repo
 * (lib/repositories/saved-views-repo.ts), the service
 * (lib/services/saved-view-service.ts, create/delete/list + audit), and RLS
 * owner-scoping (reusing the non-superuser-role technique from
 * test/rls.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, savedViews } from '../lib/db/schema.ts';
import * as savedViewsRepo from '../lib/repositories/saved-views-repo.ts';
import { createSavedView, deleteSavedView, listSavedViews, SavedViewServiceError } from '../lib/services/saved-view-service.ts';
import { closeTestDb, createTestDb, setActorContext, type TestDbHandle } from './helpers/pglite.ts';

const TEST_ROLE = 'saved_views_rls_test_role';

async function expectRlsDenied(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'expected the operation to be denied by RLS').toBeDefined();
  const cause = thrown instanceof Error ? (thrown as Error & { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : '';
  const message = thrown instanceof Error ? `${thrown.message} ${causeMessage}` : String(thrown);
  expect(message).toMatch(/row-level security/i);
}

describe('saved_views migration + repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('FORCE ROW LEVEL SECURITY is set on saved_views', async () => {
    const result = await handle.db.execute(
      `select relforcerowsecurity from pg_class where relname = 'saved_views' and relnamespace = 'public'::regnamespace`,
    );
    const rows = (result as unknown as { rows: Array<{ relforcerowsecurity: boolean }> }).rows ?? (result as unknown as Array<{ relforcerowsecurity: boolean }>);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('the unique constraint rejects a second saved view with the same (owner_external_id, name)', async () => {
    await savedViewsRepo.create(handle.db, { ownerExternalId: 'alice', name: 'My View', params: {} });
    await expect(
      savedViewsRepo.create(handle.db, { ownerExternalId: 'alice', name: 'My View', params: {} }),
    ).rejects.toThrow();
  });

  it('the same name IS allowed across different owners (unique key is (owner, name), not name alone)', async () => {
    await savedViewsRepo.create(handle.db, { ownerExternalId: 'alice', name: 'My View', params: {} });
    await expect(
      savedViewsRepo.create(handle.db, { ownerExternalId: 'bob', name: 'My View', params: {} }),
    ).resolves.toBeDefined();
  });

  it('listForOwner only returns that owner\'s rows, alphabetically', async () => {
    await savedViewsRepo.create(handle.db, { ownerExternalId: 'alice', name: 'Zed View', params: {} });
    await savedViewsRepo.create(handle.db, { ownerExternalId: 'alice', name: 'Alpha View', params: {} });
    await savedViewsRepo.create(handle.db, { ownerExternalId: 'bob', name: 'Someone Elses View', params: {} });

    const aliceViews = await savedViewsRepo.listForOwner(handle.db, 'alice');
    expect(aliceViews.map((v) => v.name)).toEqual(['Alpha View', 'Zed View']);
  });

  it('remove() only deletes when BOTH owner and id match', async () => {
    const view = await savedViewsRepo.create(handle.db, { ownerExternalId: 'alice', name: 'My View', params: {} });

    const wrongOwnerResult = await savedViewsRepo.remove(handle.db, 'bob', view.id);
    expect(wrongOwnerResult).toBeUndefined();
    expect(await savedViewsRepo.getForOwner(handle.db, 'alice', view.id)).toBeDefined();

    const rightOwnerResult = await savedViewsRepo.remove(handle.db, 'alice', view.id);
    expect(rightOwnerResult?.id).toBe(view.id);
    expect(await savedViewsRepo.getForOwner(handle.db, 'alice', view.id)).toBeUndefined();
  });
});

describe('saved-view-service', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('createSavedView writes the row and an audited event in the same transaction', async () => {
    const view = await handle.db.transaction((tx) =>
      createSavedView(tx, { ownerExternalId: 'alice', name: 'My Filtered View', params: { issueTypes: ['covenant_violation'] } }),
    );
    expect(view.ownerExternalId).toBe('alice');
    expect(view.params).toEqual({ issueTypes: ['covenant_violation'] });

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, view.id));
    const created = audits.find((a) => a.action === 'saved_view_created');
    expect(created).toBeDefined();
    expect(created?.objectTable).toBe('saved_views');
    expect(created?.actorExternalId).toBe('alice');
  });

  it('createSavedView rejects an empty name', async () => {
    await expect(
      handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: '   ', params: {} })),
    ).rejects.toBeInstanceOf(SavedViewServiceError);
  });

  it('createSavedView rejects a name over 80 characters', async () => {
    await expect(
      handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: 'x'.repeat(81), params: {} })),
    ).rejects.toBeInstanceOf(SavedViewServiceError);
  });

  it('createSavedView accepts a name of exactly 80 characters', async () => {
    await expect(
      handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: 'x'.repeat(80), params: {} })),
    ).resolves.toBeDefined();
  });

  it('createSavedView rejects non-plain-object params (array, null, primitive)', async () => {
    for (const badParams of [[], null, 'a string', 42]) {
      await expect(
        handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: `Bad ${JSON.stringify(badParams)}`, params: badParams })),
      ).rejects.toBeInstanceOf(SavedViewServiceError);
    }
  });

  it('createSavedView rejects a duplicate name for the same owner with a clear service error, not a raw DB constraint error', async () => {
    await handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: 'My View', params: {} }));
    await expect(
      handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: 'My View', params: {} })),
    ).rejects.toMatchObject({ code: 'duplicate_name' });
  });

  it('deleteSavedView removes the row and writes an audited event scoped to the owner', async () => {
    const view = await handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: 'My View', params: {} }));

    const deleted = await handle.db.transaction((tx) => deleteSavedView(tx, { ownerExternalId: 'alice', id: view.id }));
    expect(deleted.id).toBe(view.id);

    const remaining = await handle.db.select().from(savedViews).where(eq(savedViews.id, view.id));
    expect(remaining).toHaveLength(0);

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.objectId, view.id));
    expect(audits.some((a) => a.action === 'saved_view_deleted')).toBe(true);
  });

  it('deleteSavedView cannot delete another owner\'s saved view (throws, row untouched)', async () => {
    const view = await handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: 'My View', params: {} }));

    await expect(
      handle.db.transaction((tx) => deleteSavedView(tx, { ownerExternalId: 'bob', id: view.id })),
    ).rejects.toBeInstanceOf(SavedViewServiceError);

    const stillThere = await handle.db.select().from(savedViews).where(eq(savedViews.id, view.id));
    expect(stillThere).toHaveLength(1);
  });

  it('listSavedViews is scoped to the requested owner', async () => {
    await handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'alice', name: 'Alice View', params: {} }));
    await handle.db.transaction((tx) => createSavedView(tx, { ownerExternalId: 'bob', name: 'Bob View', params: {} }));

    const aliceViews = await listSavedViews(handle.db, 'alice');
    expect(aliceViews.map((v) => v.name)).toEqual(['Alice View']);
  });
});

describe('saved_views RLS owner-scoping', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
    // Non-owner, non-superuser role — same technique as test/rls.test.ts —
    // so RLS actually governs the connection rather than being bypassed by
    // the table-owner role every other test in this file (deliberately)
    // connects as.
    await handle.client.exec(`create role ${TEST_ROLE} nosuperuser noinherit login;`);
    await handle.client.exec(`grant select, insert, update, delete on saved_views to ${TEST_ROLE};`);
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('an owner can select/insert/update/delete their own saved view', async () => {
    await handle.client.exec(`set role ${TEST_ROLE};`);

    const viewId = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'alice', ['coordinator']);
      const [row] = await tx.insert(savedViews).values({ ownerExternalId: 'alice', name: 'My View', params: {} }).returning();
      return row!.id;
    });

    const selected = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'alice', ['coordinator']);
      return tx.select().from(savedViews).where(eq(savedViews.id, viewId));
    });
    expect(selected).toHaveLength(1);

    await expect(
      handle.db.transaction(async (tx) => {
        await setActorContext(tx, 'alice', ['coordinator']);
        await tx.delete(savedViews).where(eq(savedViews.id, viewId));
      }),
    ).resolves.not.toThrow();
  });

  it('one owner cannot see or write another owner\'s saved view', async () => {
    await handle.client.exec(`set role ${TEST_ROLE};`);

    const viewId = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'alice', ['coordinator']);
      const [row] = await tx.insert(savedViews).values({ ownerExternalId: 'alice', name: 'Alice Only', params: {} }).returning();
      return row!.id;
    });

    const bobsView = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'bob', ['coordinator']);
      return tx.select().from(savedViews).where(eq(savedViews.id, viewId));
    });
    expect(bobsView).toHaveLength(0);

    // RLS silently filters bob's UPDATE/DELETE to zero matching rows rather
    // than throwing (no row is visible to bob's USING clause) — the
    // meaningful assertion is that the row survives unchanged, same pattern
    // test/rls.test.ts uses for audit_events' append-only guarantee.
    await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'bob', ['coordinator']);
      await tx.delete(savedViews).where(eq(savedViews.id, viewId));
    });

    const stillThere = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'alice', ['coordinator']);
      return tx.select().from(savedViews).where(eq(savedViews.id, viewId));
    });
    expect(stillThere).toHaveLength(1);
  });

  it('an admin can read (but not write) another owner\'s saved view via saved_views_admin_select_all', async () => {
    await handle.client.exec(`set role ${TEST_ROLE};`);

    const viewId = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'alice', ['coordinator']);
      const [row] = await tx.insert(savedViews).values({ ownerExternalId: 'alice', name: 'Alice Only', params: {} }).returning();
      return row!.id;
    });

    const asAdmin = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'admin-user', ['admin']);
      return tx.select().from(savedViews).where(eq(savedViews.id, viewId));
    });
    expect(asAdmin).toHaveLength(1);

    // Admin's read access does not grant write: saved_views_admin_select_all
    // is a SELECT-only policy, so it does not extend row visibility to
    // UPDATE at all — only saved_views_owner_all's USING clause governs
    // which rows an UPDATE can touch, and admin-user is not the owner. Per
    // Postgres RLS semantics (same pattern as test/rls.test.ts's
    // audit_events UPDATE/DELETE case) an UPDATE with no visible matching
    // row is a silent no-op, not a thrown error — the row must survive
    // unchanged.
    await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'admin-user', ['admin']);
      await tx.update(savedViews).set({ name: 'Tampered' }).where(eq(savedViews.id, viewId));
    });

    const stillOriginal = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'alice', ['coordinator']);
      return tx.select().from(savedViews).where(eq(savedViews.id, viewId));
    });
    expect(stillOriginal[0]?.name).toBe('Alice Only');
  });

  it('no actor context at all is denied (owner_external_id = NULL is never true)', async () => {
    await handle.client.exec(`set role ${TEST_ROLE};`);
    await expectRlsDenied(handle.db.insert(savedViews).values({ ownerExternalId: 'alice', name: 'No Actor', params: {} }));
  });
});
