-- 20260731090000_issues_core.sql
-- Property Operations ("Issues") — core case model (DESIGN.md §5, "Core case model"
-- plus the reference/read-model tables it depends on).
--
-- This is the FIRST migration for this package. It defines the shared
-- set_updated_at() trigger function used by every table in every later
-- migration, plus:
--   property_refs, person_refs, issue_people, issues, issue_cycles,
--   phase_instances, tasks, holds, possession_records,
--   personal_property_items, issue_relationships, stale_acknowledgments,
--   deadlines
--
-- Conventions (Hub dev guide + this package's build rules):
--   - Plain CREATE TABLE (no IF NOT EXISTS) — migrations run exactly once,
--     in timestamp order, against a fresh database.
--   - Every table: id uuid primary key default gen_random_uuid(),
--     created_at/updated_at timestamptz not null default now().
--   - gen_random_uuid() is built into Postgres 13+; no extension is created.
--   - No Postgres enums. Choice lists use text + CHECK so they stay
--     admin-editable via config later (spec §12) without a schema migration
--     to add a value. Where a config_versions/config_entries table exists
--     (a later migration, per DESIGN.md §5 "Platform") a column is left as
--     a plain uuid with no FK yet; that FK is added when config lands.
--   - Foreign keys carry explicit ON DELETE behavior — RESTRICT by default
--     (nothing here hard-deletes audited case records), SET NULL for
--     optional/soft links.
--   - Every table gets a `set_updated_at` trigger.
--   - One-writer-per-fact (Master Vision §30.2): Property Operations owns
--     Issue, Issue Cycle, Phase Instance, operational Task, possession,
--     personal-property custody/disposition, operational hold, and
--     stale-case acknowledgment facts. property_refs/person_refs are
--     READ-MODEL caches of the canonical Property/Person records owned by
--     Inventory/Tables and the shared identity service respectively —
--     Property Operations never claims to be their system of record.

-- ---------------------------------------------------------------------
-- Shared trigger function (defined once here, reused by every migration)
-- ---------------------------------------------------------------------

create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'Shared BEFORE UPDATE trigger function: stamps updated_at = now() on every row update. Defined once in this first migration and reused (CREATE TRIGGER ... EXECUTE FUNCTION set_updated_at()) by every subsequent migration''s tables.';

-- ---------------------------------------------------------------------
-- property_refs — read-model cache of the canonical Inventory Property
-- ---------------------------------------------------------------------
-- NOT canonical (Master Vision §30.2, §30.5): Inventory/Tables owns the
-- real Property record, status, and pricing history. This table exists so
-- Property Operations can join/filter/display without a second writer.

create table property_refs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  source_system text not null,
  external_id text not null,

  development text,
  tract text,
  state text,
  county text,
  map_link text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),

  -- Cached display-only fields; never authoritative. Inventory/Tables owns
  -- the real status/pricing facts; this is a read-through cache refreshed
  -- by sync, not written by any Property Operations command.
  display_name text,
  status_cached text,
  last_synced_at timestamptz,

  constraint property_refs_source_external_unique unique (source_system, external_id)
);

create index property_refs_state_idx on property_refs (state);
create index property_refs_county_idx on property_refs (county);
create index property_refs_last_synced_at_idx on property_refs (last_synced_at);

create trigger property_refs_set_updated_at
  before update on property_refs
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- person_refs — read-model cache of the canonical Person/Organization
-- ---------------------------------------------------------------------
-- NOT canonical (Master Vision §30.2): the shared identity service owns
-- the real Person record and merge/survivorship. `person_id` is filled in
-- once that identity link is established; until then this is a
-- Property-Operations-local snapshot (owner, reporter, neighbor, vendor...).

create table person_refs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  source_system text not null,
  external_id text,

  display_name text not null,
  kind text not null,
  contact_snapshot jsonb not null default '{}'::jsonb,

  -- Canonical Person identity, filled in once the shared identity service
  -- link is established. No FK yet: the canonical Person table is owned
  -- and migrated by the shared identity service, not this package.
  person_id uuid,

  aliases jsonb not null default '{}'::jsonb,

  constraint person_refs_kind_check check (kind in ('person', 'org'))
);

-- Partial unique index: external_id is not always known (e.g. a neighbor
-- reporter entered by hand has no external system record).
create unique index person_refs_source_external_unique_idx
  on person_refs (source_system, external_id)
  where external_id is not null;

create index person_refs_person_id_idx on person_refs (person_id);
create index person_refs_display_name_idx on person_refs (display_name);

create trigger person_refs_set_updated_at
  before update on person_refs
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- issues — the long-lived Property Operations case (DESIGN.md §5, spec §4/§20/§21)
-- ---------------------------------------------------------------------

create table issues (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_type text not null,
  property_ref_id uuid not null references property_refs (id) on delete restrict,

  summary text not null,

  -- Priority/urgency (spec §5.2: "Priority, urgency, and whether the
  -- property must be Off Market or has a legal/safety hold").
  priority text not null default 'normal',

  -- Business/Relisting Priority (spec §31.8) — deliberately separate from
  -- `priority` above and never allowed to affect legal deadlines, holds,
  -- or release requirements. Full input-snapshot/formula-version history
  -- is a later platform concern; this migration stores the current score
  -- and its computed snapshot only. DECISION: kept minimal since §31.8's
  -- full versioned-formula history isn't in DESIGN.md's core-case-model
  -- table list for this migration.
  business_priority_score numeric,
  business_priority_label text,
  business_priority_inputs jsonb,
  business_priority_computed_at timestamptz,
  business_priority_override_reason text,

  -- Staff identity is external (Hub shared identity, §30.1) — there is no
  -- local users/staff table to foreign-key against, so coordinator/queue
  -- are plain identifiers, consistent with lib/auth/current-user.ts's
  -- CurrentUser.id being an opaque string, not a local uuid.
  coordinator_id text,
  queue text,

  lifecycle_status text not null default 'intake',

  -- FK added by ALTER TABLE below, once phase_instances exists (circular
  -- dependency: phase_instances.issue_id -> issues.id).
  current_phase_instance_id uuid,

  -- Passive-wait states require a wake-up event or review date instead of
  -- a due-date-bearing task (spec §21).
  wake_event text,
  review_date date,

  -- Config version the case is running under (spec §12: historical cases
  -- keep the version used). No FK yet: config_versions is a later,
  -- platform-layer migration; this column is the seam.
  config_version_id uuid,

  constraint issues_issue_type_check check (
    issue_type in (
      'default_recovery', 'covenant_violation', 'market_readiness',
      'property_legal', 'buyer_cleanup'
    )
  ),
  constraint issues_priority_check check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  constraint issues_lifecycle_status_check check (
    lifecycle_status in (
      'intake', 'active', 'waiting', 'blocked', 'on_hold', 'passive_wait', 'closed'
    )
  ),
  -- Spec §21 / DESIGN.md §3.3: an Issue cannot be Active without a
  -- coordinator or queue. (Next-task/due-date is enforced at the service
  -- layer against the tasks table — a single-table CHECK can't reach
  -- across tables.)
  constraint issues_active_requires_owner_check check (
    lifecycle_status <> 'active' or coordinator_id is not null or queue is not null
  ),
  -- Spec §21: passive-wait states require a wake-up event or review date.
  constraint issues_passive_wait_requires_wake_check check (
    lifecycle_status <> 'passive_wait' or wake_event is not null or review_date is not null
  )
);

create index issues_property_ref_id_idx on issues (property_ref_id);
create index issues_lifecycle_status_idx on issues (lifecycle_status);
create index issues_coordinator_id_idx on issues (coordinator_id);
create index issues_priority_idx on issues (priority);
create index issues_current_phase_instance_id_idx on issues (current_phase_instance_id);
create index issues_review_date_idx on issues (review_date);

create trigger issues_set_updated_at
  before update on issues
  for each row execute function set_updated_at();

comment on table issues is
  'Property Operations owns writes: the canonical Property Operations case (Master Vision §30.2). property_ref_id/coordinator/queue are references into other systems'' identities, not writes to them.';

-- ---------------------------------------------------------------------
-- issue_people — time-bounded role link between an issue and a person_ref
-- ---------------------------------------------------------------------

create table issue_people (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  person_ref_id uuid not null references person_refs (id) on delete restrict,

  role text not null,
  start_date date not null default current_date,
  end_date date,
  notes text,

  constraint issue_people_role_check check (
    role in (
      'owner', 'buyer', 'former_owner', 'neighbor', 'reporter', 'vendor',
      'attorney', 'other'
    )
  )
);

create index issue_people_issue_id_idx on issue_people (issue_id);
create index issue_people_person_ref_id_idx on issue_people (person_ref_id);
create index issue_people_role_idx on issue_people (role);

create trigger issue_people_set_updated_at
  before update on issue_people
  for each row execute function set_updated_at();

comment on table issue_people is
  'Property Operations owns writes: time-bounded role links (owner/buyer/neighbor/reporter/vendor/attorney/other) between an Issue and a person_ref (spec §5.2, §20).';

-- ---------------------------------------------------------------------
-- issue_cycles — reopened reporting cycles within an issue (spec §7, §20, §21)
-- ---------------------------------------------------------------------

create table issue_cycles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,

  cycle_number integer not null default 1,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  reason text,
  outcome text,

  constraint issue_cycles_issue_cycle_number_unique unique (issue_id, cycle_number)
);

create index issue_cycles_issue_id_idx on issue_cycles (issue_id);
create index issue_cycles_closed_at_idx on issue_cycles (closed_at);

create trigger issue_cycles_set_updated_at
  before update on issue_cycles
  for each row execute function set_updated_at();

comment on table issue_cycles is
  'Property Operations owns writes: reportable occurrences within a reopened Issue, each with its own opened/closed dates, reason, and outcome, while the parent case history is preserved (spec §7, §21).';

-- ---------------------------------------------------------------------
-- phase_instances — one execution of a configured workflow phase (spec §20)
-- ---------------------------------------------------------------------

create table phase_instances (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  issue_cycle_id uuid references issue_cycles (id) on delete set null,

  -- Config-driven phase key (e.g. 'map_review', 'ccl_cleanup',
  -- 'attorney_referral'); admin-editable, so text not enum (spec §12).
  phase_key text not null,

  owner_id text,
  queue text,
  status text not null default 'open',

  started_at timestamptz,
  ended_at timestamptz,

  entry_reason text,
  exit_outcome text,
  handoff_summary text,
  handoff_next_task text,
  handoff_due_date date,

  constraint phase_instances_status_check check (
    status in ('open', 'in_progress', 'blocked', 'completed', 'skipped', 'cancelled')
  )
);

create index phase_instances_issue_id_idx on phase_instances (issue_id);
create index phase_instances_issue_cycle_id_idx on phase_instances (issue_cycle_id);
create index phase_instances_status_idx on phase_instances (status);
create index phase_instances_owner_id_idx on phase_instances (owner_id);
create index phase_instances_handoff_due_date_idx on phase_instances (handoff_due_date);

create trigger phase_instances_set_updated_at
  before update on phase_instances
  for each row execute function set_updated_at();

comment on table phase_instances is
  'Property Operations owns writes: one execution of a configured workflow phase — owner, start/end, status, entry reason, exit outcome, and handoff (spec §20, §21).';

-- Now that phase_instances exists, wire up issues.current_phase_instance_id.
alter table issues
  add constraint issues_current_phase_instance_id_fkey
  foreign key (current_phase_instance_id) references phase_instances (id) on delete set null;

-- ---------------------------------------------------------------------
-- tasks — actionable work (spec §7, §20, §21)
-- ---------------------------------------------------------------------

create table tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid references issues (id) on delete restrict,
  issue_cycle_id uuid references issue_cycles (id) on delete set null,
  phase_instance_id uuid references phase_instances (id) on delete set null,
  property_ref_id uuid references property_refs (id) on delete set null,
  person_ref_id uuid references person_refs (id) on delete set null,

  -- Staff identity is external (see issues.coordinator_id above); no FK.
  assignee_id text,
  queue text,

  title text not null,
  description text,

  status text not null default 'open',
  priority text not null default 'normal',

  due_date date,
  -- Date a customer/vendor says they'll act/update; creates a reminder (§7).
  action_date date,
  -- Expected deadline for the work (§7); distinct from a legal `deadlines` row.
  target_completion_date date,
  -- Date CCL confirms resolution; never inferred from a promise (§7).
  verified_completion_date date,

  source_rule text,

  -- Seam: evidence_files is a later migration (DESIGN.md §5 "Evidence/comms/docs").
  -- No FK yet; this uuid is the forward link once that table lands.
  completion_evidence_id uuid,

  waiting_reason text,
  waiting_party text,

  constraint tasks_status_check check (
    status in ('open', 'in_progress', 'completed', 'cancelled')
  ),
  constraint tasks_priority_check check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  -- assignee_id or queue must be set for any task that is still open work.
  constraint tasks_open_requires_owner_check check (
    status not in ('open', 'in_progress') or assignee_id is not null or queue is not null
  )
);

create index tasks_issue_id_idx on tasks (issue_id);
create index tasks_issue_cycle_id_idx on tasks (issue_cycle_id);
create index tasks_phase_instance_id_idx on tasks (phase_instance_id);
create index tasks_property_ref_id_idx on tasks (property_ref_id);
create index tasks_person_ref_id_idx on tasks (person_ref_id);
create index tasks_status_idx on tasks (status);
create index tasks_due_date_idx on tasks (due_date);
create index tasks_action_date_idx on tasks (action_date);
create index tasks_assignee_id_idx on tasks (assignee_id);
create index tasks_queue_idx on tasks (queue);

create trigger tasks_set_updated_at
  before update on tasks
  for each row execute function set_updated_at();

comment on table tasks is
  'Property Operations owns writes: actionable work items with assignee-or-queue, due date, status, priority, and links to issue/cycle/phase/property/person (spec §7, §20, §21).';

-- ---------------------------------------------------------------------
-- holds — restriction/hold records (spec §20, §21, §28.3, §29.10)
-- ---------------------------------------------------------------------
-- A property may have multiple simultaneous holds; release evaluation
-- checks all of them at command time (DESIGN.md hard rule #1). An active
-- hold is one where released_at is null.

create table holds (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Holds are fundamentally property-scoped (the eligibility chokepoint
  -- evaluates "does this property have any active hold"), so
  -- property_ref_id is required. issue_id is the usual originating case
  -- but is nullable since a hold (e.g. stop-work from a law-enforcement
  -- tip) can be placed before any issue is opened.
  property_ref_id uuid not null references property_refs (id) on delete restrict,
  issue_id uuid references issues (id) on delete restrict,

  hold_type text not null,
  scope text,
  reason text not null,
  source text,
  owner_id text,

  effective_start timestamptz not null default now(),
  effective_end timestamptz,

  release_criteria text,
  release_authority text,

  released_at timestamptz,
  released_by text,
  release_reason text,

  constraint holds_hold_type_check check (
    hold_type in (
      'legal', 'safety', 'occupancy', 'cleanup', 'foreclosure', 'title',
      'covenant', 'stop_work', 'existing_contract_active', 'other'
    )
  ),
  -- Release is never silent: once released_at is set, released_by and
  -- release_reason must be too (spec §21 "manual overrides ... audit event").
  constraint holds_release_documented_check check (
    released_at is null or (released_by is not null and release_reason is not null)
  )
);

create index holds_property_ref_id_idx on holds (property_ref_id);
create index holds_issue_id_idx on holds (issue_id);
create index holds_hold_type_idx on holds (hold_type);
-- Hot path: "does this property have any active hold" (released_at is null).
create index holds_active_by_property_idx on holds (property_ref_id) where released_at is null;

create trigger holds_set_updated_at
  before update on holds
  for each row execute function set_updated_at();

comment on table holds is
  'Property Operations owns writes: operational hold/restriction facts within its authority (Master Vision §30.2). A property cannot become releasable while any row here has released_at IS NULL (DESIGN.md hard rule #1, spec §21, §28.3, §29.10).';

-- ---------------------------------------------------------------------
-- possession_records — possession status, separate from cleanup status (spec §29.6)
-- ---------------------------------------------------------------------

create table possession_records (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  property_ref_id uuid not null references property_refs (id) on delete restrict,

  possession_status text not null,
  observed_at timestamptz not null default now(),
  observer_id text,
  observer_person_ref_id uuid references person_refs (id) on delete set null,

  -- Seam: evidence_files is a later migration; store forward references
  -- as a jsonb array of (future) evidence_files.id values until then.
  evidence_refs jsonb not null default '[]'::jsonb,
  notes text,

  constraint possession_records_status_check check (
    possession_status in (
      'unknown', 'occupied_or_suspected', 'vacancy_unverified',
      'vacancy_verified', 'personal_property_present',
      'removal_disposition_review', 'removal_authorized', 'stored',
      'transferred', 'disposed', 'cleared'
    )
  )
);

create index possession_records_issue_id_idx on possession_records (issue_id);
create index possession_records_property_ref_id_idx on possession_records (property_ref_id);
create index possession_records_status_idx on possession_records (possession_status);
create index possession_records_observed_at_idx on possession_records (observed_at);

create trigger possession_records_set_updated_at
  before update on possession_records
  for each row execute function set_updated_at();

comment on table possession_records is
  'Property Operations owns writes: possession status observations, kept separate from cleanup status. A property cannot be released as vacant/clean on cleanup completion alone — possession must also be resolved (spec §29.6).';

-- ---------------------------------------------------------------------
-- personal_property_items — belongings/vehicles/animals/hazards inventory (spec §29.6)
-- ---------------------------------------------------------------------

create table personal_property_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  property_ref_id uuid not null references property_refs (id) on delete restrict,
  possession_record_id uuid references possession_records (id) on delete set null,

  item_type text not null,
  description text not null,
  location text,

  claimant_person_ref_id uuid references person_refs (id) on delete set null,

  observed_at timestamptz,
  observer_id text,
  condition text,

  custody_status text not null default 'on_property',
  disposition text,
  disposition_authority text,
  disposition_documented_at timestamptz,

  evidence_refs jsonb not null default '[]'::jsonb,

  constraint personal_property_items_item_type_check check (
    item_type in (
      'belonging', 'structure', 'vehicle', 'rv_camper', 'equipment',
      'animal', 'trash_debris', 'key', 'gate_code', 'lock', 'utility',
      'hazard', 'other'
    )
  ),
  constraint personal_property_items_custody_status_check check (
    custody_status in (
      'on_property', 'removed', 'stored', 'transferred_to_claimant',
      'disposed', 'towed', 'unknown'
    )
  )
);

create index personal_property_items_issue_id_idx on personal_property_items (issue_id);
create index personal_property_items_property_ref_id_idx on personal_property_items (property_ref_id);
create index personal_property_items_possession_record_id_idx on personal_property_items (possession_record_id);
create index personal_property_items_item_type_idx on personal_property_items (item_type);
create index personal_property_items_custody_status_idx on personal_property_items (custody_status);

create trigger personal_property_items_set_updated_at
  before update on personal_property_items
  for each row execute function set_updated_at();

comment on table personal_property_items is
  'Property Operations owns writes: inventory of belongings/structures/vehicles/animals/hazards with custody and disposition chain (spec §29.6).';

-- ---------------------------------------------------------------------
-- issue_relationships — typed links between issues (spec §29.9)
-- ---------------------------------------------------------------------
-- Linking never merges timelines; each linked issue keeps its own owner,
-- permissions, stage, tasks, holds, documents, costs, and outcomes.

create table issue_relationships (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  from_issue_id uuid not null references issues (id) on delete restrict,
  to_issue_id uuid not null references issues (id) on delete restrict,

  relationship_type text not null,
  reason text,
  created_by text,

  constraint issue_relationships_type_check check (
    relationship_type in (
      'parent_child', 'related', 'duplicate_of', 'caused_by',
      'converted_to', 'supersedes', 'same_incident', 'shared_legal_matter'
    )
  ),
  constraint issue_relationships_not_self_check check (from_issue_id <> to_issue_id),
  constraint issue_relationships_unique unique (from_issue_id, to_issue_id, relationship_type)
);

create index issue_relationships_from_issue_id_idx on issue_relationships (from_issue_id);
create index issue_relationships_to_issue_id_idx on issue_relationships (to_issue_id);
create index issue_relationships_type_idx on issue_relationships (relationship_type);

create trigger issue_relationships_set_updated_at
  before update on issue_relationships
  for each row execute function set_updated_at();

comment on table issue_relationships is
  'Property Operations owns writes: typed links between Issues (parent_child, related, duplicate_of, caused_by, converted_to, supersedes, same_incident, shared_legal_matter). Linking never merges timelines or auto-closes/releases another case (spec §29.9).';

-- ---------------------------------------------------------------------
-- stale_acknowledgments — §31.2 acknowledgment trail
-- ---------------------------------------------------------------------

create table stale_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,

  flagged_at timestamptz not null default now(),
  last_meaningful_event_at timestamptz,
  age_days integer,

  acknowledged_at timestamptz,
  acknowledged_by text,
  status_explanation text,
  new_next_task_id uuid references tasks (id) on delete set null,
  new_due_date date,

  escalated_at timestamptz,
  escalated_to text,

  -- The reminder cannot be silently dismissed: once acknowledged, an
  -- explanation and actor are required (spec §31.2).
  constraint stale_acknowledgments_ack_documented_check check (
    acknowledged_at is null or (acknowledged_by is not null and status_explanation is not null)
  )
);

create index stale_acknowledgments_issue_id_idx on stale_acknowledgments (issue_id);
create index stale_acknowledgments_acknowledged_at_idx on stale_acknowledgments (acknowledged_at);
create index stale_acknowledgments_flagged_at_idx on stale_acknowledgments (flagged_at);

create trigger stale_acknowledgments_set_updated_at
  before update on stale_acknowledgments
  for each row execute function set_updated_at();

comment on table stale_acknowledgments is
  'Property Operations owns writes: the stale-case acknowledgment trail — last meaningful event, age, blockers, and the required explanation/new-next-task before a stale flag can be cleared (spec §31.2).';

-- ---------------------------------------------------------------------
-- deadlines — verbatim deadlines with source + verification status (spec §31.5)
-- ---------------------------------------------------------------------
-- Stored exactly as recorded; Phase 1 never calculates a legal deadline
-- and never silently moves one for weekends/holidays/off-hours. Calendar
-- warnings are computed at read time by the service layer and are not
-- persisted here.

create table deadlines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid references issues (id) on delete restrict,
  task_id uuid references tasks (id) on delete set null,
  property_ref_id uuid references property_refs (id) on delete set null,

  deadline_type text not null,
  due_at timestamptz not null,
  due_timezone text not null default 'UTC',

  source text not null,
  source_reference text,

  verification_status text not null default 'unverified',
  notes text,

  constraint deadlines_verification_status_check check (
    verification_status in ('unverified', 'verified', 'disputed')
  ),
  constraint deadlines_linked_to_something_check check (
    issue_id is not null or task_id is not null or property_ref_id is not null
  )
);

create index deadlines_issue_id_idx on deadlines (issue_id);
create index deadlines_task_id_idx on deadlines (task_id);
create index deadlines_property_ref_id_idx on deadlines (property_ref_id);
create index deadlines_due_at_idx on deadlines (due_at);
create index deadlines_deadline_type_idx on deadlines (deadline_type);

create trigger deadlines_set_updated_at
  before update on deadlines
  for each row execute function set_updated_at();

comment on table deadlines is
  'Property Operations owns writes: user-entered or externally-supplied deadlines stored verbatim with source, timezone, and verification status. Never recalculated or silently moved for weekends/holidays/off-hours (spec §31.5, §31.12 — Phase 1 never calculates a legal deadline).';

-- ---------------------------------------------------------------------
-- Reference/read-model table comments (property_refs, person_refs, issue_people)
-- ---------------------------------------------------------------------

comment on table property_refs is
  'Read-model cache only — NOT the writer. Inventory/Tables owns the canonical Property (status, availability, price/True Discount history). Property Operations reads/joins through this table and never treats it as authoritative (Master Vision §30.2, §30.5).';

comment on table person_refs is
  'Read-model cache only — NOT the writer. The shared identity service owns the canonical Person/Organization, merge/survivorship. Property Operations links via person_id once identity is established and otherwise treats this as a local snapshot for display (Master Vision §30.2, §30.5).';
