# Issues (Property Operations) — Controlling Design

Working name: **Issues**. Formal name in requirements: **Property Operations**, a
Hub tile. This document is the build-controlling design for the Phase-1 foundation
delivered in this package. Where it conflicts with the requirements documents in
`docs/requirements/`, the requirements win; flag the conflict, don't silently pick.

Sources of truth (all in `docs/requirements/`):
- `property-operations-requirements.md` — the full Issues spec ("treat as god" for
  workflow rules; §30 controls shared-architecture questions).
- `ccl-systems-master-vision.md` — controls surfaces, one-writer-per-fact, events,
  RLS, sequencing.
- `hub-dev-guide-notes.md` — controls delivery mechanics (migrations, Drizzle,
  small PRs, validation).

## 1. What this package is

A self-contained, Hub-portable implementation of the Issues foundation:

- `supabase/migrations/*.sql` — timestamped migrations that replay cleanly in
  order, exactly the artifact the Hub dev guide requires.
- `lib/db/schema.ts` + repositories — Drizzle schema and repository modules, per
  the Hub architecture note (no scattered DB calls in components).
- `lib/services/` — the command layer: transition engine, eligibility service,
  hold/release commands, audit writer. Server-side only.
- `app/` — Next.js App Router screens: personal task list (default screen), issue
  case view, new-issue intake.
- `test/` — vitest + PGlite (real Postgres in WASM): migration replay, transition
  and eligibility rules, idempotency, audit.
- `docs/` — Phase-0 style package: data dictionary + ERD, workflow state machines,
  permission matrix, source-of-truth matrix, open decisions, porting guide.

It runs standalone (`npm run dev`) against any Postgres/Supabase dev database so it
can be demonstrated and reviewed, but every module is structured to move into the
Hub codebase as a tile (see `PORTING.md`). It deliberately has NO login of its own:
auth is stubbed behind `lib/auth/current-user.ts`, which the Hub replaces with its
shared staff identity (Master Vision §30.1 forbids a fourth surface or separate
staff auth).

## 2. Scope of this phase (and explicit deferrals)

In scope: canonical data model (§20), issue types and case structure (§4), intake
(§5), tasks/dates/waiting (§7), holds/restrictions and release prerequisites
(§10, §21, §28.3), transition engine (§21), possession status (§29.6), vendor
jobs/bids/costs/payment-request model (§6.3, §29.7, §29.8), covenant cycle model
(§6.4), audit events (§12, §29.2), stale-case rule (§31.2), checklists (§31.3),
related issues (§29.9), stop-work control (§29.10), config-as-data (§12), RLS
scaffold (§23, §30.7), seed configuration, personal work screen, case view, intake
UI.

Deferred (schema seams exist, no implementation): AI weekly summaries (§29.1) and
copilot (§11); case/attorney packets (§29.3–29.4); PandaDoc/JustCall live
integrations (integration_identities + communication_events tables are the seam);
Airtable migration tooling (§16, §24); dashboards beyond the basic queues (§8.2);
imagery analysis (§31.11); state legal deadline engine (§31.12 — Phase 1 stores
deadlines verbatim, never calculates them); domain_events transport (the table and
publish calls exist; the company-wide bus is governed centrally per §30.3).

## 3. Hard rules the implementation must encode

1. **No property becomes releasable while any active blocking hold exists.**
   Release evaluation happens server-side at command time against current DB state
   (§21, §28.3). The eligibility service is the single chokepoint.
2. **One writer per fact.** This app writes ONLY Property-Operations-owned facts.
   It never writes inventory availability, website status, loan/account facts, or
   sales facts. `property_refs` / `person_refs` are read-model references with
   external aliases — NOT canonical Person/Property tables (§30.2, §30.5).
3. **Every active non-passive issue has a coordinator/queue, summary, next task,
   and future due date** (§21). Passive-wait states require a wake-up event or
   review date.
4. **Audit everything.** Every command writes `audit_events` (actor, role, action,
   object, before/after, reason, correlation id) in the same transaction (§29.2).
   No hard deletes of audited records — archive/tombstone only.
5. **Idempotency.** Commands and consumed events carry idempotency keys; replays
   cannot duplicate issues, tasks, holds, costs, or transitions (§21, §28.7).
6. **Configuration is data**, versioned (`config_versions`): dropdown values,
   deadlines, thresholds (e.g. second-bid ≥ $1,500), notification rules, role
   rights. Historical records keep retired labels (§12).
7. **AI never acts.** No automated send, state change, legal-stage advance, or
   release from AI output (§11) — nothing in this phase wires AI to commands.
8. **Server enforces permissions**; UI visibility is never the control (§23).
   RLS scaffold + application checks are both present (defense in depth).

## 4. Stack

Next.js 15 (App Router) · TypeScript strict · Drizzle ORM (postgres-js driver) ·
Supabase-flavored Postgres (works on plain Postgres too) · vitest ·
@electric-sql/pglite for DB tests (migrations replay against real Postgres-in-WASM
so `npm run validate` needs no external DB) · no CSS framework dependency —
hand-rolled minimal CSS to keep the tile portable into the Hub's styling.

Commands: `npm run dev` (port 4182 to match Hub habit), `npm run validate`
(typecheck + migration replay + tests + build), `npm test`.

## 5. Data model (tables; all in migrations, all with `created_at/updated_at`)

Prefix: none (portable); every table gets UUID PK `id`. External aliases carry
`source_system` + `external_id` + provenance.

Reference/read-model (not canonical, per one-writer rule):
- `property_refs` — development, tract, state, county, map_link, coordinates,
  external aliases (Airtable id etc.), cached display fields, last_synced_at.
- `person_refs` — display name, kind (person/org), contact snapshot, canonical
  `person_id` nullable (filled when identity service lands), aliases jsonb.
- `issue_people` — time-bounded role link (owner, buyer, former_owner, neighbor,
  reporter, vendor, attorney, other) between issue and person_ref.

Core case model:
- `issues` — type (default_recovery, covenant_violation, market_readiness,
  property_legal, buyer_cleanup), property_ref_id, summary, priority,
  business_priority (separate from urgency, §31.8), coordinator, lifecycle_status
  (intake, active, waiting, blocked, on_hold, passive_wait, closed), current
  phase_instance_id, wake_event/review_date for passive states, config_version_id.
- `issue_cycles` — reopened reporting cycles; opened/closed, reason, outcome.
- `phase_instances` — phase key, owner, start/end, status, entry_reason,
  exit_outcome, handoff fields.
- `tasks` — assignee or queue, due_date, status, priority, source_rule,
  completion evidence link, links to issue/cycle/phase/property/person.
- `holds` — type (legal, safety, occupancy, cleanup, foreclosure, title, covenant,
  stop_work, existing_contract_active, other-configured), scope, effective dates,
  reason, source, owner, release criteria/authority, released_by/at/reason.
  Multiple simultaneous holds per property.
- `possession_records` — possession status enum-as-config (§29.6), observer,
  observed_at, evidence links.
- `personal_property_items` — inventory of belongings/vehicles/animals/hazards
  with custody + disposition chain (§29.6).
- `issue_relationships` — typed links (parent_child, related, duplicate_of,
  caused_by, converted_to, supersedes, same_incident, shared_legal_matter) —
  linking never merges timelines (§29.9).
- `stale_acknowledgments` — §31.2 acknowledgment trail.

Work/vendor/cost:
- `vendors` — profile: states/areas, radius, capabilities, W-9 status, agreement,
  insurance, expirations, do_not_dispatch, links person_ref.
- `bids` — scope, vendor, amount, est dates, completeness (cost+time+walkthrough
  evidence required for "complete"), status.
- `vendor_jobs` — approved bid, contract, scheduled/actual dates, change orders
  (versioned in `change_orders`), final cost, verification.
- `cost_entries` — classification (estimated, bid, committed, approved, invoiced,
  paid, additional_outside_contract, disputed, recoverable, customer_chargeable,
  waived, written_off) + who/why (§29.7).
- `payment_requests` — states Draft…Voided (§29.7), duplicate guard on
  (vendor, invoice_number, amount, job).
- `approvals` — requested action, threshold rule, requester, approver, decision,
  immutable link to affected command.

Evidence/comms/docs:
- `evidence_files` — immutable original versions, derivative links, checksum,
  captured/upload metadata, storage ref, access classification (§29.2).
- `communication_events` — normalized call/text/email/voicemail/notice with
  provider ids; linked to people/issues/tasks via `communication_links` (no
  copies, §28.6).
- `notices` — template version, recipients, address used, delivery evidence, cure
  deadline (§6.4, §28.6).
- `checklist_items` — versioned phase checklists with status
  (required_missing/present/verified/waived/not_applicable/superseded) (§31.3).

Platform:
- `config_versions` + `config_entries` — effective-dated configuration.
- `integration_identities` — internal object ↔ external system id + sync state.
- `domain_events` — outbox-style log written in-transaction (§30.3); consumed
  event dedup via `consumed_events` (idempotency keys).
- `audit_events` — append-only; block UPDATE/DELETE via trigger.
- `deadlines` — user-entered/externally-supplied deadlines stored verbatim with
  source + verification status (§31.5); calendar warnings are computed, never
  mutate the deadline.

## 6. Command layer (lib/services)

- `transition-engine.ts` — data-driven transition definitions (from config seed):
  allowed source→destination, required role, prerequisites, required fields,
  tasks created/closed, holds added/released, approvals, audit event. All
  transitions run in one DB transaction; server rechecks permission +
  prerequisites at commit time.
- `eligibility-service.ts` — THE chokepoint (§28.3): `checkReleaseEligibility` /
  `checkContractEligibility` returning every blocking reason with owner + next
  action. Called by release/contract commands immediately before commit.
- `hold-service.ts` — apply/release holds incl. stop-work (§29.10); release
  requires authority + reason.
- `issue-service.ts` — intake (§5.2 required fields enforced), reopen-as-new-cycle,
  stale acknowledgment, relationships.
- `task-service.ts` — consolidated inbox rules, action-date reminders, overdue
  escalation flags.
- `audit.ts` — audit writer used by every command (same transaction).
- `events.ts` — publishes `property_operations.*` domain events in-transaction.

## 7. Roles and RLS scaffold

Roles (config-driven): `employee` (broad view), `coordinator`, `manager`,
`loan_services`, `sales`, `accounting`, `admin`, `service`. Phase 1 grants broad
internal view (business preference) but the matrix and RLS policies exist and are
tested: write paths restricted by role; audit_events insert-only; evidence and
restricted legal records carry an `access_classification` honored by policies.
The Hub's central RLS program (Master Vision D17) will supersede these policies;
ours are written to be strictly compatible (stricter is allowed, incompatible is
not).

## 8. UI (Phase-1 screens)

- `/` — personal work screen: actionable task list with queues (new/unreviewed,
  action-date follow-ups, letters/notices due, upcoming, overdue, waiting/blocked,
  approvals). Row: property/state, issue type, stage, task, due date, priority,
  assignee, short summary. Complete / reschedule / open case.
- `/issues/[id]` — expandable case view: header (property, people, type, phase,
  owner, restriction, summary, next task + due date — missing either is flagged);
  collapsed sections for Legal, VS, Recovery Review, Bids, Cleanup, Buyer Cleanup,
  Relisting, History (filterable §31.4).
- `/issues/new` — intake form enforcing §5.2 (property, summary, people, task +
  due date, priority/restriction; map link field for recovery reviews).
- Desktop-only per §15; WCAG-mindful semantics.

## 9. Testing bar

- Migration replay in timestamp order on fresh PGlite must pass (mirrors Hub
  `npm run validate`).
- Transition tests: every §28.8 + §30.10 acceptance scenario that is in scope,
  especially: duplicate `loan.defaulted` events → one issue; release blocked by
  each hold type; cleanup-complete-but-possession-unresolved blocks release;
  reinstatement moves work to Reinstatement Review; duplicate payment request
  blocked; stale acknowledgment required.
- Idempotency tests for commands and consumed events.
- RLS smoke tests (policy presence + role write denial) within PGlite limits.
