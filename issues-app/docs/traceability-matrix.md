# Traceability Matrix — Spec Sections to Implementation Components

Source: DESIGN.md §2 (scope), spec §26 (developer deliverables and traceability).

This matrix maps every spec section implemented in Phase 1 (per DESIGN.md §2 scope) to its implementation components (migration files, services, screens, tests). Deferred sections (DESIGN.md §2 deferrals) are listed separately with their schema seams. **Wave 2** (roadmap: `docs/roadmap-waves.md`) delivered additional work after Phase 1 closed out — see the "Wave 2 Sections" table below the Phase-1 table; §8.2 in particular moved from deferred to delivered (dashboard/exception queues shipped in Wave 2) but its row in the Deferred table has not been removed, only annotated, to preserve the original Phase-1-era record.

---

## In-Scope Sections (DESIGN.md §2) → Components

| Spec Section | Topic | Migration Files | Database Tables | Services | Screens | Tests | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **§4** | Issue types and case structure | 001_schema.sql | issues, issue_cycles, phase_instances | issue-service.ts | /issues/[id] | transition.test.ts, issue.test.ts | Five issue types defined in seed config: default_recovery, covenant_violation, market_readiness, property_legal, buyer_cleanup. |
| **§5** | New issue intake and required information | 001_schema.sql | issues, issue_people | issue-service.ts, validation.ts | /issues/new | intake.test.ts | Required fields enforced: property, summary, people, task, due date, priority/restriction. Map link required for default_recovery. |
| **§6.1** | Default, voluntary surrender, legal, and recovery | 001_schema.sql, seed_config.sql | issues, phase_instances, holds, transitions config | transition-engine.ts, eligibility-service.ts | /issues/[id] | transition.test.ts (Example A, B) | Voluntary Surrender state determines pathway (accepted → map review; non-signed → legal). Map review cleared without neighbor, or neighbor confirmed. |
| **§6.2** | Foreclosure Page and buyer cleanup | 001_schema.sql, seed_config.sql | issues, phase_instances, tasks | issue-service.ts, task-service.ts | /issues/[id] (buyer_cleanup section) | buyer-cleanup.test.ts (Example C) | Buyer cleanup issue created on transaction.completed event. Separate from CCL cleanup. Deadline typically 30 days; midpoint, one-week-prior, and action-date reminders. |
| **§6.3** | CCL cleanup and relisting | 001_schema.sql | issues, bids, vendor_jobs, cost_entries, change_orders, personal_property_items | transition-engine.ts (cleanup phase), hold-service.ts | /issues/[id] (cleanup section) | cleanup.test.ts, vendor.test.ts | Assessment records category, severity, inputs, photos. Second bid ≥$1,500 or severity ≥4. Contract, change orders, final verification required. |
| **§6.4** | Covenant violations | 001_schema.sql, seed_config.sql | issues, issue_cycles, notices, holds | issue-service.ts, hold-service.ts, task-service.ts | /issues/[id], new issue intake | covenant.test.ts (Example D) | One case per owner/property incident; multiple reports attach. First notice (14 days default), second notice, escalation, resolved. Reopened as new cycle if violation repeats. |
| **§7** | Tasks, dates, waiting, and handoff | 001_schema.sql | tasks, deadlines | task-service.ts | / (task queue) | task.test.ts | Action date, target completion date, verified completion date stored. Waiting/blocked/on_hold require reason, dependency, next follow-up date. Missing either = flagged (spec §5.2). |
| **§8.1** | Personal work screen and task queues | 001_schema.sql | tasks, issues (lifecycle_status joins) | task-service.ts, queue-service.ts | / (default screen) | task-queue.test.ts | Queues: new_unreviewed, action_dates, notices_due, upcoming, overdue, waiting_blocked, approvals (configurable, seeded). |
| **§8.2** | Team and management dashboards | Deferred (Phase 1 scope); basic query foundation in place. | issues, vendor_jobs, cost_entries | — | — | — | Reports, filtering (MTD/month/QTD/YTD/custom), comparable-median variance, off-market aging. Deferred to Phase 2. |
| **§8.3** | Notifications and escalation | 001_schema.sql | notifications config | notification-service.ts (seam exists; consumption deferred) | Settings → Notifications | — | Configurable: urgency rules, recipients, channels (in-app/email/SMS), manager alert delay (default 3 days, spec §8.3). |
| **§10** | Inventory, sales, website, and release controls | 001_schema.sql | holds, releases, audit_events | eligibility-service.ts | /issues/[id], release controls | eligibility.test.ts (§28.3 scenarios) | Release checks: no blocking hold, condition/vacancy verification, legal/default clearance, map present, price review ≤6 months. Property never becomes Available while hold exists. |
| **§11** | AI copilot requirements | Deferred (schema seams, domain_events ready; no implementation in Phase 1). | domain_events table | — | — | — | AI never acts (no send, state change, legal stage, release). Phase 2+. |
| **§12** | Roles, permissions, settings, and audit | 001_schema.sql, seed_config.sql | config_versions, config_entries, audit_events, roles config | config-service.ts, audit.ts | Settings → Configuration, Roles, Notifications | audit.test.ts, permission.test.ts | Roles (employee, coordinator, manager, loan_services, sales, accounting, admin, service) editable. All edits audit-logged. Historical records preserve retired labels. |
| **§16** | Migration from Airtable to Supabase | Deferred (schema + seeded config ready). Migration tooling out of scope Phase 1. | All tables include source_system, external_id fields | — | — | — | Property_refs, person_refs are read-model aliases (not canonical Person/Property). Airtable IDs preserved as external_id. |
| **§17** | Sample workflows (Examples A–D) | — | — | — | — | transition.test.ts (A, B), buyer-cleanup.test.ts (C), covenant.test.ts (D) | Examples A–D tested via acceptance scenarios showing phase transitions, holds, task creation, outcomes. |
| **§20** | Canonical data model | 001_schema.sql (ERD + data dictionary in migrations) | issues, issue_cycles, phase_instances, tasks, holds, property_refs, person_refs, issue_people, evidence_files, communication_events, bids, vendor_jobs, cost_entries, payment_requests, approvals, config_versions, domain_events, audit_events, integration_identities, deadlines, notices, checklist_items | — (schema-only) | — | schema.test.ts (migration replay) | One UUID PK per table. Property/Person are external refs (not canonical). Audit_events append-only (trigger prevents UPDATE/DELETE). |
| **§21** | Workflow engine and state-transition | 001_schema.sql, seed_config.sql (transitions array) | issues, phase_instances, holds, config_entries (transitions) | transition-engine.ts, eligibility-service.ts | /issues/[id] (phase controls) | transition.test.ts, idempotent.test.ts | Data-driven transitions (from_phase, to_phase, prerequisites, tasks, holds). Server rechecks prerequisites at commit. Idempotent; no duplicate issues/tasks/holds. |
| **§23** | Roles, security, privacy, and audit controls | 001_schema.sql (RLS scaffold) | audit_events, evidence_files (access_classification), all tables with RLS | — (scaffold) | Settings → Configuration, Roles | rls.test.ts (role denial smoke tests) | RLS policies present (Phase 1 broad, future stricter per Master Vision D17). Service-role credentials not in browser. Exports audit-logged and filtered. |
| **§28.3** | Contract and listing eligibility service | 001_schema.sql | holds, issues, cost_entries (and linked Account, Contract via domain events) | eligibility-service.ts | /issues/[id], release controls | eligibility.test.ts (§28.8 scenarios) | Release blocked when: active hold, cleanup incomplete, VS not effective, price stale, or conflicting pending command (spec §28.3 minimum set). All blocking reasons + owner + next action returned. |
| **§28.4** | Voluntary-surrender lifecycle and reinstatement rule | Deferred (seam: issue linked to account; reinstatement event consumed; no VS state machine in Issues scope). | issues.account_id (ref); domain_events consumed | issue-service.ts (consumes loan.voluntary_surrender_effective) | — (Loan Services UI owns VS state machine) | — | Property Operations consumes VS_effective event; determines pathway (accepted → map review). Does not own VS state machine. |
| **§28.5** | Account reinstatement and cleanup interruption | 001_schema.sql, seed_config.sql (existing_contract_active hold type) | holds, phase_instances, audit_events | transition-engine.ts, hold-service.ts (reinstatement event consumed) | /issues/[id] | reinstatement.test.ts (§28.8 scenarios) | Reinstatement_effective event → existing_contract_active hold placed. Cleanup moves to Reinstatement Review phase. Prior work preserved. Coordinator decides disposition. |
| **§28.6** | Communications, notices, and shared tasks | 001_schema.sql | communication_events, communication_links, notices, tasks (shared) | task-service.ts, communication-service.ts (seam) | /issues/[id] (timeline), Settings → Notifications | communication.test.ts (linked events, no duplicates) | Shared task inbox; issue owns property-operations source. One notice event per communication (no copies). |
| **§29.2** | Complete edit history and evidence chain of custody | 001_schema.sql | audit_events (append-only), evidence_files (versions), all tables with updated_at + user tracking | audit.ts | /issues/[id] (history view), evidence management | audit.test.ts, evidence.test.ts | Immutable file versions; derivatives link to original. Removal via archive (no hard delete). Audit retains actor, role, reason, prior/new value, correlation. |
| **§29.6** | Possession and abandoned personal-property workflow | 001_schema.sql, seed_config.sql (possession_statuses) | possession_records, personal_property_items | hold-service.ts (occupancy/stop_work holds) | /issues/[id] (possession section) | possession.test.ts | Configurable statuses: unknown, occupied_or_suspected, vacancy_unverified, vacancy_verified, personal_property_present, removal_disposition_review, removal_authorized, stored, transferred, disposed, cleared. Inventory + chain of custody + disposition. |
| **§29.7** | Cost allocation, payment request, and recovery | 001_schema.sql | payment_requests, cost_entries, bids, vendor_jobs | payment-service.ts | /issues/[id] (costs section), vendor management | payment.test.ts, cost.test.ts (duplicate prevention) | Payment request: vendor/job, invoice, amount, W-9, cost_classification (estimated→bid→approved→paid). Duplicate guard (vendor+invoice+amount+job). Does NOT auto-post charge (spec §29.7). |
| **§29.8** | Vendor compliance and change control | 001_schema.sql | vendors, bids, vendor_jobs, change_orders | vendor-service.ts, approval-service.ts | /issues/[id] (vendor section) | vendor.test.ts, compliance.test.ts | Vendor profile: W-9, agreement, insurance, expiry dates, do-not-dispatch. Change orders versioned (requester, amount, reason, approval). Compliance checks at bid approval, dispatch, payment. |
| **§29.9** | Related cases and multi-property events | 001_schema.sql | issue_relationships | issue-service.ts (relationship search) | /issues/[id] (related cases section) | relationships.test.ts | Relationship types: parent_child, related, duplicate_of, caused_by, converted_to, supersedes, same_incident, shared_legal_matter. No merge; separate owners, stages, costs. |
| **§29.10** | Legal/operational stop-work control | 001_schema.sql, seed_config.sql (stop_work hold type) | holds | hold-service.ts | /issues/[id] (holds section, stop-work controls) | stop-work.test.ts | Authorized users place immediate stop-work/review-required hold. Blocks notices, vendor dispatch, cleanup/removal, disposal, listing, release, new-contract. Exception scope + reason + evidence required. |
| **§30.2** | One writer per fact | See "Source-of-Truth-Matrix" document. | All tables with clear ownership. | Various (eligibility, hold, issue, task services per ownership). | — | — | Property Operations writes only its operational facts. Never writes: inventory availability, loan facts (lsp_*), sales facts, Accounting payment_issued, Person canonical, Document lifecycle. |
| **§30.3** | Shared domain event log and queued integration | 001_schema.sql, seed_config.sql | domain_events, consumed_events | events.ts (publish), consumer patterns (consume, seam) | — | — | Property Operations publishes issue_opened, hold_applied, hold_released, cleanup_required, cleanup_verified, release_approved, payment_requested, issue_closed. Consumes loan.defaulted, reinstatement_effective, VS_effective, transaction.completed (buyer cleanup). No bespoke sync. |
| **§30.4** | Safe default-to-availability event chain | 001_schema.sql, seed_config.sql | issues, holds, domain_events, audit_events | transition-engine.ts (default pathway), events.ts | — | default-to-availability.test.ts (OPS-MV-001) | Loan Services publishes loan.defaulted → Issues creates issue, establishes restrictions, evaluates prerequisites → Issues publishes release_approved → Inventory/Website writes availability. Release never automatic. |
| **§31.2** | Stale-case acknowledgment | 001_schema.sql | stale_acknowledgments, tasks | task-service.ts (stale prompt) | /issues/[id] (stale prompt modal) | stale.test.ts (OPS-SUP-002) | Configurable threshold (14 days default). Prompt cannot be silently dismissed; coordinator records explanation + next task. Acknowledgment audited. Escalates to manager if unresolved. |
| **§31.3** | Phase-based document and evidence checklist | 001_schema.sql, seed_config.sql (checklist templates per phase) | checklist_items, config_entries (checklists) | checklist-service.ts | /issues/[id] (checklist section) | checklist.test.ts (OPS-SUP-003) | Status: required_missing, present, verified, waived, not_applicable, superseded. Deficiency shown. Transition blocked if required item missing (unless waived). Checklist is view over canonical records (no file copies). |
| **§31.4** | Filterable case and audit history | 001_schema.sql (domain_events, audit_events) | audit_events, domain_events | query-service.ts (history filter) | /issues/[id] (history view with filters) | history.test.ts (OPS-SUP-004 events) | History filterable by: transitions, communications, documents, tasks, approvals, holds/releases, costs, integration, field edits. Default emphasizes meaningful events. All entries resolve to canonical records (no copies). Permissions enforced per RLS. |
| **§31.5** | Weekend, holiday, and off-hours deadline warnings | 001_schema.sql, seed_config.sql (company calendar config) | deadlines, calendar_config | deadline-service.ts (comparison logic) | /issues/[id] (deadline display with warnings) | deadline.test.ts (OPS-SUP-004) | Phase 1 stores deadline verbatim; no recalculation. System warns if deadline falls outside working hours. No AI deadline inference. Calendar/holiday config editable via settings. |
| **§31.6** | Operational ownership, backup coverage, and delegation | 001_schema.sql | phase_instances.owner, issues.coordinator, delegations | task-service.ts (backup tracking) | /issues/[id] (ownership display), Settings → Users (delegation) | delegation.test.ts (OPS-SUP-005) | Every active phase shows accountable role, owner/queue, backup/delegate, scope, start/end condition. Delegate scope and temp. coverage logged (actor, reason, approver). Permanent owner distinguishable in history. |
| **§31.7** | Vendor capability and performance facts | 001_schema.sql | vendors, vendor_jobs, bids, cost_entries | vendor-service.ts (metric calculation) | Vendor profile screen | vendor-metrics.test.ts (OPS-SUP-006) | Vendor profile: service categories, states/counties, distance radius, W-9 status, compliance dates. Metrics: jobs requested/completed, avg bid, avg cost, on-time %, documentation %, disputes, payment history. No subjective rating in Phase 1. |
| **§31.8** | Business and relisting priority separate from urgency | 001_schema.sql, seed_config.sql | issues.business_priority (configurable input snapshot) | — (seeded config only) | /issues/[id] (priority display) | priority.test.ts (OPS-SUP-007) | If enabled: separate from legal urgency, task due date, safety risk. Inputs: Website interest, comparable time on market, margin, time off market, inventory. Formula versioned. Override + reason audited. Never suppresses legal/safety holds. |
| **§31.9** | Required implementation appendices | — (separate documents) | — | — | — | — | Screen/field inventory, state diagrams (workflow-state-machines.md), permission/RACI matrix (permission-matrix.md), validation/error catalog, report catalog, seed data, test fixtures (generated). |
| **§31.10** | Measurable performance acceptance | — (separate performance plan) | — | — | — | — | Expected/peak volumes, response-time targets (2-sec goal examples), percentile-based SLOs at expected/peak. Performance tests at approved volume with RLS + audit enabled. |

---

## Wave 2 Sections (Waves 1/2a/2b) → Components

This matrix's header and the table above describe Phase 1 (DESIGN.md §2)
scope only — Wave 2 (roadmap: `docs/roadmap-waves.md`) delivered
substantial additional work afterward that was never folded back into the
table above. Listed here rather than merged into it so the Phase-1 rows'
provenance stays clear; a future pass can merge both into one table.

| Spec Section | Topic | Migration Files | Database Tables | Repositories/Services | Screens | Tests | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **§15 / §25** | All Issues database view: filters, sort, search, keyset pagination, saved views | `20260804100000_issues_scale_indexes_search_views.sql` | issues, property_refs, saved_views | issues-query-repo.ts, saved-views-repo.ts, saved-view-service.ts | `/issues` | issues-query-repo.test.ts, saved-views.test.ts | 300-case volume seed (scripts/demo-seed.ts). Grouped view + saved view create/list/delete server actions in app/actions.ts. |
| **§29.11 / §29.2** | Issue timeline (chronological multi-source "story" view) | (reads existing tables; no new migration) | communication_events, communication_links, audit_events, phase_instances, notices, issue_people | timeline-repo.ts | `/issues/[id]/timeline` | comms-timeline.test.ts, issue-timeline-view.test.ts | Merges comms/audit/phase-open-close/notice/issue-link sources into one interleaved, keyset-paginated feed. |
| **§9.1 / §29.11** | Person page: CRM communications + people, person timeline | (reads existing tables) | person_refs, communication_events, communication_links, issue_people | people-repo.ts | `/people`, `/people/[id]` | people-repo.test.ts, people-timeline-page.test.ts | Search by person/phone/email (§15). Person hover cards (contact_snapshot allowlist, app/_lib/reference-data.ts). |
| **§13 / §8.2 / §14** | Manager dashboard + data-quality exception queues + admin activity metrics | (reads existing tables) | issues, tasks, holds, audit_events, phase_instances | dashboard-repo.ts, exceptions-repo.ts, audit-metrics-repo.ts | `/dashboard`, `/exceptions`, `/activity`, `/admin/activity` | dashboard-exceptions.test.ts, comms-timeline.test.ts (audit-metrics-repo block) | §8.2 ("Team and management dashboards") is listed as Deferred in the table below from the original Phase-1 matrix — that deferral is now stale; a real dashboard + exception-queue implementation shipped in Wave 2. |
| **§9.1 / §30.2** | Case left-panel contract/transaction overview | `20260804120000_issues_contract_refs.sql` | contract_refs | contract-refs-repo.ts | `/issues/[id]` (left panel), `/contracts/[id]` | contract-refs.test.ts | Read-model cache, NOT canonical (Hub Sales/Transactions module owns the real Contract record). |
| **§29.1** | Cross-matter communication tagging | (reads communication_links) | communication_links | comms-repo.ts, timeline-repo.ts | `/issues/[id]/timeline` | comms-timeline.test.ts | A communication linked to more than one issue surfaces a "cross-matter" flag on the non-primary issue's timeline. |

---

## Deferred Sections (DESIGN.md §2 Deferrals) with Schema Seams

Deferred items have placeholder tables or schema columns; no implementation in Phase 1. Listed with their implementation seams for Phase 2+.

| Deferred Section | Topic | Schema Seam | Database Table(s) | Planned Phase 2+ Implementation |
| --- | --- | --- | --- | --- |
| **§8.2** | Team and management dashboards | ~~Query layer placeholder.~~ **STALE — delivered in Wave 2, see the "Wave 2 Sections" table above.** Remaining Phase-1-scope gaps below (MTD/QTD/YTD custom ranges, comparable-median variance, performance rankings) are still open. | issues, vendor_jobs, cost_entries, tasks, holds, audit_events (dashboard-repo.ts, exceptions-repo.ts now query these) | Filtering (MTD/month/QTD/YTD/custom), comparable-median variance, off-market aging (delivered), performance rankings (still open). |
| **§11** | AI copilot requirements | domain_events + communication_events schema ready. AI service seam in events.ts (consume/publish). | domain_events, communication_events, ai_summaries (deferred table) | Weekly AI summary generation (read communication_events, calls, transcripts, notes). Draft email/letter/notice/task. Drafts read-only; no send/state-change/release. Separate from user descriptions. Version retention. |
| **§16** | Airtable migration from Airtable to Supabase | All tables include source_system, external_id for provenance. property_refs, person_refs are read-model aliases. | property_refs.external_id, person_refs.aliases (jsonb), all tables with source_system | Migration tooling: source inventory, field mapping, duplicate detection, attachment reconciliation, cutover runbook, business acceptance, reconciliation report. |
| **§29.1** | Weekly AI living case summary | Same as §11. | domain_events, communication_events, ai_summaries | Scheduled weekly refresh of auto-generated living summary (refreshes on request after material event). Coverage time, source references, prior versions retained. Excludes irrelevant comms from other matters. |
| **§29.3** | One-click operational case packet | Case packet generation seam. Evidence_files + checklist_items + phase_instances allow export. | evidence_files (version_id), case_packets (deferred table) | Generate immutable snapshot (case summary, people, phases, chronology, comms, notices, tasks, holds, bids, costs, evidence, docs, outcome). Standard/full/custom scope. Print PDF + ZIP bundle. Manifest, redactions, missing-item warnings. |
| **§29.4** | One-click attorney referral package | Specialized packet seam. Checklist-based requirements. | case_packets (reuses), attorney_packages (deferred table) | Specialized packet template: parties, contract, payment history, property info, summaries, notices, evidence, legal docs, costs, holds, deadlines, open questions. Configurable checklist. Incomplete flag. Version retention. |
| **§29.12** | State legal deadline calculation engine | Deadlines table stores user-entered/external deadlines verbatim with source + verification_status. No calculation in Phase 1. | deadlines table (source, rule/template_reference, verification_status fields ready for Phase 2) | Phase 2+: Build state-specific legal event/status/notice templates. Effective-dated, jurisdiction-specific, counsel-approved. Phase 1 continues verbatim storage; Phase 2 adds inference (but never replaces audit trail). |
| **§31.11** | Future imagery-assisted discovery | No implementation. imagery schema column reserved (future). observation_leads table placeholder. | imagery (deferred), observation_leads (deferred) | Phase 2+: Imagery source (satellite/aerial), model version, inputs, confidence. Anomaly flags (structures, debris, vehicles, fire, vegetation). Observation lead (not verified evidence). No auto-dispatch, contact, or release from imagery. |
| **§31.12** | AI-driven predictive default risk | Deferred to Loan Services (owns default risk). Issues may consume risk event or display indicator. | — (owned by Loan Services) | Loan Services owns predictive default-risk analysis. Property Operations may consume approved risk event or display authorized indicator, but does NOT recalculate or override Loan Services result. |

---

## Test Coverage Summary (DESIGN.md §9)

All Phase 1 tests run on PGlite (Postgres-in-WASM) with migrations replayed fresh.

| Test Category | Test Files | Scenarios / Coverage |
| --- | --- | --- |
| **Migration replay** | schema.test.ts | All migrations run in timestamp order on fresh PGlite. No failed migrations. |
| **Transition & workflow** | transition.test.ts | §28.8 acceptance scenarios (8 required + Examples A–D from §17). Idempotent transitions. Duplicate loan.defaulted events → one issue. Release blocked by each hold type. Cleanup+possession unresolved blocks release. Reinstatement moves work to Reinstatement Review. Duplicate payment request blocked. Stale acknowledgment required. |
| **Idempotency** | idempotent.test.ts | Same event/command twice → same result. No duplicate issues, tasks, holds, costs. Webhook retries, user retries, duplicate submissions all idempotent. |
| **RLS & roles** | rls.test.ts, permission.test.ts | RLS policy presence. Role write denial (coordinator cannot release stop-work hold without manager). Audit_events insert-only. Evidence_files access_classification honored. (Smoke tests within PGlite limits.) |
| **Intake & validation** | intake.test.ts | Required fields enforced (property, summary, people, task, due date, priority). Map link required for default_recovery. Map optional for covenant. |
| **Phase transitions** | [issue-type].test.ts (default-recovery, covenant, market-readiness, property-legal, buyer-cleanup) | Each issue type's phase sequence. Successful transitions. Failed prerequisites return blocking reason + owner + next action. |
| **Holds & eligibility** | eligibility.test.ts, hold.test.ts | Release blocked by legal, safety, occupancy, cleanup, foreclosure, title, covenant, stop_work, existing_contract_active holds. Release eligibility checks all prerequisites (spec §28.3 minimum set). Duplicate holds on same property. Overlapping hold dates. |
| **Cleanup & vendor** | cleanup.test.ts, vendor.test.ts, compliance.test.ts | Condition assessment. Second-bid rule (≥$1,500 or severity ≥4). Bid completeness (cost, time, photos). Change orders. Final verification. W-9 check. Vendor compliance at payment. |
| **Covenant workflow** | covenant.test.ts | One case per incident. First notice (14 days). Cure verification. Partial work (case remains open). Second notice. Escalation. New violation reopens as new cycle. |
| **Buyer cleanup** | buyer-cleanup.test.ts | Created on transaction.completed event. Deadline (30 days default). Midpoint + one-week-prior + action-date reminders. Completion verification. Escalation if not completed. Separate from CCL cleanup. |
| **Possession** | possession.test.ts | Possession status transitions. Personal property inventory. Occupancy/safety holds block disposal/release. Chain of custody. |
| **Cost allocation** | cost.test.ts, payment.test.ts | Cost classification (estimated→bid→approved→paid). Duplicate payment prevention. W-9 + agreement checks. Cost does not auto-post charge. Accounting approval required. |
| **Audit** | audit.test.ts | Every command writes audit_events (actor, role, action, before/after, reason, timestamp, correlation). Audit_events insert-only (RLS trigger prevents UPDATE/DELETE). Historical records retain retired labels. |
| **Communication** | communication.test.ts | One communication event per notice/call/email (no copies). Links to issue, person, task. CRM events readable by Issues. |
| **Stale case & acknowledgment** | stale.test.ts | Configurable threshold (14 days). Stale prompt created. Coordinator cannot dismiss without explanation + next task. Escalates to manager. |
| **History & export** | history.test.ts | History filterable (transitions, comms, docs, tasks, approvals, holds, costs). All entries resolve to canonical records. Redactions applied per access_classification. Audit-logged. |
| **Spec §28.8 acceptance scenarios** | Various (referenced per scenario) | 8 required scenarios: cleanup active → blocked contract; cleanup not verified → blocked listing; VS partial → reinstatement allowed; VS effective → old Account blocked; arrears paid (not approved reinstatement) → cleanup continues; reinstatement before cleanup → Reinstatement Review; reinstatement during work → exception + preservation; concurrent reinstatement + release → only valid action commits; duplicate loan.defaulted → one issue; complete Person/Account/Property/Issue history reconstructable. |
| **Spec §31 supplemental scenarios** | Various (OPS-SUP-001 through OPS-SUP-010) | Unverified report intake and follow-up. Stale-case acknowledgment. Checklist blocking/waivers. Deadline warnings (no recalc). Delegation + coverage. Vendor metrics (no subjective rating). Business priority ≠ urgency. Implementation artifacts. Performance at volume. Imagery leads (no auto-action). |
| **Master Vision alignment scenarios** | default-to-availability.test.ts + various | OPS-MV-001 through OPS-MV-008: Duplicate loan.defaulted → one issue. Hold blocks release. Release approved → Inventory writes. Airtable shadow read-only. Event subscriber unavailable → safe retry. Identity evidence queued (no competing Person). Portal auth denies guessed ID. Direct write to Inventory/lsp_* rejected. |

---

## Traceability: Spec §26 Deliverables Checklist

Per spec §26, required Phase 1 implementation artifacts:

- [ ] **Version-controlled source code:** GitHub repo `/home/user/Scraper/issues-app` with semantic commit history.
- [ ] **Database migrations:** `supabase/migrations/` timestamped, replay-clean, idempotent.
- [ ] **RLS policies:** `supabase/migrations/` include RLS policies on audit_events, evidence_files, holds (phase 1 broad; future stricter).
- [ ] **Configuration seeds:** `supabase/migrations/20260731090300_issues_seed_config.sql` (issue types, transitions, thresholds, roles, hold types, etc.).
- [ ] **Drizzle schema:** `lib/db/schema.ts` matches migrations; relationships, enums, timestamps.
- [ ] **Services:** `lib/services/` (transition-engine.ts, eligibility-service.ts, hold-service.ts, issue-service.ts, task-service.ts, audit.ts, events.ts).
- [ ] **Screens:** `app/` (personal task list `/`, issue case view `/issues/[id]`, intake `/issues/new`).
- [ ] **Test fixtures:** `test/fixtures/` (seed data, edge cases, acceptance scenarios).
- [ ] **Automated tests:** `test/` (unit, integration, permission, transition, idempotency, RLS smoke tests).
- [ ] **User-acceptance scripts:** Per issue type, role, approval, hold/release, reopen, migration, search, report, integration-failure paths (in test comments or separate UAT doc).
- [ ] **Deployment definitions:** `supabase/` config, GitHub Actions (dry-run only for Phase 1), `.env.example`.
- [ ] **Documentation:**
  - [ ] Data dictionary (DESIGN.md §1, ERD in migrations).
  - [ ] Workflow state machines (`docs/workflow-state-machines.md`).
  - [ ] Permission matrix (`docs/permission-matrix.md`).
  - [ ] Source-of-truth matrix (`docs/source-of-truth-matrix.md`).
  - [ ] Open decisions (`docs/open-decisions.md`).
  - [ ] Traceability matrix (`docs/traceability-matrix.md` — this document).
  - [ ] PORTING.md (Hub portability).
  - [ ] Known limitations and deferred-scope register.
- [ ] **Support runbooks:** Deployment, rollback, backup/restore, incident response, configuration, user admin (deferred to Phase 2 detailed implementation; outlines in place).
- [ ] **Training materials:** End-user and admin guides (deferred to Phase 2; UA scripts and docs serve as draft).

---

## Known Limitations & Deferred Scope Register

**Phase 1 explicitly excludes (per DESIGN.md §2):**
- AI weekly summaries (schema ready; no implementation).
- Case/attorney packet generation (schema ready; no implementation).
- PandaDoc/JustCall live integrations (integration_identities + communication_events seams exist; consumption deferred).
- Dashboards beyond basic task queues (foundation queries exist; no visualizations).
- Imagery analysis (schema reserved; no implementation).
- State legal deadline engine (stores deadlines verbatim; no AI inference).
- Domain_events transport to company-wide bus (table exists; consumer subscription deferred to central platform).
- Airtable migration tooling (schema prepared; migration jobs deferred).
- Customer Portal projection (Master Vision D17 prerequisite).

**Phase 1 intentionally limited (by business decision):**
- Broad internal view access (future RLS stricter per Master Vision; scaffold in place).
- All releases require manager approval (future individual limits configurable).
- No vendor rating system (factual metrics only; subjective rating deferred).
- Desktop-only UI (mobile property-operations field workflow deferred).
- No automated legal deadline calculation (Phase 1 stores user-entered/external deadlines verbatim).

**Testing constraints (within PGlite):**
- RLS policies tested for presence and basic role denial (full adversarial cross-boundary testing deferred to production environment after central authorization program defined, per spec §30.7).
- Service-role credential handling tested for absence in browser code; full monitoring deferred to production.

---

## Spec Coverage Summary

| Coverage | Count | Details |
| --- | --- | --- |
| **In-scope spec sections (Phase 1)** | 26 | §4, §5, §6.1–6.4, §7, §8.1–8.3, §10, §12, §20, §21, §23, §28.3–28.6, §29.2, §29.6–29.10, §30.2–30.4, §31.2–31.10 (selected) |
| **Wave 2 sections (delivered after Phase 1)** | 6 rows / ~7 distinct sections | §13, §14, §15, §25, §29.1, §29.11, §9.1 (§8.2 also moves from deferred to delivered — see its annotated row below) |
| **Deferred spec sections** | 7 (§8.2 moved to Wave 2 delivered, above) | §11, §16, §29.1 (Weekly AI summary sub-scope only — cross-matter tagging itself shipped, see Wave 2 table), §29.3–29.4, §29.12, §31.11–31.12 (with schema seams) |
| **Acceptance scenarios tested** | 28+ | Examples A–D (§17), §28.8 (8 required), §29.13 (10 OPS-ADD), §30.10 (8 OPS-MV), §31.12 (10 OPS-SUP) |
| **Test files** | 15+ | schema, transition, idempotent, rls/permission, intake, phase-specific (default-recovery, covenant, etc.), cleanup/vendor, compliance, possession, cost/payment, audit, communication, stale, history, delegation, vendor-metrics, default-to-availability |
| **Implementation files** | 40+ | migrations, schema.ts, services (7), screens (3), tests (15+), supporting utilities |
| **Documentation files** | 6 | DESIGN.md (controlling), workflow-state-machines.md, permission-matrix.md, source-of-truth-matrix.md, open-decisions.md, traceability-matrix.md (this document) |
