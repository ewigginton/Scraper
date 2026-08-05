import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { consumeEvent } from '../lib/services/events.ts';
import { createIssue, openFromLoanDefault } from '../lib/services/issue-service.ts';
import { submitPaymentRequest, DuplicatePaymentRequestError } from '../lib/services/payment-service.ts';
import { auditEvents, consumedEvents, issues, vendors } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';
import { makePerson, makeProperty } from './helpers/fixtures.ts';

describe('idempotency', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('OPS-MV-001: duplicate loan.defaulted publishes create exactly one issue', async () => {
    const property = await makeProperty(handle.db);

    const first = await openFromLoanDefault(handle.db, {
      idempotencyKey: 'loan-defaulted-abc-123',
      propertyRefId: property.id,
    });
    expect(first.status).toBe('processed');

    const second = await openFromLoanDefault(handle.db, {
      idempotencyKey: 'loan-defaulted-abc-123',
      propertyRefId: property.id,
    });
    expect(second.status).toBe('skipped_duplicate');

    const propertyIssues = await handle.db.select().from(issues).where(eq(issues.propertyRefId, property.id));
    expect(propertyIssues).toHaveLength(1);
    expect(propertyIssues[0]?.issueType).toBe('default_recovery');
  });

  it('OPS-MV-001: the property never becomes Available/released just from the duplicate default event', async () => {
    const property = await makeProperty(handle.db);
    await openFromLoanDefault(handle.db, { idempotencyKey: 'loan-defaulted-xyz', propertyRefId: property.id });
    await openFromLoanDefault(handle.db, { idempotencyKey: 'loan-defaulted-xyz', propertyRefId: property.id });

    const [issue] = await handle.db.select().from(issues).where(eq(issues.propertyRefId, property.id));
    expect(issue?.lifecycleStatus).not.toBe('closed');
    // This app never writes availability/website-status facts at all (spec
    // §30.4/§10 — Inventory/Tables is the sole writer); the assertion above
    // (still open, not closed) is the property-operations-owned proxy for
    // "not released".
  });

  it('OPS-ADD-008: a second payment request for the same vendor + invoice is blocked and audited', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Cleanup case',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Review', dueDate: futureDateLocal(), queue: 'new_unreviewed' },
    });
    const vendorPerson = await makePerson(handle.db, { kind: 'org', displayName: 'Acme Cleanup' });
    const [vendor] = await handle.db.insert(vendors).values({ personRefId: vendorPerson.id, displayName: 'Acme Cleanup' }).returning();

    const first = await submitPaymentRequest(handle.db, {
      issueId: issue.id,
      vendorId: vendor!.id,
      invoiceNumber: 'INV-100',
      amountCents: 50000,
    });
    expect(first.status).toBe('submitted');

    await expect(
      submitPaymentRequest(handle.db, {
        issueId: issue.id,
        vendorId: vendor!.id,
        invoiceNumber: 'INV-100',
        amountCents: 50000,
      }),
    ).rejects.toBeInstanceOf(DuplicatePaymentRequestError);

    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.action, 'payment_request_duplicate_blocked'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('a different invoice number for the same vendor is NOT blocked', async () => {
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Cleanup case',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Review', dueDate: futureDateLocal(), queue: 'new_unreviewed' },
    });
    const vendorPerson = await makePerson(handle.db, { kind: 'org', displayName: 'Acme Cleanup 2' });
    const [vendor] = await handle.db.insert(vendors).values({ personRefId: vendorPerson.id, displayName: 'Acme Cleanup 2' }).returning();

    await submitPaymentRequest(handle.db, { issueId: issue.id, vendorId: vendor!.id, invoiceNumber: 'INV-200', amountCents: 10000 });
    const second = await submitPaymentRequest(handle.db, { issueId: issue.id, vendorId: vendor!.id, invoiceNumber: 'INV-201', amountCents: 20000 });
    expect(second.status).toBe('submitted');
  });

  it('consumeEvent: a replayed (sourceSystem, idempotencyKey) pair skips the handler and consumed_events records only one row', async () => {
    const handlerSpy = vi.fn(async () => 'ran');

    const first = await consumeEvent(handle.db, 'test_source', 'key-1', handlerSpy);
    const second = await consumeEvent(handle.db, 'test_source', 'key-1', handlerSpy);

    expect(first).toEqual({ status: 'processed', result: 'ran' });
    expect(second).toEqual({ status: 'skipped_duplicate' });
    expect(handlerSpy).toHaveBeenCalledTimes(1);

    const rows = await handle.db.select().from(consumedEvents).where(eq(consumedEvents.idempotencyKey, 'key-1'));
    expect(rows).toHaveLength(1);
  });

  it('consumeEvent: a different idempotencyKey under the same sourceSystem runs the handler again', async () => {
    const handlerSpy = vi.fn(async () => 'ran');
    await consumeEvent(handle.db, 'test_source', 'key-a', handlerSpy);
    await consumeEvent(handle.db, 'test_source', 'key-b', handlerSpy);
    expect(handlerSpy).toHaveBeenCalledTimes(2);
  });

  it('consumeEvent: a failed handler rolls back the claim, so a retry with the same key runs again', async () => {
    let attempt = 0;
    const flakyHandler = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('transient failure');
      }
      return 'succeeded-on-retry';
    });

    await expect(consumeEvent(handle.db, 'test_source', 'retry-key', flakyHandler)).rejects.toThrow('transient failure');
    const retryResult = await consumeEvent(handle.db, 'test_source', 'retry-key', flakyHandler);
    expect(retryResult).toEqual({ status: 'processed', result: 'succeeded-on-retry' });
    expect(flakyHandler).toHaveBeenCalledTimes(2);
  });
});

function futureDateLocal(daysFromNow = 7): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
