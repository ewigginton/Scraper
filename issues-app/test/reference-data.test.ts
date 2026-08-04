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
import { displayableContactEntries, listPeople, listProperties } from '../app/_lib/reference-data.ts';
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

/**
 * displayableContactEntries — regression coverage for the "contact_snapshot
 * rendered key-agnostic in two of three renderers" finding. Before the
 * fix, HoverCard.tsx's PersonHoverCard and app/people/[id]/page.tsx
 * rendered EVERY string-valued key in the jsonb blob with no allowlist,
 * while app/people/page.tsx's summary only ever read `phone`/`email` by
 * name — three renderers of one sync-fed blob disagreeing on what's safe
 * to show. The day the CRM/identity sync adds a non-contact field to this
 * jsonb (SSN last-4, DOB, a safety/do-not-contact note), it would render
 * instantly on every hover card with no review.
 */
describe('displayableContactEntries', () => {
  it('passes through every allowlisted key that is present and non-empty', () => {
    const entries = displayableContactEntries({ phone: '555-0100', email: 'a@example.com', address: '123 Main St' });
    expect(Object.fromEntries(entries)).toEqual({ phone: '555-0100', email: 'a@example.com', address: '123 Main St' });
  });

  it('REGRESSION: drops a key NOT on the allowlist, even though it is a normal non-empty string', () => {
    // The exact failure mode this finding describes: an upstream sync
    // change adding an identity-adjacent field should NOT render anywhere
    // without a deliberate allowlist update.
    const entries = displayableContactEntries({ phone: '555-0100', ssn_last4: '1234', date_of_birth: '1990-01-01' });
    const keys = entries.map(([k]) => k);
    expect(keys).toEqual(['phone']);
    expect(keys).not.toContain('ssn_last4');
    expect(keys).not.toContain('date_of_birth');
  });

  it('drops empty-string and non-string values for allowlisted keys', () => {
    const entries = displayableContactEntries({ phone: '', email: 42, mobile: '555-0199' });
    expect(entries).toEqual([['mobile', '555-0199']]);
  });

  it('returns [] for null/non-object/array input rather than throwing', () => {
    expect(displayableContactEntries(null)).toEqual([]);
    expect(displayableContactEntries(undefined)).toEqual([]);
    expect(displayableContactEntries('not an object')).toEqual([]);
    expect(displayableContactEntries(['phone', '555-0100'])).toEqual([]);
  });

  it('returns [] for an empty snapshot', () => {
    expect(displayableContactEntries({})).toEqual([]);
  });
});
