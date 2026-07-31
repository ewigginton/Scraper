import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkContractEligibility, checkReleaseEligibility } from '../lib/services/eligibility-service.ts';
import { applyHold } from '../lib/services/hold-service.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { possessionRecords, vendorJobs, bids, approvals, vendors } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { futureDate, makePerson, makeProperty } from './helpers/fixtures.ts';

describe('eligibility-service', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  async function baseIssue(propertyId: string, ownerId: string, mapLink?: string) {
    return createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: propertyId,
      summary: 'Test recovery case',
      people: [{ personRefId: ownerId, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
      mapLink,
    });
  }

  it('clears the possession and map-link blockers once resolved, leaving only the still-open issue', async () => {
    // map_link is a Property-Operations-owned fact on the issue itself
    // (issues.map_link), NOT property_refs — see issue-service.createIssue.
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await baseIssue(property.id, owner.id, 'https://maps.example.com/test');
    await handle.db.insert(possessionRecords).values({
      issueId: issue.id,
      propertyRefId: property.id,
      possessionStatus: 'cleared',
    });

    const result = await checkReleaseEligibility(handle.db, property.id);
    // Possession is resolved and the map link is present (fixture default),
    // so only the still-open issue itself blocks release.
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(false);
    expect(result.blockers.some((b) => b.code === 'map_link_missing')).toBe(false);
    expect(result.blockers.some((b) => b.code === 'open_issue_phase')).toBe(true);
  });

  it('blocks release when an active hold exists, and reports the correct owner module', async () => {
    const property = await makeProperty(handle.db);
    await applyHold(handle.db, {
      propertyRefId: property.id,
      holdType: 'legal',
      reason: 'Pending litigation',
    });

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.eligible).toBe(false);
    const holdBlocker = result.blockers.find((b) => b.code === 'active_hold_legal');
    expect(holdBlocker).toBeDefined();
    expect(holdBlocker?.ownerModule).toBe('Legal');
  });

  it('blocks release when possession is unresolved (no possession record at all)', async () => {
    const property = await makeProperty(handle.db);
    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
  });

  it('blocks release when possession is occupied_or_suspected', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await baseIssue(property.id, owner.id);
    await handle.db.insert(possessionRecords).values({
      issueId: issue.id,
      propertyRefId: property.id,
      possessionStatus: 'occupied_or_suspected',
    });

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
  });

  it('blocks release when a vendor job is complete but not verified (OPS-MV-002 building block)', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await baseIssue(property.id, owner.id);
    const vendorPerson = await makePerson(handle.db, { kind: 'org', displayName: 'Test Vendor' });
    const [vendor] = await handle.db
      .insert(vendors)
      .values({ personRefId: vendorPerson.id, displayName: 'Test Vendor' })
      .returning();
    const [bid] = await handle.db
      .insert(bids)
      .values({ issueId: issue.id, vendorId: vendor!.id, scope: 'Cleanup', amountCents: 100000, status: 'accepted' })
      .returning();
    await handle.db.insert(vendorJobs).values({
      issueId: issue.id,
      bidId: bid!.id,
      vendorId: vendor!.id,
      status: 'completed',
    });

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.blockers.some((b) => b.code === 'cleanup_complete_not_verified')).toBe(true);
  });

  it('OPS-MV-002: cleanup complete but possession unresolved still blocks release even with everything else clear', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await baseIssue(property.id, owner.id);
    const vendorPerson = await makePerson(handle.db, { kind: 'org', displayName: 'Test Vendor' });
    const [vendor] = await handle.db
      .insert(vendors)
      .values({ personRefId: vendorPerson.id, displayName: 'Test Vendor' })
      .returning();
    const [bid] = await handle.db
      .insert(bids)
      .values({ issueId: issue.id, vendorId: vendor!.id, scope: 'Cleanup', amountCents: 100000, status: 'accepted' })
      .returning();
    await handle.db.insert(vendorJobs).values({
      issueId: issue.id,
      bidId: bid!.id,
      vendorId: vendor!.id,
      status: 'completed',
    });
    // Possession is never recorded as resolved.

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === 'possession_unresolved')).toBe(true);
    expect(result.blockers.some((b) => b.code === 'cleanup_complete_not_verified')).toBe(true);
  });

  it('blocks release when an open recovery issue exists for the property', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    await baseIssue(property.id, owner.id);

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.blockers.some((b) => b.code === 'open_issue_phase')).toBe(true);
  });

  it('blocks release when a pending approval exists on the issue', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await baseIssue(property.id, owner.id);
    await handle.db.insert(approvals).values({
      requestedAction: 'release_property',
      objectTable: 'issues',
      objectId: issue.id,
      requesterId: owner.id,
      decision: 'pending',
    });

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.blockers.some((b) => b.code === 'approval_missing')).toBe(true);
  });

  it('blocks recovery release when the map link is missing', async () => {
    const property = await makeProperty(handle.db, { mapLink: null });
    const owner = await makePerson(handle.db);
    await baseIssue(property.id, owner.id);

    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.blockers.some((b) => b.code === 'map_link_missing')).toBe(true);
  });

  it('does not flag map link missing when no default_recovery issue exists', async () => {
    const property = await makeProperty(handle.db, { mapLink: null });
    const result = await checkReleaseEligibility(handle.db, property.id);
    expect(result.blockers.some((b) => b.code === 'map_link_missing')).toBe(false);
  });

  it('reports ALL blockers at once, not just the first one found', async () => {
    const property = await makeProperty(handle.db, { mapLink: null });
    const owner = await makePerson(handle.db);
    await baseIssue(property.id, owner.id);
    await applyHold(handle.db, { propertyRefId: property.id, holdType: 'safety', reason: 'Unsafe structure' });

    const result = await checkReleaseEligibility(handle.db, property.id);
    const codes = result.blockers.map((b) => b.code);
    expect(codes).toContain('active_hold_safety');
    expect(codes).toContain('possession_unresolved');
    expect(codes).toContain('open_issue_phase');
    expect(codes).toContain('map_link_missing');
    expect(result.blockers.length).toBeGreaterThanOrEqual(4);
  });

  it('checkContractEligibility also blocks on an existing_contract_active hold', async () => {
    const property = await makeProperty(handle.db);
    await applyHold(handle.db, {
      propertyRefId: property.id,
      holdType: 'existing_contract_active',
      reason: 'Account reinstated',
    });

    const result = await checkContractEligibility(handle.db, property.id);
    expect(result.eligible).toBe(false);
    const blocker = result.blockers.find((b) => b.code === 'active_hold_existing_contract_active');
    expect(blocker?.ownerModule).toBe('Loan Services');
  });
});
