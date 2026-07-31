# Property Operations Entity-Relationship Diagrams

Entity-relationship diagrams for the Issues (Property Operations) application schema, split into two diagrams for legibility:
1. **Core Case Model** — reference tables, cases, work phases, tasks, holds, and possession
2. **Work/Evidence/Platform** — vendors, costs, evidence, communications, configuration, and platform infrastructure

All diagrams show table names and primary relationships. FK constraints include ON DELETE behavior (RESTRICT by default except where SET NULL is noted).

---

## Core Case Model

This diagram covers the canonical issue lifecycle, including reference data, case structure, phases, tasks, holds, and possession/personal-property tracking.

```mermaid
erDiagram
  PROPERTY_REFS ||--o{ ISSUES : "id → property_ref_id"
  PROPERTY_REFS ||--o{ HOLDS : "id → property_ref_id"
  PROPERTY_REFS ||--o{ POSSESSION_RECORDS : "id → property_ref_id"
  PROPERTY_REFS ||--o{ PERSONAL_PROPERTY_ITEMS : "id → property_ref_id"
  PROPERTY_REFS ||--o{ DEADLINES : "id → property_ref_id"
  PROPERTY_REFS ||--o{ TASKS : "id → property_ref_id"

  PERSON_REFS ||--o{ ISSUE_PEOPLE : "id → person_ref_id"
  PERSON_REFS ||--o{ PERSONAL_PROPERTY_ITEMS : "id → claimant_person_ref_id (SET NULL)"
  PERSON_REFS ||--o{ POSSESSION_RECORDS : "id → observer_person_ref_id (SET NULL)"
  PERSON_REFS ||--o{ TASKS : "id → person_ref_id (SET NULL)"

  ISSUES ||--o{ ISSUE_PEOPLE : "id → issue_id"
  ISSUES ||--o{ ISSUE_CYCLES : "id → issue_id"
  ISSUES ||--o{ PHASE_INSTANCES : "id → issue_id"
  ISSUES ||--o{ TASKS : "id → issue_id (SET NULL)"
  ISSUES ||--o{ HOLDS : "id → issue_id (SET NULL)"
  ISSUES ||--o{ POSSESSION_RECORDS : "id → issue_id"
  ISSUES ||--o{ PERSONAL_PROPERTY_ITEMS : "id → issue_id"
  ISSUES ||--o{ ISSUE_RELATIONSHIPS : "id → from_issue_id; id → to_issue_id"
  ISSUES ||--o{ STALE_ACKNOWLEDGMENTS : "id → issue_id"
  ISSUES ||--o{ DEADLINES : "id → issue_id (SET NULL)"
  ISSUES ||o--|| PHASE_INSTANCES : "current_phase_instance_id → id"

  ISSUE_CYCLES ||--o{ PHASE_INSTANCES : "id → issue_cycle_id (SET NULL)"
  ISSUE_CYCLES ||--o{ TASKS : "id → issue_cycle_id (SET NULL)"

  PHASE_INSTANCES ||--o{ TASKS : "id → phase_instance_id (SET NULL)"
  PHASE_INSTANCES ||--o{ CHECKLIST_ITEMS : "id → phase_instance_id"

  TASKS ||--o{ STALE_ACKNOWLEDGMENTS : "id → new_next_task_id (SET NULL)"
  TASKS ||--o{ DEADLINES : "id → task_id (SET NULL)"

  POSSESSION_RECORDS ||--o{ PERSONAL_PROPERTY_ITEMS : "id → possession_record_id (SET NULL)"

  PROPERTY_REFS {
    uuid id PK
    text source_system
    text external_id
    text development
    text tract
    text state
    text county
    text map_link
    numeric latitude
    numeric longitude
  }

  PERSON_REFS {
    uuid id PK
    text source_system
    text external_id
    text display_name
    text kind
    jsonb contact_snapshot
    uuid person_id
  }

  ISSUE_PEOPLE {
    uuid id PK
    uuid issue_id FK
    uuid person_ref_id FK
    text role
    date start_date
    date end_date
  }

  ISSUES {
    uuid id PK
    text issue_type
    uuid property_ref_id FK
    text summary
    text priority
    text coordinator_id
    text queue
    text lifecycle_status
    uuid current_phase_instance_id FK
    text wake_event
    date review_date
  }

  ISSUE_CYCLES {
    uuid id PK
    uuid issue_id FK
    integer cycle_number
    timestamptz opened_at
    timestamptz closed_at
    text reason
    text outcome
  }

  PHASE_INSTANCES {
    uuid id PK
    uuid issue_id FK
    uuid issue_cycle_id FK
    text phase_key
    text owner_id
    text queue
    text status
    timestamptz started_at
    timestamptz ended_at
  }

  TASKS {
    uuid id PK
    uuid issue_id FK
    uuid issue_cycle_id FK
    uuid phase_instance_id FK
    uuid property_ref_id FK
    uuid person_ref_id FK
    text assignee_id
    text queue
    text title
    text status
    text priority
    date due_date
    date action_date
  }

  HOLDS {
    uuid id PK
    uuid property_ref_id FK
    uuid issue_id FK
    text hold_type
    text reason
    timestamptz effective_start
    timestamptz effective_end
    timestamptz released_at
    text released_by
  }

  POSSESSION_RECORDS {
    uuid id PK
    uuid issue_id FK
    uuid property_ref_id FK
    text possession_status
    timestamptz observed_at
    text observer_id
  }

  PERSONAL_PROPERTY_ITEMS {
    uuid id PK
    uuid issue_id FK
    uuid property_ref_id FK
    uuid possession_record_id FK
    uuid claimant_person_ref_id FK
    text item_type
    text description
    text custody_status
    text disposition
  }

  ISSUE_RELATIONSHIPS {
    uuid id PK
    uuid from_issue_id FK
    uuid to_issue_id FK
    text relationship_type
    text reason
  }

  STALE_ACKNOWLEDGMENTS {
    uuid id PK
    uuid issue_id FK
    timestamptz flagged_at
    timestamptz acknowledged_at
    text acknowledged_by
    text status_explanation
    uuid new_next_task_id FK
  }

  DEADLINES {
    uuid id PK
    uuid issue_id FK
    uuid task_id FK
    uuid property_ref_id FK
    text deadline_type
    timestamptz due_at
    text source
    text verification_status
  }

  CHECKLIST_ITEMS {
    uuid id PK
    uuid phase_instance_id FK
    text checklist_version
    text item_key
    text label
    text status
  }
```

---

## Work / Evidence / Platform

This diagram covers vendor management, bidding, cost tracking, evidence capture, communications, configuration, and platform infrastructure.

```mermaid
erDiagram
  PERSON_REFS ||--o{ VENDORS : "id → person_ref_id"
  PERSON_REFS ||--o{ BIDS : "id → decided_by (SET NULL)"
  PERSON_REFS ||--o{ VENDOR_JOBS : "id → verified_by (SET NULL)"
  PERSON_REFS ||--o{ CHANGE_ORDERS : "id → requested_by (SET NULL); id → approved_by (SET NULL)"
  PERSON_REFS ||--o{ COST_ENTRIES : "id → recorded_by"
  PERSON_REFS ||--o{ PAYMENT_REQUESTS : "id → requested_by (SET NULL); id → approved_by (SET NULL)"
  PERSON_REFS ||--o{ APPROVALS : "id → requester_id; id → approver_id (SET NULL)"
  PERSON_REFS ||--o{ EVIDENCE_FILES : "id → uploader_person_ref_id (SET NULL)"
  PERSON_REFS ||--o{ COMMUNICATION_EVENTS : "id → from_person_ref_id; id → to_person_ref_id (SET NULL)"
  PERSON_REFS ||--o{ COMMUNICATION_LINKS : "id → person_ref_id (SET NULL)"
  PERSON_REFS ||--o{ NOTICES : "id → recipient_person_ref_id"
  PERSON_REFS ||--o{ CHECKLIST_ITEMS : "id → waived_by (SET NULL); id → verified_by (SET NULL)"
  PERSON_REFS ||--o{ AUDIT_EVENTS : "id → actor_id (SET NULL)"
  PERSON_REFS ||--o{ DOMAIN_EVENTS : "id → person_ref_id (SET NULL)"

  PROPERTY_REFS ||--o{ EVIDENCE_FILES : "id → property_ref_id (SET NULL)"
  PROPERTY_REFS ||--o{ DOMAIN_EVENTS : "id → property_ref_id (SET NULL)"

  ISSUES ||--o{ BIDS : "id → issue_id"
  ISSUES ||--o{ VENDOR_JOBS : "id → issue_id"
  ISSUES ||--o{ COST_ENTRIES : "id → issue_id"
  ISSUES ||--o{ PAYMENT_REQUESTS : "id → issue_id"
  ISSUES ||--o{ EVIDENCE_FILES : "id → issue_id (SET NULL)"
  ISSUES ||--o{ COMMUNICATION_LINKS : "id → issue_id (SET NULL)"
  ISSUES ||--o{ NOTICES : "id → issue_id"
  ISSUES ||--o{ AUDIT_EVENTS : "id → object_id (for issues)"
  ISSUES ||--o{ DOMAIN_EVENTS : "id → issue_id (SET NULL)"

  TASKS ||--o{ EVIDENCE_FILES : "id → task_id (SET NULL)"
  TASKS ||--o{ COMMUNICATION_LINKS : "id → task_id (SET NULL)"

  PHASE_INSTANCES ||--o{ CHECKLIST_ITEMS : "id → phase_instance_id"

  VENDORS ||--o{ BIDS : "id → vendor_id"
  VENDORS ||--o{ VENDOR_JOBS : "id → vendor_id"
  VENDORS ||--o{ PAYMENT_REQUESTS : "id → vendor_id"
  VENDORS ||--o{ EVIDENCE_FILES : "id → agreement_evidence_file_id (SET NULL)"

  BIDS ||--o{ VENDOR_JOBS : "id → bid_id"
  BIDS ||--o{ EVIDENCE_FILES : "id → cost_evidence_file_id (SET NULL)"

  VENDOR_JOBS ||--o{ CHANGE_ORDERS : "id → vendor_job_id"
  VENDOR_JOBS ||--o{ COST_ENTRIES : "id → vendor_job_id (SET NULL)"
  VENDOR_JOBS ||--o{ PAYMENT_REQUESTS : "id → vendor_job_id (SET NULL)"
  VENDOR_JOBS ||--o{ EVIDENCE_FILES : "id → verification_evidence_file_id (SET NULL)"

  CHANGE_ORDERS ||--o{ EVIDENCE_FILES : "id → evidence_file_id (SET NULL)"

  PAYMENT_REQUESTS ||o--|| PAYMENT_REQUESTS : "likely_duplicate_of → id (SET NULL)"
  PAYMENT_REQUESTS ||--o{ EVIDENCE_FILES : "id → source_document_evidence_file_id (SET NULL)"

  EVIDENCE_FILES ||o--|| EVIDENCE_FILES : "original_version_id → id"

  COMMUNICATION_EVENTS ||--o{ COMMUNICATION_LINKS : "id → communication_event_id"
  COMMUNICATION_EVENTS ||--o{ EVIDENCE_FILES : "id → evidence_file_id (SET NULL)"

  CONFIG_VERSIONS ||--o{ CONFIG_ENTRIES : "id → config_version_id"

  VENDORS {
    uuid id PK
    uuid person_ref_id FK
    text display_name
    text[] states
    text service_areas
    integer service_radius_miles
    text[] capabilities
    text w9_status
    text agreement_status
    boolean do_not_dispatch
  }

  BIDS {
    uuid id PK
    uuid issue_id FK
    uuid vendor_id FK
    text scope
    bigint amount_cents
    text status
    date estimated_start_date
    date estimated_completion_date
    timestamptz decided_at
  }

  VENDOR_JOBS {
    uuid id PK
    uuid issue_id FK
    uuid bid_id FK
    uuid vendor_id FK
    text contract_reference
    text status
    date scheduled_start_date
    date scheduled_completion_date
    date actual_start_date
    date actual_completion_date
    bigint final_cost_cents
    timestamptz verified_at
  }

  CHANGE_ORDERS {
    uuid id PK
    uuid vendor_job_id FK
    integer version
    text description
    bigint amount_delta_cents
    text status
    timestamptz approved_at
  }

  COST_ENTRIES {
    uuid id PK
    uuid issue_id FK
    uuid vendor_job_id FK
    text classification
    bigint amount_cents
    uuid recorded_by FK
    date effective_date
  }

  PAYMENT_REQUESTS {
    uuid id PK
    uuid issue_id FK
    uuid vendor_job_id FK
    uuid vendor_id FK
    text invoice_number
    bigint amount_cents
    text status
    uuid likely_duplicate_of FK
    timestamptz paid_at
  }

  APPROVALS {
    uuid id PK
    text requested_action
    text object_table
    uuid object_id
    uuid requester_id FK
    uuid approver_id FK
    text decision
    timestamptz decided_at
  }

  EVIDENCE_FILES {
    uuid id PK
    uuid original_version_id FK
    text storage_ref
    text original_filename
    text file_type
    bigint size_bytes
    text checksum
    text access_classification
    uuid uploader_person_ref_id FK
    uuid issue_id FK
    uuid property_ref_id FK
    uuid person_ref_id FK
    uuid task_id FK
    timestamptz archived_at
  }

  COMMUNICATION_EVENTS {
    uuid id PK
    text channel
    text direction
    text provider_system
    text provider_event_id
    timestamptz occurred_at
    uuid from_person_ref_id FK
    uuid to_person_ref_id FK
    text summary
  }

  COMMUNICATION_LINKS {
    uuid id PK
    uuid communication_event_id FK
    uuid issue_id FK
    uuid task_id FK
    uuid person_ref_id FK
  }

  NOTICES {
    uuid id PK
    uuid issue_id FK
    text template_version
    uuid recipient_person_ref_id FK
    text delivery_method
    date cure_deadline
    text status
    timestamptz sent_at
  }

  CHECKLIST_ITEMS {
    uuid id PK
    uuid phase_instance_id FK
    text checklist_version
    text item_key
    text label
    text status
    uuid evidence_file_id FK
    uuid waived_by FK
    uuid verified_by FK
    timestamptz verified_at
  }

  CONFIG_VERSIONS {
    uuid id PK
    text config_key
    text version_label
    timestamptz effective_from
    timestamptz effective_to
    text description
  }

  CONFIG_ENTRIES {
    uuid id PK
    uuid config_version_id FK
    text entry_key
    jsonb entry_value
    boolean retired
  }

  INTEGRATION_IDENTITIES {
    uuid id PK
    text object_table
    uuid object_id
    text source_system
    text external_object_type
    text external_id
    text direction
    text sync_status
    timestamptz last_attempt_at
  }

  DOMAIN_EVENTS {
    uuid id PK
    text event_type
    integer schema_version
    text source_module
    jsonb payload
    uuid person_ref_id FK
    uuid property_ref_id FK
    uuid issue_id FK
    timestamptz occurred_at
    uuid correlation_id
    text idempotency_key
  }

  CONSUMED_EVENTS {
    uuid id PK
    text source_system
    text idempotency_key
    timestamptz processed_at
    text result
  }

  AUDIT_EVENTS {
    uuid id PK
    uuid actor_id FK
    text actor_role
    text action
    text object_table
    uuid object_id
    jsonb before
    jsonb after
    text reason
    uuid correlation_id
    timestamptz occurred_at
  }
```

---

## Key Design Notes

### Circular Dependencies

- **issues.current_phase_instance_id ↔ phase_instances.issue_id**: Resolved via ALTER TABLE after phase_instances is created (migration 1 creates issues, then phase_instances, then adds the FK).

### Foreign Key Semantics

- **ON DELETE RESTRICT** (default): Audited/canonical records (issues, tasks, holds, evidence_files, etc.) cannot be deleted while referenced. No cascades.
- **ON DELETE SET NULL**: Soft links and optional references (e.g., issue_cycle_id on tasks, completed_evidence_id on tasks). Deletion of the referenced record nulls the FK but preserves the referring row.

### Deferred Foreign Keys

Evidence-file foreign keys from vendors, bids, vendor_jobs, change_orders, and payment_requests are added via ALTER TABLE in migration 2 (after evidence_files is created).

### No Foreign Keys

- **property_refs, person_refs**: Read-model caches only; external system identifiers via (source_system, external_id) instead.
- **integration_identities**: Tracks internal object ↔ external system mapping; object_id is not a true FK (table is external).
- **consumed_events**: Dedup ledger keyed on (source_system, idempotency_key); no FK to domain_events.
- **config_versions**: Top-level configuration; version'd by config_key + version_label.

### Indices

Key indices on hot paths (e.g., holds.active_by_property for "does this property have any active hold" eligibility checks) are defined in migrations but not shown in the diagram for clarity.
