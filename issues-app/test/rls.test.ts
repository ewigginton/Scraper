/**
 * rls.test.ts — RLS smoke tests (policy presence + role write denial), per
 * DESIGN.md §9. Previously there was NO test file for
 * supabase/migrations/20260731090200_issues_rls.sql at all, and the
 * scaffold was inert in the running application (adversarial-review
 * finding): no code ever set the app.actor_id/app.roles GUCs the policies
 * read, RLS was enabled-but-not-FORCEd on every table except audit_events/
 * evidence_files, and the connecting role in every environment (test AND
 * the app's own Postgres connection) is the table owner, which bypasses
 * non-forced RLS entirely.
 *
 * These tests connect as a NON-owner, NON-superuser role (created here,
 * mirroring what a real non-owner DATABASE_URL role looks like) so RLS
 * policies actually govern the connection, the same way they would in a
 * correctly configured deployment. PGlite (like real Postgres) supports
 * CREATE ROLE / SET ROLE and enforces RLS for a non-superuser role exactly
 * as documented, including under FORCE ROW LEVEL SECURITY.
 *
 * setActorContext (test/helpers/pglite.ts) sets the app.actor_id/app.roles
 * GUCs with is_local=true (matching lib/db/actor-context.ts, the
 * production helper) — i.e. it only takes effect for the REST OF THE
 * CURRENT TRANSACTION. Every scenario below therefore runs inside an
 * explicit handle.db.transaction(...), exactly like a real server action
 * would via db.transaction(tx => { setActorContext(tx, ...); ... }).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, configEntries, configVersions, evidenceFiles, holds, issues, personRefs } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, setActorContext, type TestDbHandle } from './helpers/pglite.ts';
import { makeProperty } from './helpers/fixtures.ts';

const TEST_ROLE = 'issues_rls_test_role';

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


describe('RLS smoke tests (policy presence + role write denial)', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
    // A non-owner, non-superuser role, mirroring what DATABASE_URL should
    // point at in any real deployment (adversarial-review finding: the
    // table-owner/superuser connection this app used everywhere bypasses
    // RLS regardless of FORCE). Grants are the table-level privileges a
    // real deployment's non-owner role would need — RLS policies then
    // additionally restrict WHICH rows/verbs those grants actually allow.
    await handle.client.exec(`create role ${TEST_ROLE} nosuperuser noinherit login;`);
    await handle.client.exec(
      `grant select, insert, update, delete on issues, holds, evidence_files, config_versions, config_entries, audit_events, property_refs, person_refs to ${TEST_ROLE};`,
    );
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('FORCE ROW LEVEL SECURITY is set on every case table plus payment_requests/config_versions/config_entries', async () => {
    const forcedTables = ['issues', 'holds', 'tasks', 'evidence_files', 'audit_events', 'payment_requests', 'config_versions', 'config_entries', 'vendors', 'bids'];
    for (const table of forcedTables) {
      const result = await handle.db.execute(
        `select relforcerowsecurity from pg_class where relname = '${table}' and relnamespace = 'public'::regnamespace`,
      );
      const rows = (result as unknown as { rows: Array<{ relforcerowsecurity: boolean }> }).rows ?? (result as unknown as Array<{ relforcerowsecurity: boolean }>);
      expect(rows[0]?.relforcerowsecurity, `expected FORCE ROW LEVEL SECURITY on "${table}"`).toBe(true);
    }
  });

  it('(a) a sales-role actor cannot insert into issues or holds (coordinator/manager/admin required)', async () => {
    const property = await makeProperty(handle.db);
    await handle.client.exec(`set role ${TEST_ROLE};`);

    await expectRlsDenied(
      handle.db.transaction(async (tx) => {
        await setActorContext(tx, 'actor-sales', ['sales']);
        await tx.insert(issues).values({
          issueType: 'default_recovery',
          propertyRefId: property.id,
          summary: 'Should be blocked by RLS',
          lifecycleStatus: 'intake',
        });
      }),
    );

    await expectRlsDenied(
      handle.db.transaction(async (tx) => {
        await setActorContext(tx, 'actor-sales', ['sales']);
        await tx.insert(holds).values({
          propertyRefId: property.id,
          holdType: 'other',
          reason: 'Should be blocked by RLS',
        });
      }),
    );
  });

  it('a coordinator-role actor CAN insert into issues (positive control, proves the denial above is role-specific, not a blanket failure)', async () => {
    const property = await makeProperty(handle.db);
    await handle.client.exec(`set role ${TEST_ROLE};`);

    await expect(
      handle.db.transaction(async (tx) => {
        await setActorContext(tx, 'actor-coordinator', ['coordinator']);
        await tx.insert(issues).values({
          issueType: 'default_recovery',
          propertyRefId: property.id,
          summary: 'Coordinator-created issue',
          lifecycleStatus: 'intake',
        });
      }),
    ).resolves.not.toThrow();
  });

  it('(b) a non-admin (manager) cannot insert config_entries; admin can', async () => {
    const [version] = await handle.db
      .select({ id: configVersions.id })
      .from(configVersions)
      .orderBy(configVersions.effectiveFrom)
      .limit(1);
    expect(version?.id).toBeTruthy();

    await handle.client.exec(`set role ${TEST_ROLE};`);

    await expectRlsDenied(
      handle.db.transaction(async (tx) => {
        await setActorContext(tx, 'actor-manager', ['manager']);
        await tx.insert(configEntries).values({ configVersionId: version!.id, entryKey: 'test_entry_manager', entryValue: {} });
      }),
    );

    await expect(
      handle.db.transaction(async (tx) => {
        await setActorContext(tx, 'actor-admin', ['admin']);
        await tx.insert(configEntries).values({ configVersionId: version!.id, entryKey: 'test_entry_admin', entryValue: {} });
      }),
    ).resolves.not.toThrow();
  });

  it('(c) a restricted_legal evidence_files row is invisible to a non-manager, visible to a manager', async () => {
    // Inserted as the table owner (this connection, before switching role)
    // so the insert itself isn't gated by the case-role insert policy.
    const [internalRow] = await handle.db.insert(evidenceFiles).values({ storageRef: 'internal/1', accessClassification: 'internal' }).returning();
    const [restrictedRow] = await handle.db.insert(evidenceFiles).values({ storageRef: 'restricted/1', accessClassification: 'restricted_legal' }).returning();
    expect(internalRow).toBeDefined();
    expect(restrictedRow).toBeDefined();

    await handle.client.exec(`set role ${TEST_ROLE};`);

    const visibleToCoordinator = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-coordinator', ['coordinator']);
      return tx.select().from(evidenceFiles);
    });
    expect(visibleToCoordinator.some((r) => r.id === internalRow!.id)).toBe(true);
    expect(visibleToCoordinator.some((r) => r.id === restrictedRow!.id)).toBe(false);

    const visibleToManager = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-manager', ['manager']);
      return tx.select().from(evidenceFiles);
    });
    expect(visibleToManager.some((r) => r.id === internalRow!.id)).toBe(true);
    expect(visibleToManager.some((r) => r.id === restrictedRow!.id)).toBe(true);
  });

  it('(d) update/delete on audit_events is denied even under an authorized role (append-only, no policy permits it)', async () => {
    const property = await makeProperty(handle.db);
    const [row] = await handle.db.insert(auditEvents).values({ action: 'test_action', objectTable: 'issues', objectId: property.id }).returning();
    expect(row).toBeDefined();

    await handle.client.exec(`set role ${TEST_ROLE};`);

    // There is deliberately no UPDATE/DELETE policy on audit_events at all
    // (20260731090200_issues_rls.sql), so under FORCE ROW LEVEL SECURITY
    // the row is simply invisible to the UPDATE/DELETE's USING clause —
    // the statement "succeeds" but matches and changes zero rows, rather
    // than throwing (the append-only trigger from the previous migration
    // never even fires, because there is no row to fire it on). The
    // meaningful assertion is that the row survives unchanged, which is
    // exactly the "ordinary users cannot alter or delete audit events"
    // guarantee spec §29.2/§12 wants.
    await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-admin', ['admin']);
      await tx.update(auditEvents).set({ action: 'tampered' }).where(eq(auditEvents.id, row!.id));
    });
    await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-admin', ['admin']);
      await tx.delete(auditEvents).where(eq(auditEvents.id, row!.id));
    });

    const [stillThere] = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-admin', ['admin']);
      return tx.select().from(auditEvents).where(eq(auditEvents.id, row!.id));
    });
    expect(stillThere).toBeDefined();
    expect(stillThere?.action).toBe('test_action');
  });

  it('sanity: person_refs SELECT works under the test role (grants above are sufficient to exercise the FK-referencing tests above)', async () => {
    await handle.client.exec(`set role ${TEST_ROLE};`);
    const rows = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-coordinator', ['coordinator']);
      return tx.select().from(personRefs);
    });
    expect(Array.isArray(rows)).toBe(true);
  });
});
