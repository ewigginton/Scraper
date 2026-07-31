import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeTestDb, createTestDb, listMigrationFiles, type TestDbHandle } from './helpers/pglite.ts';

describe('migrations', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('lists at least the four expected migration files in timestamp order', () => {
    const files = listMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(sorted);
    expect(files[0]).toMatch(/issues_core\.sql$/);
  });

  it('replays cleanly and creates the core tables', async () => {
    const coreTables = [
      'property_refs',
      'person_refs',
      'issues',
      'issue_people',
      'issue_cycles',
      'phase_instances',
      'tasks',
      'holds',
      'possession_records',
      'personal_property_items',
      'issue_relationships',
      'stale_acknowledgments',
      'deadlines',
      'vendors',
      'bids',
      'vendor_jobs',
      'change_orders',
      'cost_entries',
      'payment_requests',
      'approvals',
      'evidence_files',
      'communication_events',
      'communication_links',
      'notices',
      'checklist_items',
      'config_versions',
      'config_entries',
      'integration_identities',
      'domain_events',
      'consumed_events',
      'audit_events',
    ];

    for (const table of coreTables) {
      const result = await handle.db.execute(
        sql`select to_regclass(${`public.${table}`}) as reg`,
      );
      const rows = (result as unknown as { rows: Array<{ reg: string | null }> }).rows ?? (result as unknown as Array<{ reg: string | null }>);
      const reg = Array.isArray(rows) ? rows[0]?.reg : undefined;
      expect(reg, `expected table "${table}" to exist`).not.toBeNull();
    }
  });

  it('seeds phase_1_defaults config with transitions and thresholds', async () => {
    const result = await handle.db.execute(sql`select entry_key from config_entries`);
    const rows = (result as unknown as { rows: Array<{ entry_key: string }> }).rows ?? (result as unknown as Array<{ entry_key: string }>);
    const keys = rows.map((r) => r.entry_key);
    expect(keys).toContain('transitions');
    expect(keys).toContain('thresholds');
    expect(keys).toContain('hold_types');
  });

  it('rejects UPDATE on audit_events (append-only trigger)', async () => {
    await handle.db.execute(
      sql`insert into audit_events (action, object_table, object_id) values ('test_action', 'issues', gen_random_uuid())`,
    );
    await expect(
      handle.db.execute(sql`update audit_events set action = 'tampered' where action = 'test_action'`),
    ).rejects.toThrow();
  });

  it('rejects DELETE on audit_events (append-only trigger)', async () => {
    await handle.db.execute(
      sql`insert into audit_events (action, object_table, object_id) values ('test_action_2', 'issues', gen_random_uuid())`,
    );
    await expect(
      handle.db.execute(sql`delete from audit_events where action = 'test_action_2'`),
    ).rejects.toThrow();
  });
});
