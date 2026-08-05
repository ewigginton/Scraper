/**
 * role-grants.test.ts — regression coverage for the "zero GRANT/CREATE
 * ROLE statements anywhere" adversarial-review finding
 * (20260731090700_issues_app_role_grants.sql). Before this migration, the
 * only role that could run this application at all was the table
 * owner/superuser applying the migrations — which silently bypasses every
 * RLS policy in supabase/migrations/20260731090200_issues_rls.sql /
 * 20260731090500_issues_rls_audit_hardening.sql, regardless of FORCE ROW
 * LEVEL SECURITY.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, setActorContext, type TestDbHandle } from './helpers/pglite.ts';
import { makeProperty } from './helpers/fixtures.ts';

interface Row {
  [key: string]: unknown;
}

function rowsOf(result: unknown): Row[] {
  return (result as { rows?: Row[] }).rows ?? (result as Row[]);
}

describe('20260731090700_issues_app_role_grants.sql', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('creates the issues_app role as nosuperuser/nobypassrls/nologin', async () => {
    const result = await handle.db.execute(
      "select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'issues_app'",
    );
    const rows = rowsOf(result);
    expect(rows.length).toBe(1);
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolcanlogin).toBe(false);
  });

  it('grants issues_app select/insert/update (but NOT delete) on case tables', async () => {
    for (const table of ['issues', 'holds', 'audit_events', 'possession_records', 'payment_requests']) {
      const result = await handle.db.execute(
        `select privilege_type from information_schema.role_table_grants where grantee = 'issues_app' and table_name = '${table}'`,
      );
      const privileges = rowsOf(result).map((r) => r.privilege_type);
      expect(privileges, `expected SELECT on ${table}`).toContain('SELECT');
      expect(privileges, `expected INSERT on ${table}`).toContain('INSERT');
      expect(privileges, `expected UPDATE on ${table}`).toContain('UPDATE');
      expect(privileges, `expected NO DELETE grant on ${table} (nothing in this schema is hard-deleted)`).not.toContain('DELETE');
    }
  });

  it('grants issues_app execute on issues_current_actor() and issues_current_roles()', async () => {
    for (const fn of ['issues_current_actor', 'issues_current_roles']) {
      const result = await handle.db.execute(
        `select has_function_privilege('issues_app', '${fn}()', 'execute') as can_execute`,
      );
      expect(rowsOf(result)[0]?.can_execute).toBe(true);
    }
  });

  /**
   * ROUND-2 ADVERSARIAL-REVIEW FIX: the original version of this test used
   * a made-up `property_ref_id = gen_random_uuid()`, so its insert failed
   * on the `issues.property_ref_id` FK constraint before RLS was ever
   * consulted — the test's own comment conceded "Either the FK ... fails,
   * or (if it somehow didn't) RLS would reject", and `expect(thrown).
   * toBeDefined()` passed either way. Dropping every policy created by
   * 20260731090200_issues_rls.sql would not change the result: this proved
   * nothing about RLS actually governing the issues_app connection.
   *
   * Fixed by inserting a REAL property_refs row first (so the FK is
   * satisfied and can never be the reason for a rejection), then asserting
   * the three behaviors that actually distinguish "RLS governs this
   * connection" from "it doesn't": (a) no actor context -> rejected by RLS
   * specifically (message matches /row-level security/), (b) a
   * coordinator-context insert succeeds, (c) a sales-context insert (not in
   * the case-table insert policy's role list) is rejected by RLS too, not
   * merely by the FK (which sales's insert also satisfies).
   */
  it('a real connection as issues_app is governed by RLS: no-actor-context is rejected by RLS, coordinator succeeds, sales is rejected by RLS', async () => {
    const property = await makeProperty(handle.db);
    await handle.client.exec('set role issues_app;');

    // (a) No actor context at all -> issues_current_actor() is null ->
    // issues_insert_case_roles's `issues_current_roles() && array[...]`
    // check fails (an empty/null roles array intersects nothing) and RLS
    // itself rejects the insert. The FK is satisfied (real property.id), so
    // this rejection can ONLY be RLS.
    let thrownNoActor: unknown;
    try {
      await handle.db.execute(
        `insert into issues (issue_type, property_ref_id, summary, priority, lifecycle_status) values ('default_recovery', '${property.id}', 'test', 'normal', 'intake')`,
      );
    } catch (err) {
      thrownNoActor = err;
    }
    expect(thrownNoActor, 'expected RLS to reject an insert with no actor context').toBeDefined();
    const noActorCause = thrownNoActor instanceof Error ? (thrownNoActor as Error & { cause?: unknown }).cause : undefined;
    const noActorMessage =
      thrownNoActor instanceof Error ? `${thrownNoActor.message} ${noActorCause instanceof Error ? noActorCause.message : ''}` : String(thrownNoActor);
    expect(noActorMessage).toMatch(/row-level security/i);

    // (b) A coordinator-context insert succeeds — proves the policy DOES
    // let the intended role through, not merely reject everything.
    const coordinatorIssueId = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-coordinator', ['coordinator']);
      const result = await tx.execute(
        `insert into issues (issue_type, property_ref_id, summary, priority, lifecycle_status) values ('default_recovery', '${property.id}', 'test', 'normal', 'intake') returning id`,
      );
      const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows ?? (result as unknown as Array<{ id: string }>);
      return rows[0]?.id;
    });
    expect(coordinatorIssueId).toBeDefined();

    // (c) A sales-context insert is rejected — 'sales' is not in
    // issues_insert_case_roles's role list. The FK is satisfied (same real
    // property.id) so this rejection, too, can only be RLS.
    let thrownSales: unknown;
    try {
      await handle.db.transaction(async (tx) => {
        await setActorContext(tx, 'actor-sales', ['sales']);
        await tx.execute(
          `insert into issues (issue_type, property_ref_id, summary, priority, lifecycle_status) values ('default_recovery', '${property.id}', 'test', 'normal', 'intake')`,
        );
      });
    } catch (err) {
      thrownSales = err;
    }
    expect(thrownSales, 'expected RLS to reject an insert from a role (sales) not covered by issues_insert_case_roles').toBeDefined();
    const salesCause = thrownSales instanceof Error ? (thrownSales as Error & { cause?: unknown }).cause : undefined;
    const salesMessage = thrownSales instanceof Error ? `${thrownSales.message} ${salesCause instanceof Error ? salesCause.message : ''}` : String(thrownSales);
    expect(salesMessage).toMatch(/row-level security/i);
  });
});
