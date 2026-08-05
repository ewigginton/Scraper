-- 20260731090200_issues_rls.sql
-- Property Operations ("Issues") — Row Level Security scaffold.
-- Design: DESIGN.md §7 ("Roles and RLS scaffold")
-- Requirements: property-operations-requirements.md §12 (broad internal view,
--               config-as-data), §23 (server enforces permissions; RLS +
--               application checks are both present), §30.7 (RLS)
--
-- Runs AFTER 20260731090000_issues_core.sql and 20260731090100_issues_work_platform.sql.
--
-- DECISION (per DESIGN.md §7 / Master Vision D17): this package has no local
-- users/staff table and does not run inside Supabase Auth's session model in
-- tests (PGlite), so policies do NOT use `auth.uid()` and this migration does
-- NOT `CREATE ROLE`. Instead, two helper functions read plain session GUCs
-- (`app.actor_id`, `app.roles`) that the application connection sets per
-- request/transaction (e.g. `select set_config('app.actor_id', $1, true)`),
-- and policies key off those. This works identically on Supabase Postgres and
-- on @electric-sql/pglite, satisfying DESIGN.md §9's RLS-smoke-test-under-
-- PGlite requirement.
--
-- The Hub's central RLS program (Master Vision D17) will supersede these two
-- helper functions and this policy set with the shared role model. Every
-- policy in this file is written to be STRICTLY COMPATIBLE with that eventual
-- model: at least as strict (never looser). When D17 lands, this migration's
-- policies are expected to be dropped/replaced wholesale, not patched.
--
-- Phase-1 shape (DESIGN.md §7, spec §12):
--   - SELECT: broad internal view — any authenticated actor may read any row,
--     EXCEPT evidence_files rows whose access_classification is
--     'restricted_legal' or 'restricted_financial', which require role
--     'manager' or 'admin' (spec §29.2). No other table in this schema
--     carries an access_classification column.
--   - INSERT/UPDATE: restricted by the role(s) appropriate to the table's
--     owning module:
--       * case tables (coordinator/manager/admin) — the general Property
--         Operations case, work, evidence, and comms model.
--       * payment_requests (accounting/admin) — payment-request state
--         changes are Accounting's module (spec §29.7).
--       * config_versions / config_entries (admin only) — configuration is
--         data, but only admins may version it (spec §12).
--   - audit_events: INSERT allowed for any authenticated actor (every command
--     writes its own audit row); NO update/delete policy at all — combined
--     with the append-only trigger from the previous migration
--     (audit_events_block_mutation) and FORCE ROW LEVEL SECURITY, this is
--     defense in depth (spec §29.2, §12).
--   - FORCE ROW LEVEL SECURITY on audit_events and evidence_files: these are
--     the two tables where even a table-owner-privileged connection must not
--     silently bypass RLS.
--
-- Application-layer permission checks (lib/services) remain the actual
-- control per spec §23 ("server enforces permissions; UI visibility is never
-- the control") — this scaffold is the defense-in-depth database layer, not a
-- replacement for it.

-- =====================================================================
-- Helper functions: actor identity + roles from session-local GUCs
-- =====================================================================

create function issues_current_actor()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.actor_id', true), '');
$$;

comment on function issues_current_actor() is
  'Session-local actor id read from the app.actor_id GUC, set by the application connection per request/transaction (e.g. set_config(''app.actor_id'', $1, true)). NOT Supabase auth.uid() and NOT a CREATE ROLE-based identity — a deliberate seam so these policies run unmodified on Supabase and on @electric-sql/pglite in tests. Null/empty means "no authenticated actor on this connection". The Hub''s central RLS program (Master Vision D17) will replace this function with the shared role model; policies here are written to be no looser than that eventual model.';

create function issues_current_roles()
returns text[]
language sql
stable
as $$
  select case
    when coalesce(current_setting('app.roles', true), '') = '' then array[]::text[]
    else string_to_array(current_setting('app.roles', true), ',')
  end;
$$;

comment on function issues_current_roles() is
  'Session-local comma-separated role list read from the app.roles GUC, set by the application connection (e.g. set_config(''app.roles'', ''coordinator,manager'', true)). NOT a CREATE ROLE-based role model — a deliberate seam so these policies run unmodified on Supabase and on @electric-sql/pglite in tests. Empty/unset means no roles. The Hub''s central RLS program (Master Vision D17) will replace this function with the shared role model (DESIGN.md §7 roles: employee, coordinator, manager, loan_services, sales, accounting, admin, service); policies here are written to be no looser than that eventual model.';

-- =====================================================================
-- Case tables: broad internal SELECT; INSERT/UPDATE = coordinator/manager/admin
-- =====================================================================
-- DECISION: DESIGN.md §7 names "coordinators+managers+admin for case tables"
-- as the write group and lists a handful of table categories by name
-- (§5 "Core case model", "Work/vendor/cost", "Evidence/comms/docs"). The spec
-- is silent on exactly which platform tables (domain_events, consumed_events,
-- integration_identities) and read-model caches (property_refs, person_refs)
-- fall under which write group, so the simplest option is taken: everything
-- that is not audit_events, evidence_files, payment_requests, config_versions,
-- or config_entries is a "case table" under the same coordinator/manager/admin
-- write policy. property_refs/person_refs are read-model caches normally kept
-- current by a sync job running as one of these roles, not end-user edits;
-- nothing here prevents a stricter, sync-only policy being substituted later.
--
-- A DO block with a table-name array is used instead of 26 copy-pasted
-- CREATE POLICY statements so every case table gets byte-identical rules;
-- the policy names it generates follow "<table>_<verb>_<group>" throughout
-- this file, so they read the same whether created here or spelled out below.

do $$
declare
  case_tables text[] := array[
    'property_refs', 'person_refs',
    'issues', 'issue_people', 'issue_cycles', 'phase_instances', 'tasks',
    'holds', 'possession_records', 'personal_property_items',
    'issue_relationships', 'stale_acknowledgments', 'deadlines',
    'vendors', 'bids', 'vendor_jobs', 'change_orders', 'cost_entries',
    'approvals',
    'communication_events', 'communication_links', 'notices',
    'checklist_items',
    'integration_identities', 'domain_events', 'consumed_events'
  ];
  t text;
begin
  foreach t in array case_tables loop
    execute format('alter table %I enable row level security;', t);

    execute format(
      'create policy %I on %I for select using (issues_current_actor() is not null);',
      t || '_select_broad_internal', t
    );
    execute format(
      'comment on policy %I on %I is %L;',
      t || '_select_broad_internal', t,
      'Broad internal view (DESIGN.md §7, spec §12): any authenticated actor may read this table.'
    );

    execute format(
      'create policy %I on %I for insert with check (issues_current_roles() && array[''coordinator'',''manager'',''admin'']);',
      t || '_insert_case_roles', t
    );
    execute format(
      'comment on policy %I on %I is %L;',
      t || '_insert_case_roles', t,
      'Write path for this case table (DESIGN.md §7): coordinator, manager, or admin role required to insert.'
    );

    execute format(
      'create policy %I on %I for update using (issues_current_roles() && array[''coordinator'',''manager'',''admin'']) with check (issues_current_roles() && array[''coordinator'',''manager'',''admin'']);',
      t || '_update_case_roles', t
    );
    execute format(
      'comment on policy %I on %I is %L;',
      t || '_update_case_roles', t,
      'Write path for this case table (DESIGN.md §7): coordinator, manager, or admin role required to update.'
    );
  end loop;
end;
$$;

-- =====================================================================
-- payment_requests: broad internal SELECT; state changes = accounting/admin
-- =====================================================================
-- Spec §29.7: Accounting owns the payment-request state machine
-- (Draft..Voided); Property Operations records the request but does not
-- itself post payment-state changes.

alter table payment_requests enable row level security;

create policy payment_requests_select_broad_internal
  on payment_requests
  for select
  using (issues_current_actor() is not null);

comment on policy payment_requests_select_broad_internal on payment_requests is
  'Broad internal view (spec §12): any authenticated actor may read payment requests.';

create policy payment_requests_insert_accounting_roles
  on payment_requests
  for insert
  with check (issues_current_roles() && array['accounting', 'admin']);

comment on policy payment_requests_insert_accounting_roles on payment_requests is
  'Payment request state changes are Accounting''s module (spec §29.7): only accounting or admin roles may create a payment request.';

create policy payment_requests_update_accounting_roles
  on payment_requests
  for update
  using (issues_current_roles() && array['accounting', 'admin'])
  with check (issues_current_roles() && array['accounting', 'admin']);

comment on policy payment_requests_update_accounting_roles on payment_requests is
  'Payment request state changes (Draft..Voided, spec §29.7) are restricted to accounting or admin roles.';

-- =====================================================================
-- config_versions / config_entries: broad internal SELECT; admin-only writes
-- =====================================================================
-- Spec §12: configuration is data, but only admins may version dropdown
-- values, deadlines, thresholds, notification rules, and role rights.

alter table config_versions enable row level security;

create policy config_versions_select_broad_internal
  on config_versions
  for select
  using (issues_current_actor() is not null);

comment on policy config_versions_select_broad_internal on config_versions is
  'Broad internal view (spec §12): any authenticated actor may read configuration bundles.';

create policy config_versions_insert_admin_only
  on config_versions
  for insert
  with check (issues_current_roles() && array['admin']);

comment on policy config_versions_insert_admin_only on config_versions is
  'Configuration is data (spec §12) but only admins may create new configuration bundle versions.';

create policy config_versions_update_admin_only
  on config_versions
  for update
  using (issues_current_roles() && array['admin'])
  with check (issues_current_roles() && array['admin']);

comment on policy config_versions_update_admin_only on config_versions is
  'Configuration is data (spec §12) but only admins may update configuration bundle versions.';

alter table config_entries enable row level security;

create policy config_entries_select_broad_internal
  on config_entries
  for select
  using (issues_current_actor() is not null);

comment on policy config_entries_select_broad_internal on config_entries is
  'Broad internal view (spec §12): any authenticated actor may read configuration entries.';

create policy config_entries_insert_admin_only
  on config_entries
  for insert
  with check (issues_current_roles() && array['admin']);

comment on policy config_entries_insert_admin_only on config_entries is
  'Configuration is data (spec §12) but only admins may create configuration entries.';

create policy config_entries_update_admin_only
  on config_entries
  for update
  using (issues_current_roles() && array['admin'])
  with check (issues_current_roles() && array['admin']);

comment on policy config_entries_update_admin_only on config_entries is
  'Configuration is data (spec §12) but only admins may update configuration entries (historical rows keep retired labels rather than being deleted).';

-- =====================================================================
-- evidence_files: classification-aware SELECT; case-role writes; FORCE RLS
-- =====================================================================
-- Spec §29.2: evidence carries an access_classification. Restricted-legal
-- and restricted-financial evidence is excluded from the otherwise-broad
-- internal view unless the actor holds 'manager' or 'admin'.

alter table evidence_files enable row level security;
alter table evidence_files force row level security;

create policy evidence_files_select_classification_aware
  on evidence_files
  for select
  using (
    issues_current_actor() is not null
    and (
      access_classification not in ('restricted_legal', 'restricted_financial')
      or issues_current_roles() && array['manager', 'admin']
    )
  );

comment on policy evidence_files_select_classification_aware on evidence_files is
  'Broad internal view (spec §12) EXCEPT rows with access_classification restricted_legal/restricted_financial, which require role manager or admin (spec §29.2).';

create policy evidence_files_insert_case_roles
  on evidence_files
  for insert
  with check (issues_current_roles() && array['coordinator', 'manager', 'admin']);

comment on policy evidence_files_insert_case_roles on evidence_files is
  'Write path for this case table (DESIGN.md §7): coordinator, manager, or admin role required to insert evidence.';

create policy evidence_files_update_case_roles
  on evidence_files
  for update
  using (issues_current_roles() && array['coordinator', 'manager', 'admin'])
  with check (issues_current_roles() && array['coordinator', 'manager', 'admin']);

comment on policy evidence_files_update_case_roles on evidence_files is
  'Write path for this case table (DESIGN.md §7): coordinator, manager, or admin role required to update evidence metadata (originals are immutable in practice — new versions are new rows, spec §29.2).';

-- =====================================================================
-- audit_events: broad internal SELECT; INSERT-only; no UPDATE/DELETE policy; FORCE RLS
-- =====================================================================
-- Spec §29.2 / §12: every command writes its own audit row (any authenticated
-- actor may insert), but ordinary users can never alter or delete an audit
-- event. This migration deliberately defines NO update/delete policy at all —
-- with RLS enabled (and forced), the absence of a permissive policy denies
-- those operations outright, on top of (not instead of) the previous
-- migration's audit_events_block_mutation trigger. Two independent layers.

alter table audit_events enable row level security;
alter table audit_events force row level security;

create policy audit_events_select_broad_internal
  on audit_events
  for select
  using (issues_current_actor() is not null);

comment on policy audit_events_select_broad_internal on audit_events is
  'Broad internal view (spec §12): any authenticated actor may read the audit trail.';

create policy audit_events_insert_any_authenticated
  on audit_events
  for insert
  with check (issues_current_actor() is not null);

comment on policy audit_events_insert_any_authenticated on audit_events is
  'Every command writes its own audit_events row in the same transaction (spec §29.2): any authenticated actor may insert. No UPDATE/DELETE policy exists on this table by design — combined with FORCE ROW LEVEL SECURITY and the append-only trigger (audit_events_block_mutation, previous migration), audit rows cannot be altered or removed through this connection role.';
