# Property Operations Data Dictionary

Comprehensive schema reference for the Issues (Property Operations) application, organized by functional area. Every table is owned and written by Property Operations unless noted. All tables include `id` (UUID PK), `created_at`, and `updated_at` (timestamptz) columns.

---

## Reference / Read-Model

These tables cache canonical data owned by other systems. Property Operations reads through these tables but never claims to be their system of record.

### property_refs

**Purpose:** Read-model cache of properties from Inventory/Tables system; used for filtering and joining without dual writes.

**Writer:** Inventory/Tables (synced, not canonical here)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| source_system | text | no | | External system identifier (e.g., "airtable") |
| external_id | text | no | | ID in the source system; unique with source_system |
| development | text | yes | | Development name/tract ID |
| tract | text | yes | | Tract or lot identifier |
| state | text | yes | | State abbreviation |
| county | text | yes | | County name |
| map_link | text | yes | | URL to map/plat document |
| latitude | numeric | yes | | Geographic latitude (9,6 precision) |
| longitude | numeric | yes | | Geographic longitude (9,6 precision) |
| display_name | text | yes | | Cached human-readable property name |
| status_cached | text | yes | | Cached property status (never authoritative) |
| last_synced_at | timestamptz | yes | | Timestamp of last sync from source system |

**Indices:** state, county, last_synced_at  
**Constraints:** Unique(source_system, external_id)

---

### person_refs

**Purpose:** Read-model cache of person/organization data from shared identity service; local snapshot until canonical person_id is linked.

**Writer:** Shared identity service (external; person_id link filled in when identity lands)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| source_system | text | no | | External system identifier |
| external_id | text | yes | | ID in the source system; may be null for hand-entered records |
| display_name | text | no | | Human-readable name for display |
| kind | text | no | | 'person' or 'org' |
| contact_snapshot | jsonb | no | {} | Cached phone/email/address snapshot. **Display contract:** only the keys in `app/_lib/reference-data.ts`'s `DISPLAYABLE_CONTACT_KEYS` allowlist (`phone`, `mobile`, `email`, `address`, `preferred_contact`) are ever rendered (hover cards, person page, /people index) — this column carries no `access_classification` and RLS cannot restrict individual jsonb keys, so a future sync change adding a new field here does NOT automatically become displayable; extend the allowlist deliberately. |
| person_id | uuid | yes | | Link to canonical Person record (filled by identity service) |
| aliases | jsonb | no | {} | Alternative names and identifiers |

**Indices:** person_id, display_name; partial unique on (source_system, external_id) where external_id is not null  
**Constraints:** Check(kind in ('person', 'org'))

---

### issue_people

**Purpose:** Time-bounded role link between an Issue and a person_ref (e.g., owner, buyer, reporter, vendor).

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| person_ref_id | uuid | no | | Foreign key to person_refs |
| role | text | no | | Role in the issue (owner, buyer, former_owner, neighbor, reporter, vendor, attorney, other) |
| start_date | date | no | current_date | Date role began |
| end_date | date | yes | | Date role ended; null if ongoing |
| notes | text | yes | | Additional context about the relationship |

**Indices:** issue_id, person_ref_id, role  
**Constraints:** Check(role in (...))

---

## Core Case Model

The canonical Property Operations case, its lifecycle, phases, and work items.

### issues

**Purpose:** The long-lived Property Operations case (default recovery, covenant violation, market readiness, property legal, buyer cleanup).

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_type | text | no | | Type of case (default_recovery, covenant_violation, market_readiness, property_legal, buyer_cleanup) |
| property_ref_id | uuid | no | | Foreign key to property_refs |
| summary | text | no | | Brief case summary |
| priority | text | no | 'normal' | Priority level (low, normal, high, urgent) |
| business_priority_score | numeric | yes | | Computed relisting/business priority score (numeric) |
| business_priority_label | text | yes | | Label for business priority (separate from urgency per §31.8) |
| business_priority_inputs | jsonb | yes | | Raw inputs used to compute business priority |
| business_priority_computed_at | timestamptz | yes | | When business priority was last computed |
| business_priority_override_reason | text | yes | | Reason if business priority is manually overridden |
| coordinator_id | text | yes | | Staff identifier for primary coordinator (external identity, not local user) |
| queue | text | yes | | Queue assignment if no specific coordinator |
| lifecycle_status | text | no | 'intake' | Case status (intake, active, waiting, blocked, on_hold, passive_wait, closed) |
| current_phase_instance_id | uuid | yes | | Foreign key to current phase_instances row |
| wake_event | text | yes | | Event trigger for passive_wait state (spec §21) |
| review_date | date | yes | | Review date for passive_wait state (spec §21) |
| config_version_id | uuid | yes | | Foreign key to config_versions; historical cases keep their config version |
| map_link | text | yes | | Property-Operations-owned Google My Maps link (spec §5/§6, added 20260731090400). NOT `property_refs.map_link` — that column is a sync-owned read-through cache with one writer (the Inventory/Tables sync job); Property Operations never writes it. |
| price_reviewed_at | timestamptz | yes | | Property-Operations-owned timestamp of the last development-price review (spec §10, added 20260731090400). Compared against `thresholds.price_review_window_months` by the `price_review_complete` prerequisite/blocker. |

**Indices:** property_ref_id, lifecycle_status, coordinator_id, priority, current_phase_instance_id, review_date  
**Constraints:**
- Check(issue_type in (...))
- Check(priority in (...))
- Check(lifecycle_status in (...))
- Check(lifecycle_status <> 'active' OR coordinator_id is not null OR queue is not null)
- Check(lifecycle_status <> 'passive_wait' OR wake_event is not null OR review_date is not null)

---

### issue_cycles

**Purpose:** Reopened reporting cycles within an Issue; tracks separate opened/closed periods with reason and outcome.

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| cycle_number | integer | no | 1 | Sequence number of this cycle |
| opened_at | timestamptz | no | now() | When this cycle opened |
| closed_at | timestamptz | yes | | When this cycle closed; null if still open |
| reason | text | yes | | Reason for opening/reopening |
| outcome | text | yes | | Outcome when cycle closed |

**Indices:** issue_id, closed_at  
**Constraints:** Unique(issue_id, cycle_number)

---

### phase_instances

**Purpose:** One execution of a configured workflow phase within an issue (e.g., "Legal VS Analysis", "Cleanup", "Buyer Cleanup").

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| issue_cycle_id | uuid | yes | | Foreign key to issue_cycles (null if in primary cycle) |
| phase_key | text | no | | Config-driven phase identifier (e.g., 'legal_vs', 'cleanup', 'relisting') |
| owner_id | text | yes | | Staff coordinator for this phase |
| queue | text | yes | | Queue assignment if no specific owner |
| status | text | no | 'open' | Phase status (open, in_progress, blocked, completed, skipped, cancelled) |
| started_at | timestamptz | yes | | When this phase started |
| ended_at | timestamptz | yes | | When this phase ended |
| entry_reason | text | yes | | Reason for entering this phase |
| exit_outcome | text | yes | | Reason/outcome for exiting this phase |
| handoff_summary | text | yes | | Summary for handoff to next phase |
| handoff_next_task | text | yes | | Next immediate task for next phase |
| handoff_due_date | date | yes | | Due date for next phase's first task |

**Indices:** issue_id, issue_cycle_id, status, owner_id, handoff_due_date  
**Constraints:** Check(status in (...))

---

### tasks

**Purpose:** Actionable work items with assignee/queue, status, priority, and flexible due-date semantics.

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | yes | | Foreign key to issues; may be null for standalone tasks |
| issue_cycle_id | uuid | yes | | Foreign key to issue_cycles; clarifies cycle for multi-cycle issues |
| phase_instance_id | uuid | yes | | Foreign key to phase_instances |
| property_ref_id | uuid | yes | | Foreign key to property_refs |
| person_ref_id | uuid | yes | | Foreign key to person_refs |
| assignee_id | text | yes | | Staff identifier for assignee (external identity) |
| queue | text | yes | | Queue assignment if no specific assignee |
| title | text | no | | Task description |
| description | text | yes | | Longer task narrative |
| status | text | no | 'open' | Task status (open, in_progress, completed, cancelled) |
| priority | text | no | 'normal' | Task priority (low, normal, high, urgent) |
| due_date | date | yes | | When the task is due |
| action_date | date | yes | | When a customer/vendor promised to act; creates a reminder |
| target_completion_date | date | yes | | Expected deadline for work completion; distinct from legal deadlines |
| verified_completion_date | date | yes | | When CCL confirmed resolution; never inferred |
| source_rule | text | yes | | Name of the config rule that auto-generated this task |
| completion_evidence_id | uuid | yes | | Foreign key to evidence_files; seam for completion proof |
| waiting_reason | text | yes | | Why task is in waiting state |
| waiting_party | text | yes | | Who is being waited for |

**Indices:** issue_id, issue_cycle_id, phase_instance_id, property_ref_id, person_ref_id, status, due_date, action_date, assignee_id, queue  
**Constraints:**
- Check(status in (...))
- Check(priority in (...))
- Check(status not in ('open', 'in_progress') OR assignee_id is not null OR queue is not null)

---

### holds

**Purpose:** Restriction/hold records that block release or contract renewal; multiple simultaneous holds per property are allowed.

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| property_ref_id | uuid | no | | Foreign key to property_refs (required for eligibility checking) |
| issue_id | uuid | yes | | Foreign key to issues; nullable because holds can be placed before an issue exists |
| hold_type | text | no | | Type of hold (legal, safety, occupancy, cleanup, foreclosure, title, covenant, stop_work, existing_contract_active, other) |
| scope | text | yes | | Scope of the hold (e.g., 'entire_property', 'structures_only') |
| reason | text | no | | Why the hold was placed |
| source | text | yes | | Source/origin of the hold (e.g., 'manual', 'event_driven', 'system') |
| owner_id | text | yes | | Staff identifier for hold owner |
| effective_start | timestamptz | no | now() | When hold became effective |
| effective_end | timestamptz | yes | | When hold naturally expires (if set; overridden by released_at) |
| release_criteria | text | yes | | Conditions that must be met to release |
| release_authority | text | yes | | Who has authority to release |
| released_at | timestamptz | yes | | When hold was released; null if still active |
| released_by | text | yes | | Staff identifier who released hold |
| release_reason | text | yes | | Why hold was released |

**Indices:** property_ref_id, issue_id, hold_type, active_by_property (partial index: property_ref_id where released_at is null)  
**Constraints:**
- Check(hold_type in (...))
- Check(released_at is null OR (released_by is not null AND release_reason is not null))

---

### possession_records

**Purpose:** Possession/occupancy status observations, kept separate from cleanup status (spec §29.6).

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| property_ref_id | uuid | no | | Foreign key to property_refs |
| possession_status | text | no | | Status (unknown, occupied_or_suspected, vacancy_unverified, vacancy_verified, personal_property_present, removal_disposition_review, removal_authorized, stored, transferred, disposed, cleared) |
| observed_at | timestamptz | no | now() | When status was observed |
| observer_id | text | yes | | Staff identifier for observer |
| observer_person_ref_id | uuid | yes | | Foreign key to person_refs if observer is external |
| evidence_refs | jsonb | no | [] | Array of evidence_files.id values (seam until evidence_files FK lands) |
| notes | text | yes | | Observations about possession status |

**Indices:** issue_id, property_ref_id, possession_status, observed_at  
**Constraints:** Check(possession_status in (...))

---

### personal_property_items

**Purpose:** Inventory of belongings/vehicles/animals/hazards with custody and disposition history.

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| property_ref_id | uuid | no | | Foreign key to property_refs |
| possession_record_id | uuid | yes | | Foreign key to possession_records |
| item_type | text | no | | Classification (belonging, structure, vehicle, rv_camper, equipment, animal, trash_debris, key, gate_code, lock, utility, hazard, other) |
| description | text | no | | Human-readable description of the item |
| location | text | yes | | Where on property the item is located |
| claimant_person_ref_id | uuid | yes | | Foreign key to person_refs if an external party claims it |
| observed_at | timestamptz | yes | | When the item was observed |
| observer_id | text | yes | | Staff identifier for observer |
| condition | text | yes | | Condition assessment (e.g., "intact", "damaged", "missing") |
| custody_status | text | no | 'on_property' | Current custody state (on_property, removed, stored, transferred_to_claimant, disposed, towed, unknown) |
| disposition | text | yes | | Final disposition decision |
| disposition_authority | text | yes | | Authority under which disposition was made |
| disposition_documented_at | timestamptz | yes | | When disposition was documented |
| evidence_refs | jsonb | no | [] | Array of evidence_files.id values for photos/documentation |

**Indices:** issue_id, property_ref_id, possession_record_id, item_type, custody_status  
**Constraints:**
- Check(item_type in (...))
- Check(custody_status in (...))

---

### issue_relationships

**Purpose:** Typed links between Issues (parent_child, related, duplicate_of, etc.); linking never merges timelines.

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| from_issue_id | uuid | no | | Foreign key to issues (source of relationship) |
| to_issue_id | uuid | no | | Foreign key to issues (target of relationship) |
| relationship_type | text | no | | Type (parent_child, related, duplicate_of, caused_by, converted_to, supersedes, same_incident, shared_legal_matter) |
| reason | text | yes | | Why this relationship exists |
| created_by | text | yes | | Staff identifier who created the link |

**Indices:** from_issue_id, to_issue_id, relationship_type  
**Constraints:**
- Check(relationship_type in (...))
- Check(from_issue_id <> to_issue_id)
- Unique(from_issue_id, to_issue_id, relationship_type)

---

### stale_acknowledgments

**Purpose:** Stale-case acknowledgment trail; tracks flagged dates, meaningful events, and required acknowledgments (spec §31.2).

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| flagged_at | timestamptz | no | now() | When the case was flagged as stale |
| last_meaningful_event_at | timestamptz | yes | | Timestamp of the last meaningful activity |
| age_days | integer | yes | | Number of days case has been stale |
| acknowledged_at | timestamptz | yes | | When the stale flag was acknowledged |
| acknowledged_by | text | yes | | Staff identifier who acknowledged |
| status_explanation | text | yes | | Required explanation of the case status |
| new_next_task_id | uuid | yes | | Foreign key to new next task (if created) |
| new_due_date | date | yes | | Due date for the new task |
| escalated_at | timestamptz | yes | | When escalated if not resolved |
| escalated_to | text | yes | | Staff or manager escalated to |

**Indices:** issue_id, acknowledged_at, flagged_at  
**Constraints:** Check(acknowledged_at is null OR (acknowledged_by is not null AND status_explanation is not null))

---

### deadlines

**Purpose:** User-entered or externally-supplied deadlines stored verbatim with source, timezone, and verification status; never recalculated.

**Writer:** Property Operations

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | yes | | Foreign key to issues (must link to something) |
| task_id | uuid | yes | | Foreign key to tasks (must link to something) |
| property_ref_id | uuid | yes | | Foreign key to property_refs (must link to something) |
| deadline_type | text | no | | Classification (e.g., 'legal', 'contractual', 'internal') |
| due_at | timestamptz | no | | The deadline timestamp (stored exactly as recorded) |
| due_timezone | text | no | 'UTC' | Timezone the deadline was specified in |
| source | text | no | | Origin (e.g., 'attorney', 'customer', 'config', 'system') |
| source_reference | text | yes | | External reference (document ID, email thread, etc.) |
| verification_status | text | no | 'unverified' | Status (unverified, verified, disputed) |
| notes | text | yes | | Additional context or warnings |

**Indices:** issue_id, task_id, property_ref_id, due_at, deadline_type  
**Constraints:**
- Check(verification_status in (...))
- Check(issue_id is not null OR task_id is not null OR property_ref_id is not null)

---

## Work / Vendor / Cost

Vendor management, bidding, job contracting, cost tracking, and approval workflows.

### vendors

**Purpose:** Vendor profile and eligibility tracking (states, capabilities, insurance, W-9 status, dispatch authorization).

**Writer:** Property Operations (vendor management)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| person_ref_id | uuid | no | | Foreign key to person_refs |
| display_name | text | no | | Vendor business name |
| states | text[] | no | {} | Array of state abbreviations vendor serves |
| service_areas | text | no | '' | Comma-separated service areas or description |
| service_radius_miles | integer | yes | | Service radius if applicable |
| capabilities | text[] | no | {} | Array of work types (cleanup, lawn, etc.) |
| w9_status | text | no | 'not_collected' | W-9 documentation status (not_collected, requested, received, verified, expired) |
| agreement_status | text | no | 'none' | Vendor agreement status (none, sent, signed, expired) |
| agreement_evidence_file_id | uuid | yes | | Foreign key to evidence_files for signed agreement |
| insurance_status | text | no | 'not_collected' | Insurance documentation status (not_collected, requested, received, verified, expired) |
| insurance_expires_on | date | yes | | Insurance expiration date |
| w9_expires_on | date | yes | | W-9 expiration date |
| do_not_dispatch | boolean | no | false | If true, vendor should not be assigned new work |
| do_not_dispatch_reason | text | yes | | Reason for dispatch block |
| notes | text | yes | | Vendor notes and history |

**Indices:** person_ref_id, do_not_dispatch

---

### bids

**Purpose:** Vendor bids on issue-scoped work; tracks scope, amount, evidence, completeness, and decision.

**Writer:** Property Operations (vendor/bid workflow)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| vendor_id | uuid | no | | Foreign key to vendors |
| scope | text | no | | What work is being bid on |
| amount_cents | bigint | no | | Bid amount in cents |
| estimated_start_date | date | yes | | When vendor estimates starting |
| estimated_completion_date | date | yes | | When vendor estimates completion |
| status | text | no | 'draft' | Bid status (draft, submitted, complete, accepted, rejected, withdrawn, expired) |
| cost_evidence_file_id | uuid | yes | | Foreign key to evidence_files for bid documentation |
| time_evidence_present | boolean | no | false | Whether timeline/schedule evidence was provided |
| walkthrough_evidence_present | boolean | no | false | Whether walkthrough evidence was provided |
| decision_reason | text | yes | | Reason for accepting/rejecting bid |
| decided_by | uuid | yes | | Foreign key to person_refs (decision maker) |
| decided_at | timestamptz | yes | | When decision was made |

**Indices:** issue_id, vendor_id, status

---

### vendor_jobs

**Purpose:** Approved/contracted vendor work on an issue; tracks scheduled/actual dates, final cost, and verification.

**Writer:** Property Operations (vendor job workflow)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| bid_id | uuid | no | | Foreign key to bids (approved bid) |
| vendor_id | uuid | no | | Foreign key to vendors |
| contract_reference | text | yes | | Reference to signed contract document |
| status | text | no | 'scheduled' | Job status (scheduled, in_progress, completed, verified, cancelled, disputed) |
| scheduled_start_date | date | yes | | When work is scheduled to start |
| scheduled_completion_date | date | yes | | When work is scheduled to complete |
| actual_start_date | date | yes | | When work actually started |
| actual_completion_date | date | yes | | When work actually completed |
| final_cost_cents | bigint | yes | | Final cost in cents (may differ from bid if change orders applied) |
| verified_by | uuid | yes | | Foreign key to person_refs (who verified completion) |
| verified_at | timestamptz | yes | | When completion was verified |
| verification_evidence_file_id | uuid | yes | | Foreign key to evidence_files for verification proof |

**Indices:** issue_id, bid_id, vendor_id, status

---

### change_orders

**Purpose:** Versioned change orders against a vendor job; tracks scope/cost/approval chain.

**Writer:** Property Operations (vendor job workflow)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| vendor_job_id | uuid | no | | Foreign key to vendor_jobs |
| version | integer | no | | Sequence number of this change order |
| description | text | no | | What is changing |
| amount_delta_cents | bigint | no | 0 | Change to contract cost in cents (can be negative) |
| status | text | no | 'proposed' | Status (proposed, approved, rejected, superseded) |
| requested_by | uuid | yes | | Foreign key to person_refs (who requested) |
| approved_by | uuid | yes | | Foreign key to person_refs (who approved) |
| approved_at | timestamptz | yes | | When approved |
| evidence_file_id | uuid | yes | | Foreign key to evidence_files for documentation |

**Indices:** vendor_job_id, status  
**Constraints:** Unique(vendor_job_id, version)

---

### cost_entries

**Purpose:** Classified cost line items for an issue (estimated, bid, committed, approved, invoiced, paid, etc.); one writer: Property Operations cost tracking.

**Writer:** Property Operations (cost tracking)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| vendor_job_id | uuid | yes | | Foreign key to vendor_jobs (optional) |
| classification | text | no | | Cost type (estimated, bid, committed, approved, invoiced, paid, additional_outside_contract, disputed, recoverable, customer_chargeable, waived, written_off) |
| amount_cents | bigint | no | | Cost amount in cents |
| recorded_by | uuid | no | | Foreign key to person_refs (who recorded) |
| reason | text | yes | | Why this cost entry was recorded |
| effective_date | date | no | current_date | Date the cost became effective |

**Indices:** issue_id, vendor_job_id, classification

---

### payment_requests

**Purpose:** Payment request lifecycle (Draft..Voided); Accounting owns state changes; Property Operations records the request.

**Writer:** Accounting (state changes per spec §29.7); Property Operations (request creation)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| vendor_job_id | uuid | yes | | Foreign key to vendor_jobs (optional) |
| vendor_id | uuid | no | | Foreign key to vendors |
| invoice_number | text | yes | | Invoice number from vendor |
| amount_cents | bigint | no | | Amount to pay in cents |
| source_document_evidence_file_id | uuid | yes | | Foreign key to evidence_files for invoice/receipt |
| status | text | no | 'draft' | Status (draft, submitted, needs_information, approved, scheduled, paid, partially_paid, denied, cancelled, voided) |
| requested_by | uuid | yes | | Foreign key to person_refs (who submitted) |
| approved_by | uuid | yes | | Foreign key to person_refs (who approved) |
| paid_at | timestamptz | yes | | When payment was issued |
| denial_reason | text | yes | | If denied, reason why |
| likely_duplicate_of | uuid | yes | | Foreign key to another payment_requests if suspected duplicate |

**Indices:** issue_id, vendor_job_id, vendor_id, status  
**Constraints:** Unique(vendor_id, invoice_number) where invoice_number is not null and status not in ('denied', 'cancelled', 'voided')

---

### approvals

**Purpose:** Approval requests/decisions gating threshold-controlled commands (e.g., second bid >= $1,500).

**Writer:** Property Operations (approval workflow)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| requested_action | text | no | | What action requires approval (e.g., 'release', 'second_bid', 'exception') |
| threshold_rule | text | yes | | Config rule that triggered this approval requirement |
| object_table | text | no | | Table name of the object being approved |
| object_id | uuid | no | | ID of the object being approved |
| requester_id | uuid | no | | Foreign key to person_refs (who requested) |
| approver_id | uuid | yes | | Foreign key to person_refs (who approves; null until assigned) |
| decision | text | no | 'pending' | Decision status (pending, approved, rejected, withdrawn) |
| decided_at | timestamptz | yes | | When decision was made |
| decision_reason | text | yes | | Reason for decision |

**Indices:** requester_id, approver_id, decision, (object_table, object_id)

---

## Evidence / Communications / Documents

Evidence capture, communication logs, notices, and checklists.

### evidence_files

**Purpose:** Immutable evidence originals and versioned derivatives; never hard-deleted (archived_at tombstone only).

**Writer:** Property Operations (evidence capture)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| original_version_id | uuid | yes | | Foreign key to evidence_files (if this is a derivative/edit) |
| storage_ref | text | no | | Storage system reference (S3 key, etc.) |
| original_filename | text | yes | | File name as uploaded |
| file_type | text | yes | | MIME type or file extension |
| size_bytes | bigint | yes | | File size in bytes |
| checksum | text | yes | | Hash for integrity verification |
| captured_at | timestamptz | yes | | When evidence was originally captured |
| uploaded_at | timestamptz | no | now() | When uploaded to system |
| uploader_person_ref_id | uuid | yes | | Foreign key to person_refs (who uploaded) |
| source_system | text | yes | | System that supplied the evidence (e.g., camera, JustCall) |
| device_or_location_metadata | jsonb | no | {} | Device/location info (coordinates, device name, etc.) |
| provider_id | text | yes | | External provider event/media ID |
| access_classification | text | no | 'internal' | Access level (internal, restricted_legal, restricted_financial) |
| issue_id | uuid | yes | | Foreign key to issues |
| property_ref_id | uuid | yes | | Foreign key to property_refs |
| person_ref_id | uuid | yes | | Foreign key to person_refs |
| task_id | uuid | yes | | Foreign key to tasks |
| archived_at | timestamptz | yes | | When archived (tombstone); null if active |
| archived_reason | text | yes | | Why archived |

**Indices:** original_version_id, uploader_person_ref_id, issue_id, property_ref_id, person_ref_id, task_id, access_classification, archived_at

---

### communication_events

**Purpose:** Normalized communication record (call/text/email/voicemail/notice) with provider deduplication; no content copies.

**Writer:** Property Operations (communications intake; integration seam for JustCall/PandaDoc)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| channel | text | no | | Communication type (call, text, email, voicemail, notice, other) |
| direction | text | no | | Direction (inbound, outbound) |
| provider_system | text | yes | | Source system (e.g., 'justcall', 'panda_doc') |
| provider_event_id | text | yes | | External event/record ID for deduplication |
| occurred_at | timestamptz | no | | When communication occurred |
| from_person_ref_id | uuid | yes | | Foreign key to person_refs (sender) |
| to_person_ref_id | uuid | yes | | Foreign key to person_refs (recipient) |
| summary | text | yes | | Summary of communication content |
| evidence_file_id | uuid | yes | | Foreign key to evidence_files (transcript, recording metadata, etc.) |

**Indices:** from_person_ref_id, to_person_ref_id, occurred_at, evidence_file_id  
**Constraints:** Unique(provider_system, provider_event_id) where provider_system is not null

---

### communication_links

**Purpose:** Links a communication_event to the people/issues/tasks it concerns, without content duplication.

**Writer:** Property Operations (communications intake)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| communication_event_id | uuid | no | | Foreign key to communication_events |
| issue_id | uuid | yes | | Foreign key to issues (must link to at least one) |
| task_id | uuid | yes | | Foreign key to tasks (must link to at least one) |
| person_ref_id | uuid | yes | | Foreign key to person_refs (must link to at least one) |

**Indices:** communication_event_id, issue_id, task_id, person_ref_id  
**Constraints:** Check(issue_id is not null OR task_id is not null OR person_ref_id is not null)

---

### notices

**Purpose:** Legal/covenant notices with delivery evidence and cure deadline; deadline stored verbatim per spec §6.4.

**Writer:** Property Operations (notice workflow)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| issue_id | uuid | no | | Foreign key to issues |
| template_version | text | no | | Config version of the notice template |
| recipient_person_ref_id | uuid | no | | Foreign key to person_refs (recipient) |
| address_used | text | yes | | Mailing address used for delivery |
| delivery_method | text | yes | | How delivered (mail, email, hand_delivery, posting, other) |
| delivery_evidence_file_id | uuid | yes | | Foreign key to evidence_files (proof of delivery) |
| sent_at | timestamptz | yes | | When notice was sent |
| cure_deadline | date | yes | | Deadline for cure of violation |
| status | text | no | 'pending' | Status (pending, sent, delivered, failed, cured, expired) |

**Indices:** issue_id, recipient_person_ref_id, delivery_evidence_file_id, status, cure_deadline

---

### checklist_items

**Purpose:** Versioned phase checklist item status; tracks required vs. present/verified/waived/not-applicable (spec §31.3).

**Writer:** Property Operations (phase/checklist workflow)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| phase_instance_id | uuid | no | | Foreign key to phase_instances |
| checklist_version | text | no | | Config version of checklist |
| item_key | text | no | | Config key for checklist item |
| label | text | no | | Display label |
| status | text | no | 'required_missing' | Status (required_missing, present, verified, waived, not_applicable, superseded) |
| evidence_file_id | uuid | yes | | Foreign key to evidence_files |
| waived_by | uuid | yes | | Foreign key to person_refs (who waived) |
| waived_reason | text | yes | | Reason for waiving |
| verified_by | uuid | yes | | Foreign key to person_refs (who verified) |
| verified_at | timestamptz | yes | | When verified |

**Indices:** phase_instance_id, status, evidence_file_id  
**Constraints:** Unique(phase_instance_id, checklist_version, item_key)

---

## Platform

System configuration, integration tracking, domain events, and audit trail.

### config_versions

**Purpose:** Effective-dated configuration bundle headers (dropdowns, deadlines, thresholds, role rights, templates, notification rules).

**Writer:** Property Operations (admin configuration)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| config_key | text | no | | Config identifier (e.g., 'phase_1_defaults') |
| version_label | text | no | | Version number (e.g., '1', '2') |
| effective_from | timestamptz | no | now() | When this version becomes active |
| effective_to | timestamptz | yes | | When this version expires; null if still active |
| description | text | yes | | Description of changes in this version |

**Indices:** config_key, effective_from, effective_to  
**Constraints:** Unique(config_key, version_label)

---

### config_entries

**Purpose:** Individual configuration entries within a config_versions bundle; historical records keep retired labels.

**Writer:** Property Operations (admin configuration)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| config_version_id | uuid | no | | Foreign key to config_versions |
| entry_key | text | no | | Configuration key (e.g., 'issue_types', 'transitions', 'thresholds') |
| entry_value | jsonb | no | | Configuration value (structure varies by key) |
| retired | boolean | no | false | Whether this entry is retired; historical records are never deleted |

**Indices:** config_version_id, entry_key  
**Constraints:** Unique(config_version_id, entry_key)

---

### integration_identities

**Purpose:** Internal object to external-system identity mapping with sync state (integration seam for PandaDoc/JustCall/Airtable).

**Writer:** Property Operations (integration adapters)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| object_table | text | no | | Table name of the internal object |
| object_id | uuid | no | | ID of the internal object |
| source_system | text | no | | External system (e.g., 'panda_doc', 'justcall', 'airtable') |
| external_object_type | text | yes | | Type in external system (e.g., 'document', 'call', 'record') |
| external_id | text | no | | ID in external system |
| direction | text | no | 'inbound' | Sync direction (inbound, outbound, bidirectional) |
| idempotency_key | text | yes | | Key for idempotent replays |
| sync_status | text | no | 'pending' | Status (pending, synced, error, stale) |
| last_attempt_at | timestamptz | yes | | When last sync was attempted |
| last_error | text | yes | | Error message from last failed sync |

**Indices:** (object_table, object_id), source_system, sync_status  
**Constraints:** Unique(source_system, external_object_type, external_id)

---

### domain_events

**Purpose:** Outbox-style domain event log written in-transaction with the command; transport/bus governed centrally (spec §30.3).

**Writer:** Property Operations (command layer via lib/services/events.ts)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| event_type | text | no | | Event type (e.g., 'issue.created', 'issue.released', 'hold.placed') |
| schema_version | integer | no | 1 | Schema version for the event payload |
| source_module | text | no | 'property_operations' | Module that originated the event |
| payload | jsonb | no | {} | Event data (structure varies by event_type) |
| person_ref_id | uuid | yes | | Foreign key to person_refs (actor) |
| property_ref_id | uuid | yes | | Foreign key to property_refs (if property-scoped) |
| issue_id | uuid | yes | | Foreign key to issues (if issue-scoped) |
| occurred_at | timestamptz | no | now() | When the event occurred |
| recorded_at | timestamptz | no | now() | When the event was recorded |
| actor | text | yes | | Actor identifier |
| correlation_id | uuid | yes | | Request correlation ID for tracing |
| idempotency_key | text | no | | Key for idempotent event consumption |

**Indices:** event_type, person_ref_id, property_ref_id, issue_id, occurred_at, correlation_id  
**Constraints:** Unique(idempotency_key)

---

### consumed_events

**Purpose:** Idempotent-consumption ledger for events consumed from domain_events bus or external systems.

**Writer:** Property Operations (event subscribers)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp |
| updated_at | timestamptz | no | now() | Last update timestamp |
| source_system | text | no | | System that originated the event |
| idempotency_key | text | no | | Key for deduplication |
| processed_at | timestamptz | no | now() | When event was processed |
| result | text | no | 'processed' | Outcome (processed, skipped_duplicate, error) |
| error_detail | text | yes | | Error message if result = 'error' |

**Indices:** source_system, processed_at  
**Constraints:** Unique(source_system, idempotency_key)

---

### audit_events

**Purpose:** Append-only audit trail written by every command in-transaction (spec §29.2); no UPDATE/DELETE allowed.

**Writer:** Property Operations (audit.ts)

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | uuid | no | gen_random_uuid() | Primary key |
| created_at | timestamptz | no | now() | Row creation timestamp (only timestamp, no updated_at) |
| actor_id | uuid | yes | | Foreign key to person_refs (who performed action) |
| actor_external_id | text | yes | | Hub staff identity (`lib/auth/current-user.ts` `CurrentUser.id`), added 20260731090500. A free-text external identity, NOT a `person_refs` row — `actor_id` is a uuid FK and cannot hold it. Set on every command whose caller is Hub staff rather than a `person_refs`-modeled actor. |
| actor_role | text | yes | | Role of actor at time of action |
| action | text | no | | Action taken (e.g., 'create', 'update', 'release', 'transition') |
| object_table | text | no | | Table of affected object |
| object_id | uuid | no | | ID of affected object |
| before | jsonb | yes | | State before action (if update) |
| after | jsonb | yes | | State after action |
| reason | text | yes | | Reason/justification for action |
| correlation_id | uuid | yes | | Request correlation ID |
| source | text | yes | | Source (e.g., 'web_ui', 'api', 'batch_job') |
| occurred_at | timestamptz | no | now() | When action occurred |

**Indices:** actor_id, (object_table, object_id), occurred_at, correlation_id  
**Constraints:** No UPDATE/DELETE allowed (enforced by append-only trigger)
