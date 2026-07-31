/**
 * payment-service.ts — vendor payment request commands (spec §6.3, §29.7,
 * §29.8, OPS-ADD-007, OPS-ADD-008). The payment_requests STATE MACHINE
 * beyond submission/approval (Scheduled, Paid, Partially Paid, etc.) is
 * Accounting's module per spec §29.7 / RLS (payment_requests write policy
 * is accounting/admin-only) — this service provides the coordinator-facing
 * submission and the W-9-gated approval step named in this lane's task
 * brief; it does not implement the full Accounting paid/denied workflow.
 */

import { eq } from 'drizzle-orm';
import type { DbHandle } from '../repositories/db-handle.ts';
import * as paymentsRepo from '../repositories/payments-repo.ts';
import * as vendorsRepo from '../repositories/vendors-repo.ts';
import { paymentRequests, type PaymentRequest } from '../db/schema.ts';
import { writeAudit } from './audit.ts';
import { publishDomainEvent } from './events.ts';

export class DuplicatePaymentRequestError extends Error {
  code = 'duplicate_payment_request';
  duplicates: PaymentRequest[];
  constructor(duplicates: PaymentRequest[]) {
    super(
      `A non-terminal payment request already exists for this vendor/invoice (${duplicates.length} match(es)); routed for duplicate review (spec OPS-ADD-008).`,
    );
    this.name = 'DuplicatePaymentRequestError';
    this.duplicates = duplicates;
  }
}

export class PaymentRequestBlockedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentRequestBlockedError';
    this.code = code;
  }
}

export interface SubmitPaymentRequestInput {
  issueId: string;
  vendorId: string;
  vendorJobId?: string | null;
  invoiceNumber?: string | null;
  amountCents: number;
  sourceDocumentEvidenceFileId?: string | null;
  requestedBy?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/**
 * Submit a vendor payment request. Blocks (with a typed
 * DuplicatePaymentRequestError, routed to duplicate review) when the same
 * vendor + invoice_number already has a non-terminal payment request on
 * file (spec OPS-ADD-008). The DB's partial unique index
 * (payment_requests_vendor_invoice_dup_guard_idx) is the ultimate
 * concurrency-safe backstop; this check gives a friendly, typed error and
 * an audit trail before that constraint would fire.
 *
 * `auditDb` (defaults to `tx`) is the handle used to record the
 * duplicate-blocked audit row. Callers that wrap this call in
 * `db.transaction(...)` should pass the top-level `db` (NOT `tx`) here —
 * writing the denial audit on `tx` means it rolls back along with the rest
 * of the transaction this call is about to abort via the thrown error,
 * so the audit row would never persist in production (adversarial-review
 * finding). Tests that call this directly against a non-transactional
 * handle get the same handle for both by default, so this is backward
 * compatible.
 */
export async function submitPaymentRequest(tx: DbHandle, input: SubmitPaymentRequestInput, auditDb: DbHandle = tx): Promise<PaymentRequest> {
  if (input.amountCents < 0) {
    throw new PaymentRequestBlockedError('invalid_amount', 'Payment request amount cannot be negative.');
  }

  if (input.invoiceNumber) {
    const duplicates = await paymentsRepo.findDuplicate(tx, input.vendorId, input.invoiceNumber);
    if (duplicates.length > 0) {
      await writeAudit(auditDb, {
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        action: 'payment_request_duplicate_blocked',
        objectTable: 'payment_requests',
        objectId: duplicates[0]!.id,
        before: null,
        after: {
          attemptedVendorId: input.vendorId,
          attemptedInvoiceNumber: input.invoiceNumber,
          attemptedAmountCents: input.amountCents,
          attemptedIssueId: input.issueId,
        },
        reason: 'Duplicate vendor + invoice_number payment request blocked (spec OPS-ADD-008).',
        correlationId: input.correlationId ?? null,
        source: 'payment-service.submitPaymentRequest',
      });
      throw new DuplicatePaymentRequestError(duplicates);
    }
  }

  const paymentRequest = await paymentsRepo.create(tx, {
    issueId: input.issueId,
    vendorJobId: input.vendorJobId ?? null,
    vendorId: input.vendorId,
    invoiceNumber: input.invoiceNumber ?? null,
    amountCents: input.amountCents,
    sourceDocumentEvidenceFileId: input.sourceDocumentEvidenceFileId ?? null,
    status: 'submitted',
    requestedBy: input.requestedBy ?? null,
  });

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'payment_request_submitted',
    objectTable: 'payment_requests',
    objectId: paymentRequest.id,
    before: null,
    after: paymentRequest,
    correlationId: input.correlationId ?? null,
    source: 'payment-service.submitPaymentRequest',
  });

  await publishDomainEvent(tx, {
    eventType: 'property_operations.payment_request_submitted',
    payload: { paymentRequestId: paymentRequest.id, vendorId: input.vendorId, amountCents: input.amountCents },
    issueId: input.issueId,
    actor: input.actorId ?? null,
    correlationId: input.correlationId ?? null,
    idempotencyKey: `payment_request_submitted:${paymentRequest.id}`,
  });

  return paymentRequest;
}

export interface ApprovePaymentRequestInput {
  paymentRequestId: string;
  approverId: string;
  actorId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/**
 * Approve a payment request. Blocked when the vendor's W-9 is not on file
 * (spec §6.3 "Vendor W-9 must be on file or received before payment", §29.7
 * "Payment approval or release shall be blocked when the W-9 ... is
 * missing").
 */
export async function approvePaymentRequest(tx: DbHandle, input: ApprovePaymentRequestInput): Promise<PaymentRequest> {
  const [existing] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, input.paymentRequestId));
  if (!existing) {
    throw new PaymentRequestBlockedError('payment_request_not_found', `Payment request ${input.paymentRequestId} not found.`);
  }

  const vendor = await vendorsRepo.getById(tx, existing.vendorId);
  if (!vendor || !(vendor.w9Status === 'received' || vendor.w9Status === 'verified')) {
    throw new PaymentRequestBlockedError(
      'w9_required',
      'W-9 must be on file (received or verified) before this payment request can be approved (spec §6.3, §29.7).',
    );
  }

  const [updated] = await tx
    .update(paymentRequests)
    .set({ status: 'approved', approvedBy: input.approverId })
    .where(eq(paymentRequests.id, input.paymentRequestId))
    .returning();
  if (!updated) {
    throw new Error('payment-service.approvePaymentRequest: update returned no row');
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    action: 'payment_request_approved',
    objectTable: 'payment_requests',
    objectId: updated.id,
    before: existing,
    after: updated,
    correlationId: input.correlationId ?? null,
    source: 'payment-service.approvePaymentRequest',
  });

  return updated;
}
