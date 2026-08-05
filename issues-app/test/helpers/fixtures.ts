/**
 * Test helper: minimal row factories for the reference/read-model tables
 * (property_refs, person_refs) that most service tests need to exist
 * before they can create an issue/hold/task/etc. Kept intentionally thin —
 * business rules under test live in lib/services/*, not here.
 */

import type { TestDb } from './pglite.ts';
import { personRefs, propertyRefs, type NewPersonRef, type NewPropertyRef } from '../../lib/db/schema.ts';

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export async function makeProperty(db: TestDb, overrides: Partial<NewPropertyRef> = {}) {
  const [row] = await db
    .insert(propertyRefs)
    .values({
      sourceSystem: 'test',
      externalId: unique('property'),
      development: 'Test Development',
      tract: 'Tract 1',
      state: 'TX',
      county: 'Test County',
      displayName: 'Test Property',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('fixtures.makeProperty: insert returned no row');
  return row;
}

export async function makePerson(db: TestDb, overrides: Partial<NewPersonRef> = {}) {
  const [row] = await db
    .insert(personRefs)
    .values({
      sourceSystem: 'test',
      externalId: unique('person'),
      displayName: 'Test Person',
      kind: 'person',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('fixtures.makePerson: insert returned no row');
  return row;
}

export function futureDate(daysFromNow = 7): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

export function pastDate(daysAgo = 7): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
