/**
 * case-view.test.ts — coverage for app/_lib/case-view.ts's loadCaseData
 * (P2 finding): its 8 per-issue child-collection queries (bids,
 * vendor_jobs, cost_entries, evidence_files, notices, the linked
 * person_refs join, change_orders, checklist_items) carried no LIMIT at
 * all, contradicting this codebase's own "every list query bounded" house
 * style (contract-refs-repo.ts's FOR_PROPERTY_LIMIT, timeline-repo.ts's
 * PHASE_NOTICE_LIMIT).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCaseData } from '../app/_lib/case-view.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('case-view.loadCaseData child-collection bounds', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('REGRESSION: caps evidence_files at CASE_CHILD_LIMIT (500) instead of returning every row unbounded', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Fixture case for loadCaseData bound coverage',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
      actorExternalId: 'test-seeder',
      actorRole: 'coordinator',
    });

    // Bulk-insert 501 evidence_files rows for this issue — one more than
    // CASE_CHILD_LIMIT — via raw SQL (evidence_files only strictly
    // requires storage_ref; everything else defaults), matching
    // test/reference-data.test.ts's generate_series idiom for a
    // truncation-boundary fixture.
    await handle.client.exec(`
      insert into evidence_files (storage_ref, issue_id)
      select 'fixture-' || g, '${issue.id}'
      from generate_series(1, 501) as g;
    `);

    const data = await loadCaseData(handle.db, issue.id);
    expect(data).toBeDefined();
    expect(data!.evidenceFiles.length).toBe(500);
  });
});
