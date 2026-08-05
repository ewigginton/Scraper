# Permission Matrix — Property Operations Issues

Source: spec §12 (roles, permissions), §23 (RLS/security), DESIGN.md §7 (roles and RLS scaffold), seed config (roles list).

This matrix defines role-capability grants for Phase 1. Phase 1 grants broad internal view access (business preference, spec §23); the matrix and RLS scaffold exist and are tested. The Hub's central RLS program (Master Vision D17) will supersede these policies.

## Roles (Phase 1 Defaults, Seeded)

| Role | Display Name | Description |
| --- | --- | --- |
| `employee` | Employee | Broad internal view access; standard operations staff. |
| `coordinator` | Coordinator | Issue coordinator; can edit cases and tasks. |
| `manager` | Manager | Manager; approval authority and oversight. |
| `loan_services` | Loan Services | Loan servicing staff; account and payment ownership. |
| `sales` | Sales | Sales and First Dibs ownership. |
| `accounting` | Accounting | Payment approval and check issuance. |
| `admin` | Administrator | System configuration, user management, advanced overrides. |
| `service` | Service Account | System-generated or integration service account (read-only or scoped actions). |

---

## Capability Matrix: Roles × Capabilities

**Columns:**
- View: read access to issues, details, history, attachments.
- Create Issue: initiate new issue intake.
- Edit Case: modify summary, priority, people, task, deadline, phase assignment.
- Transition Phase: advance or return phase (subject to prerequisites).
- Apply/Release Hold: create or remove holds.
- Approve Payment: authorize payment requests (Accounting authority).
- Approve Release: approve property for release/availability (Manager/Admin authority).
- Override: manual override of prerequisites/rules (admin or authorized role).
- Configure: modify config entries, thresholds, roles, workflows (admin only).
- Export: download case packet, case data, audit history (with RLS filters).

| Role | View | Create Issue | Edit Case | Transition Phase | Apply Hold | Release Hold | Approve Payment | Approve Release | Override | Configure | Export |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **employee** | ✓ (broad) | — | — | — | — | — | — | — | — | — | ✓ (filtered) |
| **coordinator** | ✓ (broad) | ✓ | ✓ | ✓ (within role limits) | ✓ | ✓ (within authority) | — | — | — | — | ✓ (filtered) |
| **manager** | ✓ (broad) | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ (documented) | — | ✓ (filtered) |
| **loan_services** | ✓ (account/payment) | — | — (account events only) | — | — | — | — | — | — | — | ✓ (filtered) |
| **sales** | ✓ (property/sales) | ✓ (sale-related) | — (sale-related only) | — | — | — | — | ✓ (release approval) | — | — | ✓ (filtered) |
| **accounting** | ✓ (payment-related) | — | — (payment only) | — | — | — | ✓ | — | — | — | ✓ (filtered) |
| **admin** | ✓ (all) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (all) |
| **service** | ✓ (scoped) | ✓ (integration only) | — (specific fields) | ✓ (idempotent only) | — | — | — | — | — | — | — |

---

## Detailed Capability Descriptions

### View (Read Access)

**employee, coordinator, manager, admin:**
- Issue: type, phase, priority, summary, people, tasks, holds, release status, lifecycle_status.
- Details: all current fields, history, communications, evidence metadata, vendor jobs, costs, approvals, audit events (filtered by access_classification).
- Phase 1 business preference: broad internal access (spec §23). RLS policies exist and are tested but currently grant broadly.

**loan_services:**
- Scoped: related Account/Contract, payment history, default/reinstatement status, service notices, communication events linked to the issue (not private servicing notes).
- Cannot access: attorney/legal content, sensitive cost details without approval authority.

**sales:**
- Scoped: property status, release decision, sale-lead facts, First Dibs, website eligibility.
- Cannot access: vendor cost details, internal assessments, legal content unless approved.

**accounting:**
- Scoped: vendor, payment request, bid amount, W-9 status, invoice, payment history.
- Cannot access: non-cost issue details unless required for approval.

**service:**
- Scoped: records created or modified by the service account only (idempotent consumed events, integration results).

---

### Create Issue

**coordinator, manager, admin:**
- Can create intake issues for any type.
- Must supply (spec §5.2): Property, Summary, People, Evidence (if required), Task (reviewer + due date), Priority/Restriction.

**sales (sale-related only):**
- Can create Buyer Cleanup issues on transaction notification.

**service (integration only):**
- Can create issues idempotently from domain events (loan.defaulted → Default recovery case, spec §30.4).

---

### Edit Case

**coordinator, manager, admin:**
- Summary, priority, people (add/remove), next task, due date, urgency flags, business_priority.
- Cannot directly edit: phase (use transition command), holds (use hold command).

**loan_services:**
- Can update account_id, payment_reference, account status fields only (when issue is linked to account).

**accounting:**
- Can update cost_classification (estimated → approved → paid) and payment fields only.

**sales:**
- Can update sale-lead, First Dibs, release_decision fields only.

---

### Transition Phase

**coordinator (within role limits), manager, admin:**
- Can request phase transitions.
- Server rechecks prerequisites and permissions at commit time (spec §21).
- Prerequisites are evaluated against current state (holds, linked records, dates).
- Failed transition returns all blocking reasons and responsible owner/next action (spec §28.3).

**service (idempotent only):**
- Can consume events and idempotently transition if service account is authorized for that event type.
- Transitions from consumed events must be idempotent (spec §21, §28.7).

---

### Apply/Release Hold

**coordinator (own holds), manager, admin:**
- Can apply holds: legal, safety, occupancy, cleanup, covenant, stop_work (spec §29.10).
- Coordinator can apply; manager/admin can release any hold type.
- Hold records: type, reason, scope, effective dates, release criteria, release authority.

**manager, admin (release authority):**
- Release requires reason, approver, and audit event (spec §29.2).
- Stop-work/review-required holds require manager or admin authority (spec §29.10).
- Coordinator cannot release stop-work holds without manager approval.

---

### Approve Payment

**accounting (required), manager (may co-approve), admin:**
- Payment request state: Draft → Submitted → Needs Information → Approved → Scheduled → Paid.
- Accounting authority checks: W-9 status, vendor compliance, contract/change orders, invoice/support docs (spec §29.8).
- Threshold: all payments routed to Accounting as configured (spec §29.7).
- Manager/admin can override missing compliance items (with reason, approval, audit).

---

### Approve Release

**manager, admin, sales (with restrictions):**
- Release eligibility checked immediately before commit (spec §28.3).
- Manager/admin can approve release if all prerequisites pass.
- Sales can approve release/availability only if property meets sales-specific review gates (configurable, spec §10).
- Failed eligibility returns all blocking reasons and responsible owner (spec §28.3).

---

### Override

**manager (documented), admin:**
- Override a failed prerequisite (e.g., skip second-bid requirement, waive evidence).
- Requires: reason, supporting evidence when applicable (spec §21, §13).
- When configured, may require approval (e.g., release with unresolved legal hold).
- Overrides never erase the failed prerequisite; audit history preserves the original requirement and decision (spec §21).
- No overrides of safety-critical rules without high-level approval (e.g., release property with active legal hold requires escalation, spec §28.3, §29.10).

---

### Configure

**admin only:**
- Add/rename/reorder/retire dropdown values (issue types, hold types, possession statuses, cost classifications, task queues, roles).
- Revise deadlines and review windows (price review, covenant cure periods, stale-case threshold).
- Change notification recipients and rules.
- Enable/disable workflow rules, validators, approval thresholds (spec §12).
- Modify role rights and individual approval limits.
- No development work required; all configurable via admin UI (spec §12).

---

### Export

**All roles (with RLS filters applied):**
- Can export case packets (standard/full/custom scope per permission).
- Can export audit history (filtered by access_classification).
- Can export lists (filtered by role view permissions).
- Exports record who exported what and when; restricted content is redacted (spec §23, §29.3).
- Case packet export is immutable snapshot with manifest, missing-item warnings, version references (spec §29.3).

**Restricted content (current Phase 1 intent: broad access; future RLS stricter):**
- Attorney/legal content: authorized roles only (spec §23).
- Payment approval details: accounting and manager only.
- Sensitive identity/contact data: as determined by policy.

---

## Transition and Prerequisite Validation (Spec §21, §28.3)

### Server-Side Enforcement (Defense in Depth)

1. **Permission check:** User role has capability for requested action.
2. **Prerequisite re-evaluation:** Current database state against transition definition.
   - If prerequisite fails, list blocking reason, owner, next action.
3. **Hold check:** Active holds block certain transitions (eligibility service, spec §28.3).
4. **Atomicity:** Cross-record transitions execute in one transaction; no partial updates.

### Failed Transition Response

Return structured error with:
- Blocked reason text (user-facing).
- Blocking hold type and owner (if applicable).
- Responsible role/owner for next action.
- Recommended path to resolution.

Example: "Cannot release property: active legal hold and cleanup not verified. Contact attorney for legal hold release approval; contact coordinator for cleanup verification."

---

## Audit Event Recording (Spec §12, §29.2)

Every capability exercise is audited:

| Capability | Audit Records |
| --- | --- |
| Create Issue | actor, role, issue_id, reason (intake source), timestamp, correlation_id |
| Edit Case | actor, role, field_name, prior_value, new_value, reason (if required), timestamp |
| Transition Phase | actor, role, from_phase, to_phase, prerequisites_checked, outcome, timestamp |
| Apply Hold | actor, role, hold_type, scope, reason, release_criteria, timestamp |
| Release Hold | actor, role, hold_id, reason, release_authority, timestamp |
| Approve Payment | actor, role (accounting), payment_id, decision (approved/denied), reason, timestamp |
| Approve Release | actor, role, issue_id, eligibility_checks (all passed), timestamp |
| Override | actor, role, requirement_overridden, reason, supporting_evidence, approval_if_required, timestamp |
| Configure | actor (admin), change_type, config_entry, old_value, new_value, effective_date, timestamp |
| Export | actor, role, export_type (packet/list/audit), scope, redactions_applied, file_reference, timestamp |

---

## Phase 1 RLS Scaffold (DESIGN.md §7, Spec §23)

Role-based Row Level Security policies implemented in Supabase:

- **issues table:** Broad access by default (Phase 1 business preference); future policies will restrict by access_classification.
- **audit_events table:** Insert-only; UPDATE/DELETE blocked by trigger (spec §12, §29.2).
- **payment_requests table:** Accounting/manager read; coordinator can create; accounting approves.
- **holds table:** All roles can read; coordinator/manager/admin write based on role.
- **evidence_files table:** Private storage by default (spec §23); access_classification honors RLS policies.

**Testing:** Smoke tests verify RLS policy presence and role write denial within PGlite limits (DESIGN.md §9).

---

## Shared and Deferred Policies (Master Vision D17)

Per spec §30.7, the Hub's central authorization program will define:
- One connection-class role model for Hub staff, salesperson/department scope, anonymous Website access, customer Portal access.
- Property Operations may add stricter classifications but shall not invent an incompatible per-app role model.
- Central RLS policies (connection-class driven) will supersede these role-capability descriptions.
- Property Operations remains compatible: stricter is allowed; incompatible is not.

**Deferred to Phase 2+:**
- Customer Portal access projection and customer-auth design (spec §30.1, §30.7).
- Sensitive-data policies for attorney/servicing/payment content (spec §23).
- Per-person/department scope (handled centrally in Master Vision authorization program).

---

## Approval Thresholds (Spec §18 Open Decision, §23)

**Phase 1 default (editable via configure):**
- **Release approval:** All releases require coordinator + manager approval or admin.
- **Payment approval:** All payments require accounting approval or manager/admin override.
- **Vendor bid (second-bid rule):** Bids ≥ $1,500 or severity ≥ 4 normally require second complete bid (spec §6.3); configurable exceptions per authorization.

**To change thresholds:** Admin edits configuration (no development required).

---

## Service Account Authority (Spec §23, Seeded)

The `service` account handles idempotent integration actions:
- **Event consumption (read-only from domain_events):** loan.defaulted, loan.reinstatement_effective, transaction.completed, etc.
- **Idempotent issue/task creation:** Create issues and tasks from events without duplication.
- **Idempotent field updates:** Mark specific fields as event-sourced (e.g., possession_status from external event).
- **Restrictions:** Service account never modifies user-editable fields, never approves/overrides, never writes to audit_events directly (audit_events are written by command layer with actor/role).

---

## Summary: Phase 1 Guards

1. **No property becomes Available while any active blocking hold exists** (spec §21, §28.3). Eligibility service enforces at command time.
2. **Transitions re-check prerequisites and permissions at commit time** (spec §21). Screen visibility is not the control.
3. **Overrides require reason, supporting evidence, approval when configured, and audit event** (spec §21, §13).
4. **Every action is audited** (spec §12, §29.2): actor, role, action, before/after, reason, correlation_id, timestamp.
5. **RLS scaffold exists and is tested** (spec §23). Hub's central authorization program will replace with stricter/compatible policies.
