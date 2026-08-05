/**
 * payments-repo — basic DB access for the `payment_requests` table.
 * Approval/threshold rules and the paid-state decision (owned by
 * Accounting, per DESIGN.md §5) live in lib/services, not here.
 */

import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { paymentRequests, type NewPaymentRequest, type PaymentRequest } from '../db/schema.ts';

const TERMINAL_NOT_HAPPENING_STATUSES = ['denied', 'cancelled', 'voided'] as const;

/** Insert a new payment_requests row and return it. */
export async function create(db: DbHandle, data: NewPaymentRequest): Promise<PaymentRequest> {
  const [row] = await db.insert(paymentRequests).values(data).returning();
  if (!row) {
    throw new Error('payments-repo.create: insert returned no row');
  }
  return row;
}

/** List payment_requests for an issue. */
export async function listForIssue(db: DbHandle, issueId: string): Promise<PaymentRequest[]> {
  return db.select().from(paymentRequests).where(eq(paymentRequests.issueId, issueId));
}

/**
 * Duplicate check mirroring the DB's partial unique guard (§29.7): does
 * this vendor already have a non-terminal payment request for this invoice
 * number? Callers use this to surface a friendly error before insert; the
 * DB constraint (payment_requests_vendor_invoice_dup_guard_idx) is still
 * the source of truth for correctness under concurrency.
 */
export async function findDuplicate(
  db: DbHandle,
  vendorId: string,
  invoiceNumber: string,
): Promise<PaymentRequest[]> {
  return db
    .select()
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.vendorId, vendorId),
        eq(paymentRequests.invoiceNumber, invoiceNumber),
        isNotNull(paymentRequests.invoiceNumber),
        notInArray(paymentRequests.status, [...TERMINAL_NOT_HAPPENING_STATUSES]),
      ),
    );
}
