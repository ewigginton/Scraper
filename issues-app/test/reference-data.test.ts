/**
 * reference-data.test.ts — regression coverage for the "hard-capped at 500
 * with no truncation signal" adversarial-review finding: listProperties/
 * listPeople used to return a bare array capped at LIST_LIMIT with no way
 * for the caller to tell the list was truncated — once property_refs/
 * person_refs passes 500 rows, entries alphabetically past the 500th
 * silently become unselectable in the intake form pickers, and it looks
 * complete.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPeople, listProperties } from '../app/_lib/reference-data.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { makeProperty } from './helpers/fixtures.ts';

describe('reference-data: listProperties/listPeople truncation signal', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('hasMore is false and total matches the row count when under the limit', async () => {
    await makeProperty(handle.db);
    await makeProperty(handle.db);

    const result = await listProperties(handle.db);
    expect(result.total).toBe(2);
    expect(result.items.length).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('ADVERSARIAL-REVIEW REGRESSION: past the 500-row cap, hasMore is true and total reflects the REAL count, not just what was returned', async () => {
    // Bulk-insert via generate_series rather than 501 individual fixture
    // calls, purely for test speed — the shape under test is
    // listProperties'/listPeople's own query, not property_refs.create.
    await handle.client.exec(`
      insert into property_refs (source_system, external_id, display_name, state)
      select 'test', 'bulk-' || g, 'Bulk Property ' || g, 'TX'
      from generate_series(1, 501) as g;
    `);

    const result = await listProperties(handle.db);
    expect(result.total).toBe(501);
    expect(result.items.length).toBe(500);
    expect(result.hasMore).toBe(true);
  });

  it('listPeople reports the same shape (empty, under-limit case)', async () => {
    const result = await listPeople(handle.db);
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });
});
