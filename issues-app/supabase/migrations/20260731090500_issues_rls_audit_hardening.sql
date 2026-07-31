-- 20260731090500_issues_rls_audit_hardening.sql
-- Property Operations ("Issues") — fixes from adversarial review, batch 2:
-- RLS force + audit hardening. New migration; does not edit landed files.

-- =====================================================================
-- 1. FORCE ROW LEVEL SECURITY on every table that has RLS enabled.
-- =====================================================================
-- 20260731090200_issues_rls.sql enabled RLS on all case tables plus
-- payment_requests/config_versions/config_entries, but only FORCEd it on
-- audit_events and evidence_files. On a connection using the table owner
-- role, RLS without FORCE is silently bypassed for every other table —
-- the adversarial review's repro showed a 'sales'-context insert into
-- `issues` succeeding despite the coordinator/manager/admin write policy.
-- FORCE ROW LEVEL SECURITY closes that gap for the owner-role case (it
-- does not affect true Postgres superusers/BYPASSRLS roles, which no
-- policy can constrain by design — DATABASE_URL must not point at one in
-- any deployed environment; see PORTING.md).
do $$
declare
  forced_tables text[] := array[
    'property_refs', 'person_refs',
    'issues', 'issue_people', 'issue_cycles', 'phase_instances', 'tasks',
    'holds', 'possession_records', 'personal_property_items',
    'issue_relationships', 'stale_acknowledgments', 'deadlines',
    'vendors', 'bids', 'vendor_jobs', 'change_orders', 'cost_entries',
    'approvals',
    'communication_events', 'communication_links', 'notices',
    'checklist_items',
    'integration_identities', 'domain_events', 'consumed_events',
    'payment_requests', 'config_versions', 'config_entries'
  ];
  t text;
begin
  foreach t in array forced_tables loop
    execute format('alter table %I force row level security;', t);
  end loop;
end;
$$;

-- =====================================================================
-- 2. audit_events: block TRUNCATE too, not just row-level UPDATE/DELETE.
-- =====================================================================
-- Row-level triggers (the previous migration's audit_events_block_update/
-- _block_delete) do not fire on TRUNCATE, and RLS does not govern TRUNCATE
-- either — `truncate audit_events` would silently erase the whole trail.
-- Statement-level trigger closes that hole using the same reject function.
create trigger audit_events_block_truncate
  before truncate on audit_events
  for each statement execute function audit_events_block_mutation();

-- =====================================================================
-- 3. audit_events.actor_external_id: Hub staff identity is not a person_refs uuid.
-- =====================================================================
-- audit_events.actor_id is a uuid FK to person_refs, but Hub staff identity
-- (lib/auth/current-user.ts CurrentUser.id, e.g. 'dev-user' in the stub, a
-- Hub staff id in production) is a free-text external identity, not a
-- person_refs row. Passing it into actor_id would raise a type/FK error.
-- actor_external_id gives every audited command a place to record who did
-- it without requiring a person_refs row to exist for every staff member.
--
-- DECISION: a NOT NULL / CHECK guard requiring one of actor_id /
-- actor_external_id to be set is NOT added here. Most of this package's
-- existing service-layer tests intentionally call commands with no actor
-- context at all (system/service actions), so a hard constraint would
-- reject a large swath of already-correct, already-tested behavior; adding
-- it would require auditing and rewriting every test call site, which is
-- outside this fix's blast radius. Documented as a known gap rather than a
-- silent invention of a stricter rule than the existing test suite assumes.
alter table audit_events add column actor_external_id text;

comment on column audit_events.actor_external_id is
  'Free-text Hub staff identity (lib/auth/current-user.ts CurrentUser.id) for actions attributed to staff who do not (yet) have a person_refs row. actor_id remains the uuid FK to person_refs for actors that do.';

-- =====================================================================
-- 4. possession_records "latest" reads: deterministic tiebreaker.
-- =====================================================================
-- eligibility-service.possessionBlocker and transition-engine.vacancyVerified
-- both order by observed_at desc with no secondary key; two records inserted
-- in the same statement/transaction can share a timestamp, making "latest"
-- nondeterministic. created_at (and finally id) as tiebreakers, applied at
-- the query sites in application code (see lib/services/*), are backed here
-- by an index that makes that ordering cheap.
create index possession_records_property_ref_id_observed_created_idx
  on possession_records (property_ref_id, observed_at desc, created_at desc, id desc);
