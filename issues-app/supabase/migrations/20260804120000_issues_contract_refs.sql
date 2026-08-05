-- 20260804120000_issues_contract_refs.sql
-- Wave 2b: contract_refs — read-model cache of the canonical Sales/
-- Transactions Contract record, mirroring the property_refs/person_refs
-- alias pattern EXACTLY (see 20260731090000_issues_core.sql's property_refs
-- table, which this table's shape, indexing, trigger, RLS enable+FORCE, and
-- broad-internal-read policy all copy). New migration; does not edit any
-- landed file.
--
-- NOT canonical (Master Vision §30.2, spec §30.2): the Hub's Sales/
-- Transactions module + Contract workflow own the real Contract record,
-- its state machine, signature/execution facts, and every downstream money
-- consequence. Property Operations never claims to be system of record for
-- a contract — this table exists only so the case left panel (spec §9.1,
-- roadmap "Case left-panel contract/transaction overview + CRM links") can
-- display a read-through snapshot without a second writer, exactly the
-- role property_refs/person_refs already play for Property/Person.
--
-- Sync-fed: last_synced_at is stamped by whatever sync job/import keeps
-- this cache current (no sync job ships in this lane — see
-- scripts/demo-seed.ts's append-only demo section for the only writer that
-- exists today, fictional demo data). No Property Operations command
-- creates or mutates a contract_refs row as a side effect of case work.

create table contract_refs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  source_system text not null,
  external_id text not null,

  contract_number text,
  status_cached text,

  property_ref_id uuid not null references property_refs (id) on delete restrict,
  buyer_person_ref_id uuid references person_refs (id) on delete set null,

  executed_date date,
  -- Free-form named milestone dates (e.g. {"closing": "2026-09-01",
  -- "inspection_deadline": "2026-08-20"}) — Contract workflow's own state
  -- machine and field set are out of scope here; this is a display-only
  -- snapshot, not a second copy of that workflow's schema.
  key_dates jsonb not null default '{}'::jsonb,

  last_synced_at timestamptz,

  constraint contract_refs_source_external_unique unique (source_system, external_id)
);

create index contract_refs_property_ref_id_idx on contract_refs (property_ref_id);
create index contract_refs_buyer_person_ref_id_idx on contract_refs (buyer_person_ref_id);
create index contract_refs_last_synced_at_idx on contract_refs (last_synced_at);

create trigger contract_refs_set_updated_at
  before update on contract_refs
  for each row execute function set_updated_at();

comment on table contract_refs is
  'Read-model cache of the canonical Contract record. NOT canonical (Master Vision §30.2, spec §30.2): the Hub''s Sales/Transactions module + Contract workflow own the real contract facts (state machine, execution, money consequences). This table is a sync-fed snapshot Property Operations reads to render the case left-panel contract/transaction overview (roadmap Wave 2b) — no command in lib/services writes to it as a side effect of case work.';

-- =====================================================================
-- RLS: same shape as property_refs/person_refs (20260731090200_issues_rls.sql,
-- 20260731090500_issues_rls_audit_hardening.sql) — enable + FORCE + broad
-- internal SELECT. Deliberately NO insert/update policy is added here: this
-- table is read-only from the app's perspective (a sync job, not this
-- application role, is the intended writer — see the app-role grant note
-- below), so unlike the case-table policy loop in 20260731090200 there is
-- no coordinator/manager/admin write policy to mirror.
-- =====================================================================

alter table contract_refs enable row level security;
alter table contract_refs force row level security;

create policy contract_refs_select_broad_internal
  on contract_refs
  for select
  using (issues_current_actor() is not null);

comment on policy contract_refs_select_broad_internal on contract_refs is
  'Broad internal view (DESIGN.md §7, spec §12), same policy shape as property_refs_select_broad_internal/person_refs_select_broad_internal: any authenticated actor may read this table.';

-- =====================================================================
-- issues_app grant: read-only. property_refs/person_refs pick up
-- select+insert+update automatically via 20260731090700_issues_app_role_grants.sql's
-- `alter default privileges ... grant select, insert, update on tables`
-- (it applies to every table the owner role creates from that point on,
-- including this one) — but this table has no write policy above for
-- insert/update to govern, and no Property Operations code path is meant
-- to write it, so the blanket default-privilege grant is narrowed back to
-- SELECT only here, explicitly, rather than left to silently carry write
-- privileges nothing exercises.
-- =====================================================================

revoke insert, update on contract_refs from issues_app;
grant select on contract_refs to issues_app;
