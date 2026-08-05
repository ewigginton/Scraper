/**
 * contract-refs.test.ts — coverage for lib/repositories/contract-refs-repo.ts
 * and supabase/migrations/20260804120000_issues_contract_refs.sql's RLS
 * shape (Wave 2b roadmap: "Case left-panel contract/transaction overview +
 * CRM links"). Mirrors test/reference-data.test.ts's repo-test idiom and
 * test/rls.test.ts's policy-presence idiom.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractRefs } from '../lib/db/schema.ts';
import * as contractRefsRepo from '../lib/repositories/contract-refs-repo.ts';
import { closeTestDb, createTestDb, setActorContext, type TestDbHandle } from './helpers/pglite.ts';
import { makePerson, makeProperty } from './helpers/fixtures.ts';

async function makeContract(handle: TestDbHandle, overrides: Partial<typeof contractRefs.$inferInsert> = {}) {
  const property = overrides.propertyRefId ? undefined : await makeProperty(handle.db);
  const [row] = await handle.db
    .insert(contractRefs)
    .values({
      sourceSystem: 'test',
      externalId: `contract-${Math.random().toString(36).slice(2, 8)}`,
      propertyRefId: property?.id as string,
      contractNumber: 'CCL-2026-00001',
      statusCached: 'Executed',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeContract: insert returned no row');
  return { row, property };
}

describe('contract-refs-repo', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  describe('getForProperty', () => {
    it('returns contract_refs rows for the given property, newest executed_date first', async () => {
      const property = await makeProperty(handle.db);
      const older = await makeContract(handle, { propertyRefId: property.id, contractNumber: 'OLD-1', executedDate: '2025-01-01' });
      const newer = await makeContract(handle, { propertyRefId: property.id, contractNumber: 'NEW-1', executedDate: '2026-01-01' });

      const rows = await contractRefsRepo.getForProperty(handle.db, property.id);
      expect(rows.map((r) => r.id)).toEqual([newer.row.id, older.row.id]);
    });

    it('sorts a null executed_date (draft/unexecuted) AFTER a real executed_date, not before', async () => {
      // Regression for the NULLS FIRST default: ORDER BY executed_date DESC
      // in Postgres puts NULLs first unless NULLS LAST is explicit, which
      // would surface an unexecuted draft contract as "primary" ahead of
      // an actually-executed one.
      const property = await makeProperty(handle.db);
      const executed = await makeContract(handle, {
        propertyRefId: property.id,
        contractNumber: 'EXECUTED-1',
        statusCached: 'Executed',
        executedDate: '2025-01-01',
      });
      const draft = await makeContract(handle, {
        propertyRefId: property.id,
        contractNumber: 'DRAFT-1',
        statusCached: 'Draft',
        executedDate: null,
      });

      const rows = await contractRefsRepo.getForProperty(handle.db, property.id);
      expect(rows.map((r) => r.id)).toEqual([executed.row.id, draft.row.id]);
    });

    it('returns an empty array for a property with no contracts', async () => {
      const property = await makeProperty(handle.db);
      const rows = await contractRefsRepo.getForProperty(handle.db, property.id);
      expect(rows).toEqual([]);
    });

    it('returns an empty array for a non-uuid id rather than throwing', async () => {
      const rows = await contractRefsRepo.getForProperty(handle.db, 'not-a-uuid');
      expect(rows).toEqual([]);
    });

    it('does not return another property\'s contracts', async () => {
      const propA = await makeProperty(handle.db);
      const propB = await makeProperty(handle.db);
      await makeContract(handle, { propertyRefId: propA.id });
      const rowsForB = await contractRefsRepo.getForProperty(handle.db, propB.id);
      expect(rowsForB).toEqual([]);
    });
  });

  describe('getById', () => {
    it('returns the row for a real id', async () => {
      const { row } = await makeContract(handle);
      const found = await contractRefsRepo.getById(handle.db, row.id);
      expect(found?.id).toBe(row.id);
    });

    it('returns null for a missing id', async () => {
      const found = await contractRefsRepo.getById(handle.db, '00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });

    it('returns null for a non-uuid id rather than throwing', async () => {
      const found = await contractRefsRepo.getById(handle.db, 'not-a-uuid');
      expect(found).toBeNull();
    });
  });

  it('buyer_person_ref_id links to person_refs when set', async () => {
    const property = await makeProperty(handle.db);
    const buyer = await makePerson(handle.db, { displayName: 'Demo Buyer' });
    const { row } = await makeContract(handle, { propertyRefId: property.id, buyerPersonRefId: buyer.id });
    const found = await contractRefsRepo.getById(handle.db, row.id);
    expect(found?.buyerPersonRefId).toBe(buyer.id);
  });
});

describe('contract_refs RLS (mirrors property_refs/person_refs shape)', () => {
  let handle: TestDbHandle;
  const TEST_ROLE = 'contract_refs_rls_test_role';

  beforeEach(async () => {
    handle = await createTestDb();
    await handle.client.exec(`create role ${TEST_ROLE} nosuperuser noinherit login;`);
    await handle.client.exec(`grant select, insert, update on contract_refs, property_refs to ${TEST_ROLE};`);
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('RLS is enabled and FORCEd on contract_refs', async () => {
    const result = await handle.db.execute(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'contract_refs' and relnamespace = 'public'::regnamespace`,
    );
    const rows = (result as unknown as { rows: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> }).rows ?? (result as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>);
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('the broad-internal SELECT policy exists on contract_refs', async () => {
    const result = await handle.db.execute(
      `select polname from pg_policy where polrelid = 'contract_refs'::regclass`,
    );
    const rows = (result as unknown as { rows: Array<{ polname: string }> }).rows ?? (result as unknown as Array<{ polname: string }>);
    expect(rows.map((r) => r.polname)).toContain('contract_refs_select_broad_internal');
  });

  it('SELECT is denied with no actor context set (broad-internal policy requires issues_current_actor())', async () => {
    const property = await makeProperty(handle.db);
    await makeContract(handle, { propertyRefId: property.id });

    await handle.client.exec(`set role ${TEST_ROLE};`);
    const rows = await handle.db.execute(`select * from contract_refs`);
    const resultRows = (rows as unknown as { rows: unknown[] }).rows ?? (rows as unknown as unknown[]);
    expect(resultRows.length).toBe(0);
    await handle.client.exec(`reset role;`);
  });

  it('SELECT succeeds once actor context is set', async () => {
    const property = await makeProperty(handle.db);
    await makeContract(handle, { propertyRefId: property.id });

    await handle.client.exec(`set role ${TEST_ROLE};`);
    const resultRows = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'test-actor', ['coordinator']);
      return tx.select().from(contractRefs);
    });
    expect(resultRows.length).toBe(1);
  });

  it('issues_app has no insert/update grant on contract_refs (read-only per this migration)', async () => {
    const result = await handle.db.execute(
      `select privilege_type from information_schema.role_table_grants where table_name = 'contract_refs' and grantee = 'issues_app'`,
    );
    const rows = (result as unknown as { rows: Array<{ privilege_type: string }> }).rows ?? (result as unknown as Array<{ privilege_type: string }>);
    const privileges = rows.map((r) => r.privilege_type);
    expect(privileges).toContain('SELECT');
    expect(privileges).not.toContain('INSERT');
    expect(privileges).not.toContain('UPDATE');
  });
});
