-- Issues (Property Operations) — Work/Vendor/Cost + Evidence/Comms + Platform tables
-- Design: DESIGN.md §5 ("Work/vendor/cost", "Evidence/comms/docs", "Platform")
-- Requirements: property-operations-requirements.md §6.3, §20, §22, §29.2, §29.7,
--               §29.8, §30.3, §31.3
--
-- Runs AFTER 20260731090000_issues_core.sql. Reuses that migration's
-- set_updated_at() trigger function and FKs into its issues / tasks /
-- person_refs / property_refs / phase_instances tables. Does NOT recreate the
-- trigger function and does NOT create any extension (gen_random_uuid() is
-- built into Postgres 13+).

-- =====================================================================
-- WORK / VENDOR / COST
-- =====================================================================

-- vendors: one-writer = Property Operations (vendor onboarding/dispatch).
create table vendors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  person_ref_id uuid not null references person_refs (id) on delete restrict,
  display_name text not null,
  states text[] not null default '{}',
  service_areas text not null default '',
  service_radius_miles integer,
  capabilities text[] not null default '{}',
  w9_status text not null default 'not_collected'
    check (w9_status in ('not_collected', 'requested', 'received', 'verified', 'expired')),
  agreement_status text not null default 'none'
    check (agreement_status in ('none', 'sent', 'signed', 'expired')),
  agreement_evidence_file_id uuid,
  insurance_status text not null default 'not_collected'
    check (insurance_status in ('not_collected', 'requested', 'received', 'verified', 'expired')),
  insurance_expires_on date,
  w9_expires_on date,
  do_not_dispatch boolean not null default false,
  do_not_dispatch_reason text,
  notes text
);

comment on table vendors is
  'Property Operations: vendor profile / eligibility to dispatch. One writer: Property Operations vendor management.';

create index vendors_person_ref_id_idx on vendors (person_ref_id);
create index vendors_do_not_dispatch_idx on vendors (do_not_dispatch);

create trigger vendors_set_updated_at
  before update on vendors
  for each row execute function set_updated_at();

-- bids
create table bids (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  vendor_id uuid not null references vendors (id) on delete restrict,
  scope text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  estimated_start_date date,
  estimated_completion_date date,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'complete', 'accepted', 'rejected', 'withdrawn', 'expired')),
  cost_evidence_file_id uuid,
  time_evidence_present boolean not null default false,
  walkthrough_evidence_present boolean not null default false,
  decision_reason text,
  decided_by uuid references person_refs (id) on delete restrict,
  decided_at timestamptz
);

comment on table bids is
  'Property Operations: vendor bids on issue-scoped work. One writer: Property Operations vendor/bid workflow.';

create index bids_issue_id_idx on bids (issue_id);
create index bids_vendor_id_idx on bids (vendor_id);
create index bids_status_idx on bids (status);

create trigger bids_set_updated_at
  before update on bids
  for each row execute function set_updated_at();

-- vendor_jobs
create table vendor_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  bid_id uuid not null references bids (id) on delete restrict,
  vendor_id uuid not null references vendors (id) on delete restrict,
  contract_reference text,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'in_progress', 'completed', 'verified', 'cancelled', 'disputed')),
  scheduled_start_date date,
  scheduled_completion_date date,
  actual_start_date date,
  actual_completion_date date,
  final_cost_cents bigint check (final_cost_cents >= 0),
  verified_by uuid references person_refs (id) on delete restrict,
  verified_at timestamptz,
  verification_evidence_file_id uuid
);

comment on table vendor_jobs is
  'Property Operations: approved/contracted vendor work on an issue. One writer: Property Operations vendor job workflow.';

create index vendor_jobs_issue_id_idx on vendor_jobs (issue_id);
create index vendor_jobs_bid_id_idx on vendor_jobs (bid_id);
create index vendor_jobs_vendor_id_idx on vendor_jobs (vendor_id);
create index vendor_jobs_status_idx on vendor_jobs (status);

create trigger vendor_jobs_set_updated_at
  before update on vendor_jobs
  for each row execute function set_updated_at();

-- change_orders: versioned changes against a vendor_job
create table change_orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  vendor_job_id uuid not null references vendor_jobs (id) on delete restrict,
  version integer not null,
  description text not null,
  amount_delta_cents bigint not null default 0,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'superseded')),
  requested_by uuid references person_refs (id) on delete restrict,
  approved_by uuid references person_refs (id) on delete restrict,
  approved_at timestamptz,
  evidence_file_id uuid,

  unique (vendor_job_id, version)
);

comment on table change_orders is
  'Property Operations: versioned change orders against a vendor job. One writer: Property Operations vendor job workflow.';

create index change_orders_vendor_job_id_idx on change_orders (vendor_job_id);
create index change_orders_status_idx on change_orders (status);

create trigger change_orders_set_updated_at
  before update on change_orders
  for each row execute function set_updated_at();

-- cost_entries
create table cost_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  vendor_job_id uuid references vendor_jobs (id) on delete restrict,
  classification text not null
    check (classification in (
      'estimated', 'bid', 'committed', 'approved', 'invoiced', 'paid',
      'additional_outside_contract', 'disputed', 'recoverable',
      'customer_chargeable', 'waived', 'written_off'
    )),
  amount_cents bigint not null check (amount_cents >= 0),
  recorded_by uuid not null references person_refs (id) on delete restrict,
  reason text,
  effective_date date not null default current_date
);

comment on table cost_entries is
  'Property Operations: classified cost line items for an issue. One writer: Property Operations cost tracking (never posts customer charges directly — see §29.7/§29.8).';

create index cost_entries_issue_id_idx on cost_entries (issue_id);
create index cost_entries_vendor_job_id_idx on cost_entries (vendor_job_id);
create index cost_entries_classification_idx on cost_entries (classification);

create trigger cost_entries_set_updated_at
  before update on cost_entries
  for each row execute function set_updated_at();

-- payment_requests
create table payment_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  vendor_job_id uuid references vendor_jobs (id) on delete restrict,
  vendor_id uuid not null references vendors (id) on delete restrict,
  invoice_number text,
  amount_cents bigint not null check (amount_cents >= 0),
  source_document_evidence_file_id uuid,
  status text not null default 'draft'
    check (status in (
      'draft', 'submitted', 'needs_information', 'approved', 'scheduled',
      'paid', 'partially_paid', 'denied', 'cancelled', 'voided'
    )),
  requested_by uuid references person_refs (id) on delete restrict,
  approved_by uuid references person_refs (id) on delete restrict,
  paid_at timestamptz,
  denial_reason text,
  likely_duplicate_of uuid references payment_requests (id) on delete set null
);

comment on table payment_requests is
  'Property Operations: payment request lifecycle (Draft..Voided, §29.7). Accounting owns the paid-state decision/issuance; this table records the request and Property Operations-visible status only.';

create index payment_requests_issue_id_idx on payment_requests (issue_id);
create index payment_requests_vendor_job_id_idx on payment_requests (vendor_job_id);
create index payment_requests_vendor_id_idx on payment_requests (vendor_id);
create index payment_requests_status_idx on payment_requests (status);

-- Duplicate guard (§29.7): same vendor + invoice number must not have more
-- than one payment request outside the denied/cancelled/voided terminal
-- "not really happening" states.
create unique index payment_requests_vendor_invoice_dup_guard_idx
  on payment_requests (vendor_id, invoice_number)
  where invoice_number is not null
    and status not in ('denied', 'cancelled', 'voided');

create trigger payment_requests_set_updated_at
  before update on payment_requests
  for each row execute function set_updated_at();

-- approvals
create table approvals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  requested_action text not null,
  threshold_rule text,
  object_table text not null,
  object_id uuid not null,
  requester_id uuid not null references person_refs (id) on delete restrict,
  approver_id uuid references person_refs (id) on delete restrict,
  decision text not null default 'pending'
    check (decision in ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_at timestamptz,
  decision_reason text
);

comment on table approvals is
  'Property Operations: approval requests/decisions gating threshold-controlled commands (e.g. second bid >= config threshold). One writer: Property Operations approval workflow.';

create index approvals_requester_id_idx on approvals (requester_id);
create index approvals_approver_id_idx on approvals (approver_id);
create index approvals_decision_idx on approvals (decision);
create index approvals_object_table_object_id_idx on approvals (object_table, object_id);

create trigger approvals_set_updated_at
  before update on approvals
  for each row execute function set_updated_at();

-- =====================================================================
-- EVIDENCE / COMMS / DOCS
-- =====================================================================

-- evidence_files: immutable originals; derivatives point back via
-- original_version_id. No hard delete — archived_at tombstone instead.
create table evidence_files (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  original_version_id uuid references evidence_files (id) on delete restrict,
  storage_ref text not null,
  original_filename text,
  file_type text,
  size_bytes bigint check (size_bytes >= 0),
  checksum text,
  captured_at timestamptz,
  uploaded_at timestamptz not null default now(),
  uploader_person_ref_id uuid references person_refs (id) on delete restrict,
  source_system text,
  device_or_location_metadata jsonb not null default '{}'::jsonb,
  provider_id text,
  access_classification text not null default 'internal'
    check (access_classification in ('internal', 'restricted_legal', 'restricted_financial')),
  issue_id uuid references issues (id) on delete restrict,
  property_ref_id uuid references property_refs (id) on delete restrict,
  person_ref_id uuid references person_refs (id) on delete restrict,
  task_id uuid references tasks (id) on delete restrict,
  archived_at timestamptz,
  archived_reason text
);

comment on table evidence_files is
  'Property Operations: immutable evidence originals and their linked derivatives (crop/annotate/redact/replace create a new row, §29.2). One writer: Property Operations evidence capture. Never hard-deleted — archived_at tombstone only.';

create index evidence_files_original_version_id_idx on evidence_files (original_version_id);
create index evidence_files_uploader_person_ref_id_idx on evidence_files (uploader_person_ref_id);
create index evidence_files_issue_id_idx on evidence_files (issue_id);
create index evidence_files_property_ref_id_idx on evidence_files (property_ref_id);
create index evidence_files_person_ref_id_idx on evidence_files (person_ref_id);
create index evidence_files_task_id_idx on evidence_files (task_id);
create index evidence_files_access_classification_idx on evidence_files (access_classification);
create index evidence_files_archived_at_idx on evidence_files (archived_at);

create trigger evidence_files_set_updated_at
  before update on evidence_files
  for each row execute function set_updated_at();

-- Deferred FKs from vendors/bids/vendor_jobs/change_orders/payment_requests
-- into evidence_files (evidence_files is defined after those tables above).
alter table vendors
  add constraint vendors_agreement_evidence_file_id_fkey
  foreign key (agreement_evidence_file_id) references evidence_files (id) on delete restrict;

alter table bids
  add constraint bids_cost_evidence_file_id_fkey
  foreign key (cost_evidence_file_id) references evidence_files (id) on delete restrict;

alter table vendor_jobs
  add constraint vendor_jobs_verification_evidence_file_id_fkey
  foreign key (verification_evidence_file_id) references evidence_files (id) on delete restrict;

alter table change_orders
  add constraint change_orders_evidence_file_id_fkey
  foreign key (evidence_file_id) references evidence_files (id) on delete restrict;

alter table payment_requests
  add constraint payment_requests_source_document_evidence_file_id_fkey
  foreign key (source_document_evidence_file_id) references evidence_files (id) on delete restrict;

create index vendors_agreement_evidence_file_id_idx on vendors (agreement_evidence_file_id);
create index bids_cost_evidence_file_id_idx on bids (cost_evidence_file_id);
create index vendor_jobs_verification_evidence_file_id_idx on vendor_jobs (verification_evidence_file_id);
create index change_orders_evidence_file_id_idx on change_orders (evidence_file_id);
create index payment_requests_source_document_evidence_file_id_idx on payment_requests (source_document_evidence_file_id);

-- communication_events: normalized call/text/email/voicemail/notice record.
-- Never duplicated content — linked via communication_links (§28.6).
create table communication_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  channel text not null
    check (channel in ('call', 'text', 'email', 'voicemail', 'notice', 'other')),
  direction text not null
    check (direction in ('inbound', 'outbound')),
  provider_system text,
  provider_event_id text,
  occurred_at timestamptz not null,
  from_person_ref_id uuid references person_refs (id) on delete restrict,
  to_person_ref_id uuid references person_refs (id) on delete restrict,
  summary text,
  evidence_file_id uuid references evidence_files (id) on delete restrict
);

comment on table communication_events is
  'Property Operations (via JustCall/PandaDoc integration seam): normalized communication record, no copies of source content (§28.6). One writer: Property Operations communications intake.';

create index communication_events_from_person_ref_id_idx on communication_events (from_person_ref_id);
create index communication_events_to_person_ref_id_idx on communication_events (to_person_ref_id);
create index communication_events_occurred_at_idx on communication_events (occurred_at);
create index communication_events_evidence_file_id_idx on communication_events (evidence_file_id);
create unique index communication_events_provider_dedup_idx
  on communication_events (provider_system, provider_event_id)
  where provider_system is not null and provider_event_id is not null;

create trigger communication_events_set_updated_at
  before update on communication_events
  for each row execute function set_updated_at();

-- communication_links: many-to-many link of a communication_event to the
-- people/issues/tasks it relates to (no content copies).
create table communication_links (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  communication_event_id uuid not null references communication_events (id) on delete restrict,
  issue_id uuid references issues (id) on delete restrict,
  task_id uuid references tasks (id) on delete restrict,
  person_ref_id uuid references person_refs (id) on delete restrict,

  check (
    issue_id is not null or task_id is not null or person_ref_id is not null
  )
);

comment on table communication_links is
  'Property Operations: links a communication_event to the people/issues/tasks it concerns, without copying content. One writer: Property Operations communications intake.';

create index communication_links_communication_event_id_idx on communication_links (communication_event_id);
create index communication_links_issue_id_idx on communication_links (issue_id);
create index communication_links_task_id_idx on communication_links (task_id);
create index communication_links_person_ref_id_idx on communication_links (person_ref_id);

create trigger communication_links_set_updated_at
  before update on communication_links
  for each row execute function set_updated_at();

-- notices
create table notices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  issue_id uuid not null references issues (id) on delete restrict,
  template_version text not null,
  recipient_person_ref_id uuid not null references person_refs (id) on delete restrict,
  address_used text,
  delivery_method text
    check (delivery_method is null or delivery_method in ('mail', 'email', 'hand_delivery', 'posting', 'other')),
  delivery_evidence_file_id uuid references evidence_files (id) on delete restrict,
  sent_at timestamptz,
  cure_deadline date,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'delivered', 'failed', 'cured', 'expired'))
);

comment on table notices is
  'Property Operations: legal/covenant notices with delivery evidence and cure deadline stored verbatim (§6.4, §28.6). One writer: Property Operations notice workflow.';

create index notices_issue_id_idx on notices (issue_id);
create index notices_recipient_person_ref_id_idx on notices (recipient_person_ref_id);
create index notices_delivery_evidence_file_id_idx on notices (delivery_evidence_file_id);
create index notices_status_idx on notices (status);
create index notices_cure_deadline_idx on notices (cure_deadline);

create trigger notices_set_updated_at
  before update on notices
  for each row execute function set_updated_at();

-- checklist_items: versioned phase checklists with status (§31.3)
create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  phase_instance_id uuid not null references phase_instances (id) on delete restrict,
  checklist_version text not null,
  item_key text not null,
  label text not null,
  status text not null default 'required_missing'
    check (status in (
      'required_missing', 'present', 'verified', 'waived', 'not_applicable', 'superseded'
    )),
  evidence_file_id uuid references evidence_files (id) on delete restrict,
  waived_by uuid references person_refs (id) on delete restrict,
  waived_reason text,
  verified_by uuid references person_refs (id) on delete restrict,
  verified_at timestamptz,

  unique (phase_instance_id, checklist_version, item_key)
);

comment on table checklist_items is
  'Property Operations: versioned phase checklist item status (§31.3). One writer: Property Operations phase/checklist workflow.';

create index checklist_items_phase_instance_id_idx on checklist_items (phase_instance_id);
create index checklist_items_status_idx on checklist_items (status);
create index checklist_items_evidence_file_id_idx on checklist_items (evidence_file_id);

create trigger checklist_items_set_updated_at
  before update on checklist_items
  for each row execute function set_updated_at();

-- =====================================================================
-- PLATFORM
-- =====================================================================

-- config_versions: effective-dated configuration bundles (§12).
create table config_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  config_key text not null,
  version_label text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  description text,

  unique (config_key, version_label)
);

comment on table config_versions is
  'Property Operations: effective-dated configuration bundle headers (dropdowns, deadlines, thresholds, role rights, templates, notification rules). One writer: Property Operations admin configuration (§12).';

create index config_versions_config_key_idx on config_versions (config_key);
create index config_versions_effective_from_idx on config_versions (effective_from);
create index config_versions_effective_to_idx on config_versions (effective_to);

create trigger config_versions_set_updated_at
  before update on config_versions
  for each row execute function set_updated_at();

-- config_entries: individual key/value entries within a config_version.
create table config_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  config_version_id uuid not null references config_versions (id) on delete restrict,
  entry_key text not null,
  entry_value jsonb not null,
  retired boolean not null default false,

  unique (config_version_id, entry_key)
);

comment on table config_entries is
  'Property Operations: individual configuration entries within a config_versions bundle; historical records keep retired labels (§12). One writer: Property Operations admin configuration.';

create index config_entries_config_version_id_idx on config_entries (config_version_id);
create index config_entries_entry_key_idx on config_entries (entry_key);

create trigger config_entries_set_updated_at
  before update on config_entries
  for each row execute function set_updated_at();

-- integration_identities: internal object <-> external system id + sync state.
create table integration_identities (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  object_table text not null,
  object_id uuid not null,
  source_system text not null,
  external_object_type text,
  external_id text not null,
  direction text not null default 'inbound'
    check (direction in ('inbound', 'outbound', 'bidirectional')),
  idempotency_key text,
  sync_status text not null default 'pending'
    check (sync_status in ('pending', 'synced', 'error', 'stale')),
  last_attempt_at timestamptz,
  last_error text,

  unique (source_system, external_object_type, external_id)
);

comment on table integration_identities is
  'Property Operations: internal object to external-system identity mapping + sync state (integration seam for PandaDoc/JustCall/Airtable, §22). One writer: Property Operations integration adapters.';

create index integration_identities_object_table_object_id_idx on integration_identities (object_table, object_id);
create index integration_identities_source_system_idx on integration_identities (source_system);
create index integration_identities_sync_status_idx on integration_identities (sync_status);

create trigger integration_identities_set_updated_at
  before update on integration_identities
  for each row execute function set_updated_at();

-- domain_events: outbox-style log written in-transaction with the owning
-- module's authoritative fact (§30.3). Never mutated after write in normal
-- operation; no protective trigger requested by spec here (append-heavy but
-- not declared strictly append-only like audit_events), so a standard
-- updated_at trigger is retained for corrective/administrative use only.
create table domain_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  event_type text not null,
  schema_version integer not null default 1,
  source_module text not null default 'property_operations',
  payload jsonb not null default '{}'::jsonb,
  person_ref_id uuid references person_refs (id) on delete set null,
  property_ref_id uuid references property_refs (id) on delete set null,
  issue_id uuid references issues (id) on delete set null,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  actor text,
  correlation_id uuid,
  idempotency_key text not null,

  unique (idempotency_key)
);

comment on table domain_events is
  'Property Operations: outbox-style domain event log written in the same transaction as the authoritative fact (§30.3); transport/bus is governed centrally. One writer: Property Operations command layer (lib/services/events.ts).';

create index domain_events_event_type_idx on domain_events (event_type);
create index domain_events_person_ref_id_idx on domain_events (person_ref_id);
create index domain_events_property_ref_id_idx on domain_events (property_ref_id);
create index domain_events_issue_id_idx on domain_events (issue_id);
create index domain_events_occurred_at_idx on domain_events (occurred_at);
create index domain_events_correlation_id_idx on domain_events (correlation_id);

create trigger domain_events_set_updated_at
  before update on domain_events
  for each row execute function set_updated_at();

-- consumed_events: idempotent subscriber dedup ledger.
create table consumed_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  source_system text not null,
  idempotency_key text not null,
  processed_at timestamptz not null default now(),
  result text not null default 'processed'
    check (result in ('processed', 'skipped_duplicate', 'error')),
  error_detail text,

  unique (source_system, idempotency_key)
);

comment on table consumed_events is
  'Property Operations: idempotent-consumption ledger for events consumed from the domain_events bus / external systems. One writer: Property Operations event subscribers.';

create index consumed_events_source_system_idx on consumed_events (source_system);
create index consumed_events_processed_at_idx on consumed_events (processed_at);

create trigger consumed_events_set_updated_at
  before update on consumed_events
  for each row execute function set_updated_at();

-- audit_events: append-only. No updated_at trigger; instead a trigger that
-- rejects UPDATE/DELETE outright (§29.2, §12 — "ordinary users cannot alter
-- or delete audit events").
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  actor_id uuid references person_refs (id) on delete set null,
  actor_role text,
  action text not null,
  object_table text not null,
  object_id uuid not null,
  before jsonb,
  after jsonb,
  reason text,
  correlation_id uuid,
  source text,
  occurred_at timestamptz not null default now()
);

comment on table audit_events is
  'Property Operations: append-only audit trail written by every command in the same transaction (§29.2). One writer: Property Operations audit.ts. UPDATE/DELETE are rejected by trigger — no updated_at column, no ordinary correction path.';

create index audit_events_actor_id_idx on audit_events (actor_id);
create index audit_events_object_table_object_id_idx on audit_events (object_table, object_id);
create index audit_events_occurred_at_idx on audit_events (occurred_at);
create index audit_events_correlation_id_idx on audit_events (correlation_id);

create function audit_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only: % is not permitted', tg_op;
end;
$$;

create trigger audit_events_block_update
  before update on audit_events
  for each row execute function audit_events_block_mutation();

create trigger audit_events_block_delete
  before delete on audit_events
  for each row execute function audit_events_block_mutation();
