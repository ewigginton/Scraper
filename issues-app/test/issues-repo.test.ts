/**
 * issues-repo.test.ts — coverage for the uuid-guard gap on
 * lib/repositories/issues-repo.ts's getById (P2 finding): unlike
 * people-repo.getPerson and contract-refs-repo.getById, this function had
 * no isUuid() guard, so a non-uuid route param on /issues/[id] and
 * /issues/[id]/timeline (both call getById/loadCaseData before their "not
 * found" branch) threw a raw SQLSTATE 22P02 "invalid input syntax for type
 * uuid" instead of resolving undefined.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as issuesRepo from '../lib/repositories/issues-repo.ts';
import { loadCaseData } from '../app/_lib/case-view.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';

describe('issuesRepo.getById', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('REGRESSION: resolves undefined for a non-uuid id rather than throwing a raw driver error', async () => {
    await expect(issuesRepo.getById(handle.db, 'not-a-uuid')).resolves.toBeUndefined();
  });

  it('resolves undefined for a well-formed but non-existent uuid', async () => {
    await expect(issuesRepo.getById(handle.db, '00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
  });
});

describe('case-view.loadCaseData', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('REGRESSION: resolves undefined for a non-uuid issueId (e.g. a crawler hitting /issues/anything) rather than throwing', async () => {
    await expect(loadCaseData(handle.db, 'anything', ['coordinator'])).resolves.toBeUndefined();
  });
});
