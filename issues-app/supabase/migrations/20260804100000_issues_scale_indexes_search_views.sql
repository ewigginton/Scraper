-- 20260804100000_issues_scale_indexes_search_views.sql
-- Issues UI v2 — scale foundation (docs/notion-redesign.md "Scale work").
-- Runs AFTER 20260731090800_issues_config_v1_retire.sql. New migration;
-- does not edit any landed file.
--
-- Three pieces:
--   1. Composite indexes matched to the new /issues and My-Work-at-volume
--      query shapes (issues-query-repo.ts, tasks-repo.ts).
--   2. Full-text search: a generated tsvector column on issues.summary
--      ('simple' config, core-Postgres only — no pg_trgm dependency, works
--      on PGlite and Supabase alike) + a GIN index.
--   3. saved_views (spec §15): owner-scoped saved All-Issues view configs,
--      with RLS following the exact GUC pattern (issues_current_actor() /
--      issues_current_roles()) established in
--      20260731090200_issues_rls.sql, plus FORCE ROW LEVEL SECURITY and
--      issues_app grants consistent with 20260731090700_issues_app_role_grants.sql.

-- =====================================================================
-- 1. Composite indexes
-- =====================================================================
-- Every index below is verified against supabase/migrations/20260731090000_
-- issues_core.sql and 20260731090500_issues_rls_audit_hardening.sql before
-- being added, so nothing here duplicates an index that migration already
-- created.

-- issues: default /issues sort (lifecycle_status filter + updated_at DESC,
-- id DESC keyset tiebreaker) — issues-query-repo.ts's default sort.
create index issues_lifecycle_status_updated_at_id_idx
  on issues (lifecycle_status, updated_at desc, id desc);

-- issues: per-issue-type quick views (Default Recovery, Covenant, Market
-- Readiness, Buyer Cleanup, Legal sidebar links), each filtered by
-- lifecycle_status and sorted by recency.
create index issues_issue_type_lifecycle_status_updated_at_idx
  on issues (issue_type, lifecycle_status, updated_at desc);

-- issues: coordinator- and queue-scoped reads (My Work "View all N",
-- coordinator/queue filter bar control), filtered by lifecycle_status.
create index issues_coordinator_id_lifecycle_status_idx
  on issues (coordinator_id, lifecycle_status);

create index issues_queue_lifecycle_status_idx
  on issues (queue, lifecycle_status);

-- tasks: status+due_date scans (overdue/upcoming queue buckets in
-- tasks-repo.ts inboxForUser/countsForUser) with a stable id tiebreaker,
-- matching those queries' `ORDER BY due_date, priority, id`.
create index tasks_status_due_date_id_idx
  on tasks (status, due_date, id);

-- tasks: per-assignee status+due_date scans (the same queues, scoped to one
-- caller's assignee_id rather than a company-wide status scan).
create index tasks_assignee_id_status_due_date_idx
  on tasks (assignee_id, status, due_date);

-- holds (property_ref_id) where released_at is null: ALREADY EXISTS as
-- holds_active_by_property_idx (20260731090000_issues_core.sql, the "does
-- this property have any active hold" hot path). Verified present; not
-- duplicated here.

-- property_refs (state): ALREADY EXISTS as property_refs_state_idx
-- (20260731090000_issues_core.sql). Verified present; not duplicated here.

-- property_refs (display_name): NOT previously indexed (only
-- county/state/last_synced_at were, per the same migration). Backs the
-- All Issues sort-by-property-name column and the ILIKE-prefix
-- property-name search fold-in (issues-query-repo.ts).
create index property_refs_display_name_idx
  on property_refs (display_name);

-- =====================================================================
-- 2. Search: generated tsvector column + GIN index
-- =====================================================================
-- 'simple' config deliberately (no stemming/stopwords — locale-free,
-- core-Postgres-only, no pg_trgm dependency per spec §25). STORED so the
-- GIN index below can be built directly over the column rather than a
-- functional expression index.

alter table issues
  add column summary_tsv tsvector
  generated always as (to_tsvector('simple', summary)) stored;

comment on column issues.summary_tsv is
  'Generated (STORED) tsvector over issues.summary using the ''simple'' text search config. Queried as summary_tsv @@ plainto_tsquery(''simple'', $q) by lib/repositories/issues-query-repo.ts''s free-text search filter, OR''d with an ILIKE prefix match on the joined property_refs.display_name.';

create index issues_summary_tsv_idx on issues using gin (summary_tsv);

-- =====================================================================
-- 3. saved_views (spec §15)
-- =====================================================================

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Staff identity is external (see issues.coordinator_id, DESIGN.md §7);
  -- no local users/staff table to foreign-key against.
  owner_external_id text not null,
  name text not null,
  -- Filters/sort/columns/group-by for the /issues view this saves —
  -- validated (non-empty name <= 80 chars, params a plain object) by
  -- lib/services/saved-view-service.ts, not by a DB constraint (the shape
  -- of `params` is a UI concern that evolves without a migration).
  params jsonb not null,

  constraint saved_views_owner_external_id_name_unique unique (owner_external_id, name)
);

create index saved_views_owner_external_id_idx on saved_views (owner_external_id);

create trigger saved_views_set_updated_at
  before update on saved_views
  for each row execute function set_updated_at();

comment on table saved_views is
  'Property Operations: user-saved /issues view configurations (filters/sort/columns/group-by), scoped to their owner (spec §15). One writer: lib/services/saved-view-service.ts, audited via audit_events in the same transaction.';

-- RLS: owner-scoped ALL policy matching the issues_current_actor() /
-- issues_current_roles() GUC pattern from 20260731090200_issues_rls.sql,
-- plus admin read-all (same broad-internal-for-admin precedent as the rest
-- of this scaffold). FORCE ROW LEVEL SECURITY so even the connection's
-- owning role cannot silently bypass it, matching the treatment
-- audit_events/evidence_files got in that migration and every table got in
-- 20260731090500_issues_rls_audit_hardening.sql.

alter table saved_views enable row level security;
alter table saved_views force row level security;

create policy saved_views_owner_all
  on saved_views
  for all
  using (owner_external_id = issues_current_actor())
  with check (owner_external_id = issues_current_actor());

comment on policy saved_views_owner_all on saved_views is
  'Owner-scoped full access (spec §15): an actor may only select/insert/update/delete their own saved views. owner_external_id = issues_current_actor() is NULL (never true) when no actor context is set, denying an unauthenticated connection outright — the same behavior the broad-internal-view tables get from their explicit "issues_current_actor() is not null" clause.';

create policy saved_views_admin_select_all
  on saved_views
  for select
  using (issues_current_roles() && array['admin']);

comment on policy saved_views_admin_select_all on saved_views is
  'Admin read-all: admins may read every actor''s saved views for support/debugging (DESIGN.md §7 broad-internal-visibility precedent), on top of (not instead of) saved_views_owner_all — writes remain owner-only, this policy adds no write path.';

-- GRANTs for issues_app (consistent with 20260731090700_issues_app_role_
-- grants.sql's ALTER DEFAULT PRIVILEGES, which already covers
-- select/insert/update on any table created after it by the same owner
-- role — restated explicitly here so this migration is self-contained and
-- reviewable without cross-referencing that one). DELETE IS granted here,
-- unlike every other table in this schema (that migration's "No DELETE is
-- granted anywhere" note): saved_views rows are a personal UI convenience
-- with owner-scoped RLS and their own audit_events trail on every write,
-- not a business/audit fact this schema retires-in-place instead of
-- removing — an owner deleting their own saved view is a real, intended
-- hard delete (spec §15 "delete").
grant select, insert, update, delete on saved_views to issues_app;
