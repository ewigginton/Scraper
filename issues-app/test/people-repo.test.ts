/**
 * people-repo.test.ts — coverage for lib/repositories/people-repo.ts's
 * searchPeople (roadmap Wave 2b "Search expansion"; spec §15 "search by
 * person, phone/email").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchPeople } from '../lib/repositories/people-repo.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { makePerson } from './helpers/fixtures.ts';

describe('people-repo searchPeople', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('matches via display_name (existing behavior)', async () => {
    const match = await makePerson(handle.db, { displayName: 'Findable Owner' });
    await makePerson(handle.db, { displayName: 'Someone Else' });

    const result = await searchPeople(handle.db, { q: 'findable' });
    expect(result.rows.map((r) => r.person.id)).toEqual([match.id]);
  });

  it('matches via contact_snapshot phone', async () => {
    const match = await makePerson(handle.db, { displayName: 'Phone Match', contactSnapshot: { phone: '555-0142-unique' } });
    await makePerson(handle.db, { displayName: 'No Phone Match' });

    const result = await searchPeople(handle.db, { q: '555-0142' });
    expect(result.rows.map((r) => r.person.id)).toEqual([match.id]);
  });

  it('matches via contact_snapshot email', async () => {
    const match = await makePerson(handle.db, { displayName: 'Email Match', contactSnapshot: { email: 'unique-search@example.com' } });
    await makePerson(handle.db, { displayName: 'No Email Match' });

    const result = await searchPeople(handle.db, { q: 'unique-search@example.com' });
    expect(result.rows.map((r) => r.person.id)).toEqual([match.id]);
  });

  it('stays bounded (LIMIT respected) when many rows match', async () => {
    for (let i = 0; i < 5; i += 1) {
      await makePerson(handle.db, { displayName: `Bulk Match ${i}`, contactSnapshot: { phone: '555-bulk-shared' } });
    }

    const result = await searchPeople(handle.db, { q: '555-bulk-shared', limit: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it('a hostile q string is safely parameterized (no throw, no match)', async () => {
    await makePerson(handle.db, { displayName: 'Ordinary Person' });
    const hostile = "'; drop table person_refs; --";
    await expect(searchPeople(handle.db, { q: hostile })).resolves.toBeDefined();
    const result = await searchPeople(handle.db, { q: hostile });
    expect(result.rows).toHaveLength(0);
  });

  it('a NUL-byte q string is stripped rather than reaching the driver as a 500', async () => {
    await makePerson(handle.db, { displayName: 'Ordinary Person Two' });
    const nulByte = String.fromCharCode(0).repeat(3);
    await expect(searchPeople(handle.db, { q: nulByte })).resolves.toBeDefined();
  });

  it('REGRESSION (INJECTION FUZZ, round 2): a cursor whose decoded sortValue carries a NUL byte is treated as page 1, not thrown', async () => {
    // decodePeopleCursor's sortValue is bound directly as a text parameter
    // in the keyset predicate (display_name comparison) — replicate its
    // exact base64url-JSON encoding here (it isn't exported) to prove the
    // decoder rejects a NUL byte in that field rather than passing it
    // through to the driver.
    const match = await makePerson(handle.db, { displayName: 'Cursor Fuzz Target' });
    const poisonedCursor = Buffer.from(JSON.stringify([`Cursor${String.fromCharCode(0)}Fuzz`, match.id]), 'utf8').toString('base64url');
    const result = await searchPeople(handle.db, { cursor: poisonedCursor });
    // Treated as an invalid cursor -> page 1 (matches the real data, not empty/thrown).
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
