# Source-of-Truth Matrix — Property Operations Issues

Source: spec §30.2 (one writer per fact), §30.3 (domain events), §30.9 (design-time checklist).

This matrix defines the authoritative writer for every fact domain and what the Property Operations Issues module reads, publishes, and explicitly does NOT write. Property Operations is a reader of shared records; it is the sole writer only of its operational facts.

---

## Fact Domain × Owning Writer × Issues Module Behavior

| Fact Domain | Owning Writer | Issues Module Behavior | Notes |
| --- | --- | --- | --- |
| **Person (staff identity)** | Hub shared identity service | **Reads:** canonical person_id, contact info, role. | Property Operations links issues to persons (owner, buyer, reporter, vendor, attorney). Does not maintain a second Person table. |
| **Person (customer/borrower)** | Hub shared identity service (Master Vision §47) | **Reads:** person_id, aliases, contact snapshot. Links evidence/correction requests. | Property Operations must not merge persons independently; identity service governs merge/survivorship. |
| **Property / Tract** | Inventory/Tables (Airtable → Supabase cutover) | **Reads:** development, tract, state, county, map/coordinates, external aliases, inventory status, website status, pricing history. | Property Operations does NOT write: availability, website status, price/True Discount history, website listing status. Inventory/Tables is sole writer. |
| **Issue (case metadata)** | **Property Operations** | **Writes:** type, summary, priority, coordinator, lifecycle_status, current_phase_instance_id, business_priority. | Core entity owned by Property Operations. Holds references to property_ref, people, account_ref as external aliases. |
| **Issue Cycle** | **Property Operations** | **Writes:** cycle#, opened_date, reason, outcome, reopened_case_reason. | Preserves reopened case history (spec §21, §29.9). |
| **Phase Instance** | **Property Operations** | **Writes:** phase_key, owner, start_date, end_date, status, entry_reason, exit_outcome. | One execution of a phase; holds phase-scoped data (assessment, review results). |
| **Task** | **Property Operations** (or Loan Services for cross-module) | **Writes:** assignee/queue, due_date, status, priority, source_rule, completion_evidence, notes. Publishes task-created/task-completed events. | Shared task inbox (spec §28.6). Issues module owns property-operations-sourced tasks. |
| **Restriction/Hold** | **Property Operations** | **Writes:** type, scope, effective_dates, reason, source, owner, release_criteria, released_by/at/reason. | Property Operations authority: legal, safety, occupancy, cleanup, covenant, stop_work holds. Publishes hold_applied/hold_released events. |
| **Account/Loan/Payment** | Loan Services Hub module | **Reads:** account_id, default_status, reinstatement_status, payment_history, arrears, voluntary_surrender_state. **Consumes events:** loan.defaulted, loan.reinstatement_effective, loan.account_closed, loan.voluntary_surrender_effective. | Property Operations does NOT write: payment amount, payment status, account balance, arrears, default/reinstatement status, voluntary surrender effectiveness. Loan Services is sole writer. Issues publishes release_approved; Inventory/Website/Loan Services use event for their decisions. |
| **Contract/Voluntary Surrender** | Contract workflow (Hub module) | **Reads:** contract_id, status, party/signer status, signature dates, completion status, related account. **Consumes:** document.signature_changed. | Property Operations may initiate document/VS workflow but cannot declare document completed or VS effective. Document service owns lifecycle facts. |
| **Inventory Status / Availability / Website Status** | Inventory/Tables (Supabase, migrated from Airtable) | **Reads:** current inventory status, availability flag, website listing status. **Publishes (after Inventory writes):** property.availability_changed events. | Property Operations does NOT write: Available/Unavailable status, website listing status, price history. Property Operations publishes release_approved event; Inventory/Tables re-evaluates eligibility, writes availability, publishes property.availability_changed. Website reads authoritative Inventory/Tables result. |
| **Sale/Transaction** | Sales/Transactions Hub module | **Reads:** sale_lead, First Dibs, transaction_id, buyer, sale_date, proceeds. **Consumes:** transaction.completed. | Property Operations does NOT write: sale_lead, First Dibs status, transaction facts. Sales/Transactions is sole writer. |
| **Condition / Possession / Cleanup** | **Property Operations** | **Writes:** condition_assessment, possession_status, cleanup_requirement, personal_property_inventory, cleanup_verified_date, verification_method. | Core operational facts owned by Property Operations. Seeded possession_statuses: unknown, occupied_or_suspected, vacancy_unverified, vacancy_verified, personal_property_present, removal_disposition_review, removal_authorized, stored, transferred, disposed, cleared. |
| **Vendor / Vendor Job / Bid** | **Property Operations** | **Writes:** vendor_profile (capabilities, states, W-9 status, compliance dates), bid (scope, amount, completeness status), vendor_job (vendor, contract, scheduled dates, change_orders, actual cost, verification). | Property Operations tracks vendor work and compliance. Does NOT write: payment issued/check date (Accounting writes that). |
| **Cost / Cost Entry** | **Property Operations** (classification + request); **Accounting** (payment issued/status) | **Writes (Issues):** cost_classification (estimated/bid/committed/approved/invoiced/paid/additional/disputed/recoverable/customer_chargeable/waived/written_off), cost_amount, reason for classification, approver. **Writes (Accounting):** paid_date, check/payment_reference, payment_amount, issuing_proof. | Property Operations owns cost request and classification (spec §29.7). Accounting owns payment authority and check issuance. A recoverable or customer_chargeable classification does NOT itself post a charge; any charge requires Loan Services/Accounting workflow (spec §29.7). |
| **Communication Event** | CRM/Communications (shared service) | **Reads:** calls, texts, emails, voicemails, notices (normalized). Links communication events to issues/phases/tasks without copies. | Property Operations does NOT copy communications; it links to shared communication events. Publishes communication events for notices it generates (e.g., covenant notice). |
| **Evidence File / Document** | **Property Operations** (for property-operations-sourced evidence) | **Writes:** original file metadata (filename, type, size, captured_time, uploader, source, checksum), access_classification, immutable versions. Derivatives/replacements link to original. | Property Operations stores only evidence it captures/uploads (photos, inspection reports, assessments). For contract/signature documents, Document service is authoritative for signature lifecycle (spec §23, §29.2). |
| **Approval** | **Property Operations** (for operational approvals) | **Writes:** requested_action, threshold_rule, requester, approver_role, decision, reason, evidence, timestamp, immutable link to affected_command. | Records approval for threshold/release/exception overrides. Does NOT write: payment approval (Accounting authority) or contract/reinstatement approval (Loan Services authority). |
| **Configuration (Workflow, Thresholds, Roles)** | **Admin** (via config_versions + config_entries) | **Reads:** current config_version, active entries (issue_types, transitions, thresholds, hold_types, possession_statuses, task_queues, cost_classifications, roles). | Property Operations reads configuration but does NOT modify it. Config changes are admin-only (spec §12). |
| **Audit Event** | **All modules** (each writes audit for its commands) | **Writes:** audit_events (append-only, insert-only by RLS trigger) with actor, role, action, object, before/after, reason, correlation_id, timestamp. | Property Operations writes audit for every command (transition, hold, approval, override, edit). No hard deletes of audited records; archive/tombstone only (spec §29.2). |
| **Domain Event (Event Log)** | **All modules** (each publishes when it commits authoritative facts) | **Publishes (Issues):** property_operations.issue_opened, property_operations.hold_applied, property_operations.hold_released, property_operations.cleanup_required, property_operations.cleanup_verified, property_operations.release_approved, property_operations.issue_closed, property_operations.payment_requested. **Consumes:** loan.defaulted, loan.reinstatement_effective, loan.voluntary_surrender_effective, transaction.completed (for buyer_cleanup creation). | Governed centrally per spec §30.3. No bespoke point-to-point sync or separate event store (spec §30.3). |

---

## Explicit "Issues Module Does NOT Write" List (Spec §30.2)

**CRITICAL:** Property Operations must never directly write:

1. **Inventory Availability / Website Status** — Inventory/Tables is sole writer after evaluating release prerequisites (spec §10, §30.4).
   - Issues publishes `property_operations.release_approved` event.
   - Inventory/Tables rechecks eligibility, writes availability once, publishes `property.availability_changed`.
   - Website reads/subscribes to Inventory/Tables result.

2. **Loan/Account Facts (lsp_* servicing model)** — Loan Services is sole writer (spec §30.2, §28.1).
   - Issues does NOT write: payment amount, payment status, arrears, default_status, reinstatement_status, account balance, voluntary_surrender_effectiveness.
   - Issues consumes `loan.defaulted`, `loan.reinstatement_effective`, `loan.voluntary_surrender_effective` events.
   - Issues publishes operational holds/release decisions; Loan Services uses those for account decisions.

3. **Sales Facts (sale_lead, First Dibs, transaction)** — Sales/Transactions is sole writer (spec §30.2, §28.1).
   - Issues does NOT write: sale_lead assignment, First Dibs status, buyer identity, transaction_id, sale_date, proceeds.
   - Issues consumes `transaction.completed` event to create buyer_cleanup issue.

4. **Payment Issued / Check Issuance** — Accounting is sole writer (spec §30.2, §29.7).
   - Issues does NOT write: paid_date, check/payment_reference, payment_amount, issuing_proof.
   - Issues owns cost request and classification; Accounting approves and issues payment.
   - Issues may read: payment_status (from payment_requests.status field).

5. **Price/True Discount History** — Inventory/Tables is sole writer (spec §30.2, §10).
   - Issues reads pricing history for release checks.
   - Issues does NOT write: price values, True Discount, special-listing flags.

6. **Person Identity / Merge / Survivorship** — Hub shared identity service is sole writer (spec §30.2, §30.5).
   - Issues reads canonical person_id and aliases.
   - Issues does NOT merge persons, does NOT override identity decisions, does NOT write person canonical records.
   - Issues may queue identity evidence/correction requests for CRM to process.

7. **Document Lifecycle (Contract, Voluntary Surrender, Legal Docs)** — Document service is sole writer for signature/completion status (spec §30.2).
   - Issues reads document status and may initiate workflows.
   - Issues does NOT declare document completed, effective, or signature status.
   - Issues may store/link copies of evidence (photos, notices) but not authoritative contract/signature facts.

---

## Event-Driven Cross-System Integration (Spec §30.3, §30.4)

Property Operations integrates via centrally governed domain events (no bespoke point-to-point sync):

**Issues Consumes (Minimum Set per spec §30.3):**
- `loan.defaulted` → Create Default/Property Recovery issue (idempotent, spec §30.4).
- `loan.reinstatement_effective` → Place Existing Contract Active hold, move work to Reinstatement Review (spec §28.5).
- `loan.account_closed` → Note account closure on issue history.
- `loan.voluntary_surrender_effective` → Update issue to reflect accepted VS, enable Map Review pathway (spec §28.4).
- `contract.executed` or `contract.changed` → Link contract to issue; track signer status.
- `document.signature_changed` → Track signature progress (not write signature status).
- `transaction.completed` → Create Buyer Cleanup issue for post-sale obligation (spec §6.2).
- `communication.recorded` → Link communication to issue without copying.
- Inventory Property status events → Read current inventory status.

**Issues Publishes (Minimum Set per spec §30.3):**
- `property_operations.issue_opened` → Issue created.
- `property_operations.hold_applied` → Hold created (type, reason, owner).
- `property_operations.hold_released` → Hold released (type, released_by, reason).
- `property_operations.cleanup_required` → Cleanup assessment entered.
- `property_operations.cleanup_verified` → Cleanup verified with photos/evidence.
- `property_operations.release_approved` → Issue coordinator approves property release; Inventory/Tables rechecks and writes availability (spec §30.4).
- `property_operations.payment_requested` → Payment request submitted (vendor, amount, issue, job, W-9 status).
- `property_operations.issue_closed` → Issue closed (reason, cycle count if reopened).
- Shared events (task, document, communication created through shared services).

**Event Contract Management:**
- Governed centrally by spec §30.3.
- Type registry, schema, compatibility rules, subscriber conventions.
- Cross-domain or incompatible changes require approval (spec §30.3).
- No unapproved additions to events.

---

## One Writer Per Fact: Defense-in-Depth

**Application layer:**
- Commands are role-permissioned and task-specific (spec §21).
- Eligibility/prerequisite checks before commit (spec §28.3).

**Database layer:**
- Row Level Security policies enforce role-based write restrictions (spec §23, §30.7).
- Triggers prevent hard deletes of audit_events (spec §29.2).
- Foreign keys ensure referential integrity with linked records.

**Transactional consistency:**
- Cross-record updates (e.g., issue state + hold + task) execute in one transaction (spec §21).
- Consumed events are idempotently processed (spec §21, §28.7).

**Audit trail:**
- Every command writes audit_events with actor, role, before/after, reason (spec §12, §29.2).
- Event sourcing tracks state transitions for reconstruction (spec §28.8).

---

## Shared Identifiers and External Aliases (Spec §30.5)

Property Operations uses canonical IDs from upstream systems:

- **person_id:** Canonical ID from Hub identity service; Airtable/JustCall/Pipedrive IDs are aliases.
- **property_id:** Canonical Supabase ID; Airtable/Zillow/parcel IDs are external_id + source_system in property_refs.
- **account_id:** From Loan Services Hub module; used to link issues to accounts.
- **contract_id:** From Contract workflow; used to link issues to contracts.
- **vendor_id:** From Person/Organization record (canonical); linked via person_refs.
- **payment_request_id:** Internal Issues ID; linked to vendor invoice (external).

**Migration:** Property_refs and person_refs are read-model reference tables with external aliases, not canonical Person/Property tables (spec §30.5).

---

## Multi-System Examples (Spec §30, §28)

### Example 1: Default Event → Issue Creation

1. **Loan Services commits:** default_status = delinquent, publishes `loan.defaulted`.
2. **Issues consumes idempotently:** Creates Default/Property Recovery issue (or updates existing).
   - Sets lifecycle_status = intake, phase = intake.
   - Links to account_id, property_id, owner (from event context).
   - Publishes `property_operations.issue_opened`.
3. **Issues does NOT:** Write to account balance, payment status, lsp_* fields.
4. **Property released:** Issues publishes `property_operations.release_approved`.
5. **Inventory evaluates:** Checks current holds, price review, other prerequisites.
6. **Inventory writes:** availability = Available, publishes `property.availability_changed`.
7. **Website:** Reads Inventory/Tables availability (not Issues state).

### Example 2: Reinstatement → Cleanup Interruption

1. **Loan Services:** Reinstatement approved, publishes `loan.reinstatement_effective`.
2. **Issues consumes:**
   - Places `existing_contract_active` hold (blocks new contract and website release, spec §28.5).
   - Moves any active cleanup work to Reinstatement Review phase.
   - Creates urgent task/notification for coordinator.
   - Publishes `property_operations.hold_applied`.
   - Preserves all prior work, communications, costs, bids (spec §28.5).
3. **Coordinator decides:** Cancel cleanup, pause, continue limited work, or escalate.
4. **Issues does NOT:** Erase cleanup requirement, modify account status, write payment status.

### Example 3: Payment Request Flow

1. **Coordinator:** Submits payment request (vendor, amount, invoice, W-9 status).
   - Issues publishes `property_operations.payment_requested` (vendor_id, amount, issue, job, W-9_status).
2. **Accounting:** Receives task, reviews W-9/agreement/invoice/approval threshold.
   - Accounting role writes: payment_requests.status = Approved, approved_amount, approver_role.
   - Issues reads this status (does NOT write it).
3. **Accounting issues check:** Issues reads payment_requests.status to update payment_status on cost_entry.
4. **Issues does NOT:** Issue the check, modify account charges, write paid_date.

---

## Integrity Rules (Spec §21, §28.3, §30.4)

1. **Eligibility service is the chokepoint** (spec §28.3): All release/contract commands check current holds, property status, financial/legal prerequisites at commit time.
2. **Events are not shortcuts** (spec §30.4): A loan.defaulted event does not release the property; it opens an issue. Issues must complete recovery prerequisites before releasing.
3. **Idempotency** (spec §21, §28.7): Same event/command twice = one result; no duplicate issues, tasks, holds, costs.
4. **Atomicity** (spec §21, §28.7): Cross-record updates (issue + hold + task) commit together or fail together.
5. **Stale decision detection** (spec §28.7): Reinstatement invalidates stale pending release/contract approvals; command fails if prerequisites conflict.
6. **No silent conflicts** (spec §28.7): Unresolved conflicts enter visible exception queue with owner, reason, recovery path.
