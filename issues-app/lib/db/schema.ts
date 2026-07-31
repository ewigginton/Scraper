/**
 * Drizzle schema — hand-written to match supabase/migrations/*.sql EXACTLY.
 *
 * Source of truth: supabase/migrations/20260731090000_issues_core.sql and
 * supabase/migrations/20260731090100_issues_work_platform.sql. If a
 * migration changes, update this file to match — never the other way
 * around (migrations are the schema of record; this is a typed mirror).
 *
 * Conventions mirrored from the SQL:
 * - Every table: id uuid primary key default gen_random_uuid(), created_at
 *   timestamptz not null default now(); updated_at is present on every
 *   table except audit_events (append-only, no updated_at column/trigger).
 * - text CHECK enums are modeled as `text()` columns typed via a TS union
 *   through `.$type<...>()` — NOT pgEnum, since the SQL uses plain text +
 *   CHECK (admin-editable without a schema migration, per DESIGN.md).
 * - FKs carry the same ON DELETE behavior as the SQL (restrict/set null).
 * - Circular FKs (issues <-> phase_instances) and deferred FKs (evidence
 *   files onto vendors/bids/vendor_jobs/change_orders/payment_requests)
 *   are declared without TS-level circularity problems by NOT using
 *   `.references()` for the back-reference side; the DB-level FK still
 *   exists in the migration. This mirrors the SQL's own two-step
 *   `alter table ... add constraint` pattern.
 */

import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// drizzle-orm/pg-core does not export a `timestamptz` helper; timestamptz is
// `timestamp(..., { withTimezone: true })`. Alias for readability at call
// sites below, matching the SQL column type name.
const tsTz = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------
// property_refs
// ---------------------------------------------------------------------

export const propertyRefs = pgTable(
  'property_refs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    sourceSystem: text('source_system').notNull(),
    externalId: text('external_id').notNull(),

    development: text('development'),
    tract: text('tract'),
    state: text('state'),
    county: text('county'),
    mapLink: text('map_link'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),

    displayName: text('display_name'),
    statusCached: text('status_cached'),
    lastSyncedAt: tsTz('last_synced_at'),
  },
  (t) => [
    unique('property_refs_source_external_unique').on(t.sourceSystem, t.externalId),
    index('property_refs_state_idx').on(t.state),
    index('property_refs_county_idx').on(t.county),
    index('property_refs_last_synced_at_idx').on(t.lastSyncedAt),
  ],
);

export type PropertyRef = typeof propertyRefs.$inferSelect;
export type NewPropertyRef = typeof propertyRefs.$inferInsert;

// ---------------------------------------------------------------------
// person_refs
// ---------------------------------------------------------------------

export const personRefs = pgTable(
  'person_refs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    sourceSystem: text('source_system').notNull(),
    externalId: text('external_id'),

    displayName: text('display_name').notNull(),
    kind: text('kind').notNull().$type<'person' | 'org'>(),
    contactSnapshot: jsonb('contact_snapshot').notNull().default({}),

    personId: uuid('person_id'),

    aliases: jsonb('aliases').notNull().default({}),
  },
  (t) => [
    // Partial unique index (external_id is not always known); the `where`
    // clause matches the SQL's `where external_id is not null`.
    uniqueIndex('person_refs_source_external_unique_idx')
      .on(t.sourceSystem, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('person_refs_person_id_idx').on(t.personId),
    index('person_refs_display_name_idx').on(t.displayName),
    check('person_refs_kind_check', sql`${t.kind} in ('person', 'org')`),
  ],
);

export type PersonRef = typeof personRefs.$inferSelect;
export type NewPersonRef = typeof personRefs.$inferInsert;

// ---------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------

export type IssueType =
  | 'default_recovery'
  | 'covenant_violation'
  | 'market_readiness'
  | 'property_legal'
  | 'buyer_cleanup';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export type LifecycleStatus =
  | 'intake'
  | 'active'
  | 'waiting'
  | 'blocked'
  | 'on_hold'
  | 'passive_wait'
  | 'closed';

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueType: text('issue_type').notNull().$type<IssueType>(),
    propertyRefId: uuid('property_ref_id')
      .notNull()
      .references(() => propertyRefs.id, { onDelete: 'restrict' }),

    summary: text('summary').notNull(),

    priority: text('priority').notNull().default('normal').$type<Priority>(),

    businessPriorityScore: numeric('business_priority_score'),
    businessPriorityLabel: text('business_priority_label'),
    businessPriorityInputs: jsonb('business_priority_inputs'),
    businessPriorityComputedAt: tsTz('business_priority_computed_at'),
    businessPriorityOverrideReason: text('business_priority_override_reason'),

    coordinatorId: text('coordinator_id'),
    queue: text('queue'),

    lifecycleStatus: text('lifecycle_status').notNull().default('intake').$type<LifecycleStatus>(),

    // FK to phase_instances is added by the migration via a separate
    // `alter table` (circular dependency). Declared here as a plain uuid
    // column; the DB-level constraint exists regardless.
    currentPhaseInstanceId: uuid('current_phase_instance_id'),

    wakeEvent: text('wake_event'),
    reviewDate: date('review_date'),

    configVersionId: uuid('config_version_id'),

    // Property-Operations-owned facts (20260731090400_issues_release_gate_facts.sql).
    // NOT property_refs.map_link, which is a sync-owned read-through cache.
    mapLink: text('map_link'),
    priceReviewedAt: tsTz('price_reviewed_at'),
  },
  (t) => [
    index('issues_property_ref_id_idx').on(t.propertyRefId),
    index('issues_lifecycle_status_idx').on(t.lifecycleStatus),
    index('issues_coordinator_id_idx').on(t.coordinatorId),
    index('issues_priority_idx').on(t.priority),
    index('issues_current_phase_instance_id_idx').on(t.currentPhaseInstanceId),
    index('issues_review_date_idx').on(t.reviewDate),
    check(
      'issues_issue_type_check',
      sql`${t.issueType} in ('default_recovery', 'covenant_violation', 'market_readiness', 'property_legal', 'buyer_cleanup')`,
    ),
    check('issues_priority_check', sql`${t.priority} in ('low', 'normal', 'high', 'urgent')`),
    check(
      'issues_lifecycle_status_check',
      sql`${t.lifecycleStatus} in ('intake', 'active', 'waiting', 'blocked', 'on_hold', 'passive_wait', 'closed')`,
    ),
    check(
      'issues_active_requires_owner_check',
      sql`${t.lifecycleStatus} <> 'active' or ${t.coordinatorId} is not null or ${t.queue} is not null`,
    ),
    check(
      'issues_passive_wait_requires_wake_check',
      sql`${t.lifecycleStatus} <> 'passive_wait' or ${t.wakeEvent} is not null or ${t.reviewDate} is not null`,
    ),
  ],
);

export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;

// ---------------------------------------------------------------------
// issue_people
// ---------------------------------------------------------------------

export type IssuePersonRole =
  | 'owner'
  | 'buyer'
  | 'former_owner'
  | 'neighbor'
  | 'reporter'
  | 'vendor'
  | 'attorney'
  | 'other';

export const issuePeople = pgTable(
  'issue_people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    personRefId: uuid('person_ref_id')
      .notNull()
      .references(() => personRefs.id, { onDelete: 'restrict' }),

    role: text('role').notNull().$type<IssuePersonRole>(),
    startDate: date('start_date').notNull().default(sql`current_date`),
    endDate: date('end_date'),
    notes: text('notes'),
  },
  (t) => [
    index('issue_people_issue_id_idx').on(t.issueId),
    index('issue_people_person_ref_id_idx').on(t.personRefId),
    index('issue_people_role_idx').on(t.role),
    check(
      'issue_people_role_check',
      sql`${t.role} in ('owner', 'buyer', 'former_owner', 'neighbor', 'reporter', 'vendor', 'attorney', 'other')`,
    ),
  ],
);

export type IssuePerson = typeof issuePeople.$inferSelect;
export type NewIssuePerson = typeof issuePeople.$inferInsert;

// ---------------------------------------------------------------------
// issue_cycles
// ---------------------------------------------------------------------

export const issueCycles = pgTable(
  'issue_cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),

    cycleNumber: integer('cycle_number').notNull().default(1),
    openedAt: tsTz('opened_at').notNull().defaultNow(),
    closedAt: tsTz('closed_at'),
    reason: text('reason'),
    outcome: text('outcome'),
  },
  (t) => [
    unique('issue_cycles_issue_cycle_number_unique').on(t.issueId, t.cycleNumber),
    index('issue_cycles_issue_id_idx').on(t.issueId),
    index('issue_cycles_closed_at_idx').on(t.closedAt),
  ],
);

export type IssueCycle = typeof issueCycles.$inferSelect;
export type NewIssueCycle = typeof issueCycles.$inferInsert;

// ---------------------------------------------------------------------
// phase_instances
// ---------------------------------------------------------------------

export type PhaseInstanceStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'skipped'
  | 'cancelled';

export const phaseInstances = pgTable(
  'phase_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    issueCycleId: uuid('issue_cycle_id').references(() => issueCycles.id, { onDelete: 'set null' }),

    phaseKey: text('phase_key').notNull(),

    ownerId: text('owner_id'),
    queue: text('queue'),
    status: text('status').notNull().default('open').$type<PhaseInstanceStatus>(),

    startedAt: tsTz('started_at'),
    endedAt: tsTz('ended_at'),

    entryReason: text('entry_reason'),
    exitOutcome: text('exit_outcome'),
    handoffSummary: text('handoff_summary'),
    handoffNextTask: text('handoff_next_task'),
    handoffDueDate: date('handoff_due_date'),
  },
  (t) => [
    index('phase_instances_issue_id_idx').on(t.issueId),
    index('phase_instances_issue_cycle_id_idx').on(t.issueCycleId),
    index('phase_instances_status_idx').on(t.status),
    index('phase_instances_owner_id_idx').on(t.ownerId),
    index('phase_instances_handoff_due_date_idx').on(t.handoffDueDate),
    check(
      'phase_instances_status_check',
      sql`${t.status} in ('open', 'in_progress', 'blocked', 'completed', 'skipped', 'cancelled')`,
    ),
  ],
);

export type PhaseInstance = typeof phaseInstances.$inferSelect;
export type NewPhaseInstance = typeof phaseInstances.$inferInsert;

// Note: issues.current_phase_instance_id -> phase_instances.id FK is added
// by the migration via a separate `alter table` after phase_instances is
// created (circular dependency). Not re-declared at the Drizzle level to
// avoid a TS circular-reference; the DB constraint governs at runtime.

// ---------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------

export type TaskStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'restrict' }),
    issueCycleId: uuid('issue_cycle_id').references(() => issueCycles.id, { onDelete: 'set null' }),
    phaseInstanceId: uuid('phase_instance_id').references(() => phaseInstances.id, { onDelete: 'set null' }),
    propertyRefId: uuid('property_ref_id').references(() => propertyRefs.id, { onDelete: 'set null' }),
    personRefId: uuid('person_ref_id').references(() => personRefs.id, { onDelete: 'set null' }),

    assigneeId: text('assignee_id'),
    queue: text('queue'),

    title: text('title').notNull(),
    description: text('description'),

    status: text('status').notNull().default('open').$type<TaskStatus>(),
    priority: text('priority').notNull().default('normal').$type<Priority>(),

    dueDate: date('due_date'),
    actionDate: date('action_date'),
    targetCompletionDate: date('target_completion_date'),
    verifiedCompletionDate: date('verified_completion_date'),

    sourceRule: text('source_rule'),

    // Seam: evidence_files FK lands in a later migration; plain uuid for now.
    completionEvidenceId: uuid('completion_evidence_id'),

    waitingReason: text('waiting_reason'),
    waitingParty: text('waiting_party'),
  },
  (t) => [
    index('tasks_issue_id_idx').on(t.issueId),
    index('tasks_issue_cycle_id_idx').on(t.issueCycleId),
    index('tasks_phase_instance_id_idx').on(t.phaseInstanceId),
    index('tasks_property_ref_id_idx').on(t.propertyRefId),
    index('tasks_person_ref_id_idx').on(t.personRefId),
    index('tasks_status_idx').on(t.status),
    index('tasks_due_date_idx').on(t.dueDate),
    index('tasks_action_date_idx').on(t.actionDate),
    index('tasks_assignee_id_idx').on(t.assigneeId),
    index('tasks_queue_idx').on(t.queue),
    check('tasks_status_check', sql`${t.status} in ('open', 'in_progress', 'completed', 'cancelled')`),
    check('tasks_priority_check', sql`${t.priority} in ('low', 'normal', 'high', 'urgent')`),
    check(
      'tasks_open_requires_owner_check',
      sql`${t.status} not in ('open', 'in_progress') or ${t.assigneeId} is not null or ${t.queue} is not null`,
    ),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// ---------------------------------------------------------------------
// holds
// ---------------------------------------------------------------------

export type HoldType =
  | 'legal'
  | 'safety'
  | 'occupancy'
  | 'cleanup'
  | 'foreclosure'
  | 'title'
  | 'covenant'
  | 'stop_work'
  | 'existing_contract_active'
  | 'other';

export const holds = pgTable(
  'holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    propertyRefId: uuid('property_ref_id')
      .notNull()
      .references(() => propertyRefs.id, { onDelete: 'restrict' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'restrict' }),

    holdType: text('hold_type').notNull().$type<HoldType>(),
    scope: text('scope'),
    reason: text('reason').notNull(),
    source: text('source'),
    ownerId: text('owner_id'),

    effectiveStart: tsTz('effective_start').notNull().defaultNow(),
    effectiveEnd: tsTz('effective_end'),

    releaseCriteria: text('release_criteria'),
    releaseAuthority: text('release_authority'),

    releasedAt: tsTz('released_at'),
    releasedBy: text('released_by'),
    releaseReason: text('release_reason'),
  },
  (t) => [
    index('holds_property_ref_id_idx').on(t.propertyRefId),
    index('holds_issue_id_idx').on(t.issueId),
    index('holds_hold_type_idx').on(t.holdType),
    index('holds_active_by_property_idx')
      .on(t.propertyRefId)
      .where(sql`${t.releasedAt} is null`),
    check(
      'holds_hold_type_check',
      sql`${t.holdType} in ('legal', 'safety', 'occupancy', 'cleanup', 'foreclosure', 'title', 'covenant', 'stop_work', 'existing_contract_active', 'other')`,
    ),
    check(
      'holds_release_documented_check',
      sql`${t.releasedAt} is null or (${t.releasedBy} is not null and ${t.releaseReason} is not null)`,
    ),
  ],
);

export type Hold = typeof holds.$inferSelect;
export type NewHold = typeof holds.$inferInsert;

// ---------------------------------------------------------------------
// possession_records
// ---------------------------------------------------------------------

export type PossessionStatus =
  | 'unknown'
  | 'occupied_or_suspected'
  | 'vacancy_unverified'
  | 'vacancy_verified'
  | 'personal_property_present'
  | 'removal_disposition_review'
  | 'removal_authorized'
  | 'stored'
  | 'transferred'
  | 'disposed'
  | 'cleared';

export const possessionRecords = pgTable(
  'possession_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    propertyRefId: uuid('property_ref_id')
      .notNull()
      .references(() => propertyRefs.id, { onDelete: 'restrict' }),

    possessionStatus: text('possession_status').notNull().$type<PossessionStatus>(),
    observedAt: tsTz('observed_at').notNull().defaultNow(),
    observerId: text('observer_id'),
    observerPersonRefId: uuid('observer_person_ref_id').references(() => personRefs.id, {
      onDelete: 'set null',
    }),

    evidenceRefs: jsonb('evidence_refs').notNull().default([]),
    notes: text('notes'),
  },
  (t) => [
    index('possession_records_issue_id_idx').on(t.issueId),
    index('possession_records_property_ref_id_idx').on(t.propertyRefId),
    index('possession_records_status_idx').on(t.possessionStatus),
    index('possession_records_observed_at_idx').on(t.observedAt),
    check(
      'possession_records_status_check',
      sql`${t.possessionStatus} in ('unknown', 'occupied_or_suspected', 'vacancy_unverified', 'vacancy_verified', 'personal_property_present', 'removal_disposition_review', 'removal_authorized', 'stored', 'transferred', 'disposed', 'cleared')`,
    ),
  ],
);

export type PossessionRecord = typeof possessionRecords.$inferSelect;
export type NewPossessionRecord = typeof possessionRecords.$inferInsert;

// ---------------------------------------------------------------------
// personal_property_items
// ---------------------------------------------------------------------

export type PersonalPropertyItemType =
  | 'belonging'
  | 'structure'
  | 'vehicle'
  | 'rv_camper'
  | 'equipment'
  | 'animal'
  | 'trash_debris'
  | 'key'
  | 'gate_code'
  | 'lock'
  | 'utility'
  | 'hazard'
  | 'other';

export type CustodyStatus =
  | 'on_property'
  | 'removed'
  | 'stored'
  | 'transferred_to_claimant'
  | 'disposed'
  | 'towed'
  | 'unknown';

export const personalPropertyItems = pgTable(
  'personal_property_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    propertyRefId: uuid('property_ref_id')
      .notNull()
      .references(() => propertyRefs.id, { onDelete: 'restrict' }),
    possessionRecordId: uuid('possession_record_id').references(() => possessionRecords.id, {
      onDelete: 'set null',
    }),

    itemType: text('item_type').notNull().$type<PersonalPropertyItemType>(),
    description: text('description').notNull(),
    location: text('location'),

    claimantPersonRefId: uuid('claimant_person_ref_id').references(() => personRefs.id, {
      onDelete: 'set null',
    }),

    observedAt: tsTz('observed_at'),
    observerId: text('observer_id'),
    condition: text('condition'),

    custodyStatus: text('custody_status').notNull().default('on_property').$type<CustodyStatus>(),
    disposition: text('disposition'),
    dispositionAuthority: text('disposition_authority'),
    dispositionDocumentedAt: tsTz('disposition_documented_at'),

    evidenceRefs: jsonb('evidence_refs').notNull().default([]),
  },
  (t) => [
    index('personal_property_items_issue_id_idx').on(t.issueId),
    index('personal_property_items_property_ref_id_idx').on(t.propertyRefId),
    index('personal_property_items_possession_record_id_idx').on(t.possessionRecordId),
    index('personal_property_items_item_type_idx').on(t.itemType),
    index('personal_property_items_custody_status_idx').on(t.custodyStatus),
    check(
      'personal_property_items_item_type_check',
      sql`${t.itemType} in ('belonging', 'structure', 'vehicle', 'rv_camper', 'equipment', 'animal', 'trash_debris', 'key', 'gate_code', 'lock', 'utility', 'hazard', 'other')`,
    ),
    check(
      'personal_property_items_custody_status_check',
      sql`${t.custodyStatus} in ('on_property', 'removed', 'stored', 'transferred_to_claimant', 'disposed', 'towed', 'unknown')`,
    ),
  ],
);

export type PersonalPropertyItem = typeof personalPropertyItems.$inferSelect;
export type NewPersonalPropertyItem = typeof personalPropertyItems.$inferInsert;

// ---------------------------------------------------------------------
// issue_relationships
// ---------------------------------------------------------------------

export type IssueRelationshipType =
  | 'parent_child'
  | 'related'
  | 'duplicate_of'
  | 'caused_by'
  | 'converted_to'
  | 'supersedes'
  | 'same_incident'
  | 'shared_legal_matter';

export const issueRelationships = pgTable(
  'issue_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    fromIssueId: uuid('from_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    toIssueId: uuid('to_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),

    relationshipType: text('relationship_type').notNull().$type<IssueRelationshipType>(),
    reason: text('reason'),
    createdBy: text('created_by'),
  },
  (t) => [
    unique('issue_relationships_unique').on(t.fromIssueId, t.toIssueId, t.relationshipType),
    index('issue_relationships_from_issue_id_idx').on(t.fromIssueId),
    index('issue_relationships_to_issue_id_idx').on(t.toIssueId),
    index('issue_relationships_type_idx').on(t.relationshipType),
    check(
      'issue_relationships_type_check',
      sql`${t.relationshipType} in ('parent_child', 'related', 'duplicate_of', 'caused_by', 'converted_to', 'supersedes', 'same_incident', 'shared_legal_matter')`,
    ),
    check('issue_relationships_not_self_check', sql`${t.fromIssueId} <> ${t.toIssueId}`),
  ],
);

export type IssueRelationship = typeof issueRelationships.$inferSelect;
export type NewIssueRelationship = typeof issueRelationships.$inferInsert;

// ---------------------------------------------------------------------
// stale_acknowledgments
// ---------------------------------------------------------------------

export const staleAcknowledgments = pgTable(
  'stale_acknowledgments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),

    flaggedAt: tsTz('flagged_at').notNull().defaultNow(),
    lastMeaningfulEventAt: tsTz('last_meaningful_event_at'),
    ageDays: integer('age_days'),

    acknowledgedAt: tsTz('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
    statusExplanation: text('status_explanation'),
    newNextTaskId: uuid('new_next_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    newDueDate: date('new_due_date'),

    escalatedAt: tsTz('escalated_at'),
    escalatedTo: text('escalated_to'),
  },
  (t) => [
    index('stale_acknowledgments_issue_id_idx').on(t.issueId),
    index('stale_acknowledgments_acknowledged_at_idx').on(t.acknowledgedAt),
    index('stale_acknowledgments_flagged_at_idx').on(t.flaggedAt),
    check(
      'stale_acknowledgments_ack_documented_check',
      sql`${t.acknowledgedAt} is null or (${t.acknowledgedBy} is not null and ${t.statusExplanation} is not null)`,
    ),
  ],
);

export type StaleAcknowledgment = typeof staleAcknowledgments.$inferSelect;
export type NewStaleAcknowledgment = typeof staleAcknowledgments.$inferInsert;

// ---------------------------------------------------------------------
// deadlines
// ---------------------------------------------------------------------

export type DeadlineVerificationStatus = 'unverified' | 'verified' | 'disputed';

export const deadlines = pgTable(
  'deadlines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    propertyRefId: uuid('property_ref_id').references(() => propertyRefs.id, { onDelete: 'set null' }),

    deadlineType: text('deadline_type').notNull(),
    dueAt: tsTz('due_at').notNull(),
    dueTimezone: text('due_timezone').notNull().default('UTC'),

    source: text('source').notNull(),
    sourceReference: text('source_reference'),

    verificationStatus: text('verification_status')
      .notNull()
      .default('unverified')
      .$type<DeadlineVerificationStatus>(),
    notes: text('notes'),
  },
  (t) => [
    index('deadlines_issue_id_idx').on(t.issueId),
    index('deadlines_task_id_idx').on(t.taskId),
    index('deadlines_property_ref_id_idx').on(t.propertyRefId),
    index('deadlines_due_at_idx').on(t.dueAt),
    index('deadlines_deadline_type_idx').on(t.deadlineType),
    check(
      'deadlines_verification_status_check',
      sql`${t.verificationStatus} in ('unverified', 'verified', 'disputed')`,
    ),
    check(
      'deadlines_linked_to_something_check',
      sql`${t.issueId} is not null or ${t.taskId} is not null or ${t.propertyRefId} is not null`,
    ),
  ],
);

export type Deadline = typeof deadlines.$inferSelect;
export type NewDeadline = typeof deadlines.$inferInsert;

// =====================================================================
// WORK / VENDOR / COST
// =====================================================================

export type W9Status = 'not_collected' | 'requested' | 'received' | 'verified' | 'expired';
export type AgreementStatus = 'none' | 'sent' | 'signed' | 'expired';
export type InsuranceStatus = 'not_collected' | 'requested' | 'received' | 'verified' | 'expired';

export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    personRefId: uuid('person_ref_id')
      .notNull()
      .references(() => personRefs.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    states: text('states').array().notNull().default([]),
    serviceAreas: text('service_areas').notNull().default(''),
    serviceRadiusMiles: integer('service_radius_miles'),
    capabilities: text('capabilities').array().notNull().default([]),
    w9Status: text('w9_status').notNull().default('not_collected').$type<W9Status>(),
    agreementStatus: text('agreement_status').notNull().default('none').$type<AgreementStatus>(),
    // FK to evidence_files added by later `alter table` in the migration.
    agreementEvidenceFileId: uuid('agreement_evidence_file_id'),
    insuranceStatus: text('insurance_status').notNull().default('not_collected').$type<InsuranceStatus>(),
    insuranceExpiresOn: date('insurance_expires_on'),
    w9ExpiresOn: date('w9_expires_on'),
    doNotDispatch: boolean('do_not_dispatch').notNull().default(false),
    doNotDispatchReason: text('do_not_dispatch_reason'),
    notes: text('notes'),
  },
  (t) => [
    index('vendors_person_ref_id_idx').on(t.personRefId),
    index('vendors_do_not_dispatch_idx').on(t.doNotDispatch),
    index('vendors_agreement_evidence_file_id_idx').on(t.agreementEvidenceFileId),
    check(
      'vendors_w9_status_check',
      sql`${t.w9Status} in ('not_collected', 'requested', 'received', 'verified', 'expired')`,
    ),
    check('vendors_agreement_status_check', sql`${t.agreementStatus} in ('none', 'sent', 'signed', 'expired')`),
    check(
      'vendors_insurance_status_check',
      sql`${t.insuranceStatus} in ('not_collected', 'requested', 'received', 'verified', 'expired')`,
    ),
  ],
);

export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;

export type BidStatus = 'draft' | 'submitted' | 'complete' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';

export const bids = pgTable(
  'bids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    scope: text('scope').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    estimatedStartDate: date('estimated_start_date'),
    estimatedCompletionDate: date('estimated_completion_date'),
    status: text('status').notNull().default('draft').$type<BidStatus>(),
    // FK to evidence_files added by later `alter table` in the migration.
    costEvidenceFileId: uuid('cost_evidence_file_id'),
    timeEvidencePresent: boolean('time_evidence_present').notNull().default(false),
    walkthroughEvidencePresent: boolean('walkthrough_evidence_present').notNull().default(false),
    decisionReason: text('decision_reason'),
    decidedBy: uuid('decided_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    decidedAt: tsTz('decided_at'),
  },
  (t) => [
    index('bids_issue_id_idx').on(t.issueId),
    index('bids_vendor_id_idx').on(t.vendorId),
    index('bids_status_idx').on(t.status),
    index('bids_cost_evidence_file_id_idx').on(t.costEvidenceFileId),
    check('bids_amount_cents_check', sql`${t.amountCents} >= 0`),
    check(
      'bids_status_check',
      sql`${t.status} in ('draft', 'submitted', 'complete', 'accepted', 'rejected', 'withdrawn', 'expired')`,
    ),
  ],
);

export type Bid = typeof bids.$inferSelect;
export type NewBid = typeof bids.$inferInsert;

export type VendorJobStatus = 'scheduled' | 'in_progress' | 'completed' | 'verified' | 'cancelled' | 'disputed';

export const vendorJobs = pgTable(
  'vendor_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    bidId: uuid('bid_id')
      .notNull()
      .references(() => bids.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    contractReference: text('contract_reference'),
    status: text('status').notNull().default('scheduled').$type<VendorJobStatus>(),
    scheduledStartDate: date('scheduled_start_date'),
    scheduledCompletionDate: date('scheduled_completion_date'),
    actualStartDate: date('actual_start_date'),
    actualCompletionDate: date('actual_completion_date'),
    finalCostCents: bigint('final_cost_cents', { mode: 'number' }),
    verifiedBy: uuid('verified_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    verifiedAt: tsTz('verified_at'),
    // FK to evidence_files added by later `alter table` in the migration.
    verificationEvidenceFileId: uuid('verification_evidence_file_id'),
  },
  (t) => [
    index('vendor_jobs_issue_id_idx').on(t.issueId),
    index('vendor_jobs_bid_id_idx').on(t.bidId),
    index('vendor_jobs_vendor_id_idx').on(t.vendorId),
    index('vendor_jobs_status_idx').on(t.status),
    index('vendor_jobs_verification_evidence_file_id_idx').on(t.verificationEvidenceFileId),
    check('vendor_jobs_final_cost_cents_check', sql`${t.finalCostCents} >= 0`),
    check(
      'vendor_jobs_status_check',
      sql`${t.status} in ('scheduled', 'in_progress', 'completed', 'verified', 'cancelled', 'disputed')`,
    ),
  ],
);

export type VendorJob = typeof vendorJobs.$inferSelect;
export type NewVendorJob = typeof vendorJobs.$inferInsert;

export type ChangeOrderStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';

export const changeOrders = pgTable(
  'change_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    vendorJobId: uuid('vendor_job_id')
      .notNull()
      .references(() => vendorJobs.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    description: text('description').notNull(),
    amountDeltaCents: bigint('amount_delta_cents', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('proposed').$type<ChangeOrderStatus>(),
    requestedBy: uuid('requested_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    approvedBy: uuid('approved_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    approvedAt: tsTz('approved_at'),
    // FK to evidence_files added by later `alter table` in the migration.
    evidenceFileId: uuid('evidence_file_id'),
  },
  (t) => [
    unique('change_orders_vendor_job_id_version_unique').on(t.vendorJobId, t.version),
    index('change_orders_vendor_job_id_idx').on(t.vendorJobId),
    index('change_orders_status_idx').on(t.status),
    index('change_orders_evidence_file_id_idx').on(t.evidenceFileId),
    check('change_orders_status_check', sql`${t.status} in ('proposed', 'approved', 'rejected', 'superseded')`),
  ],
);

export type ChangeOrder = typeof changeOrders.$inferSelect;
export type NewChangeOrder = typeof changeOrders.$inferInsert;

export type CostClassification =
  | 'estimated'
  | 'bid'
  | 'committed'
  | 'approved'
  | 'invoiced'
  | 'paid'
  | 'additional_outside_contract'
  | 'disputed'
  | 'recoverable'
  | 'customer_chargeable'
  | 'waived'
  | 'written_off';

export const costEntries = pgTable(
  'cost_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    vendorJobId: uuid('vendor_job_id').references(() => vendorJobs.id, { onDelete: 'restrict' }),
    classification: text('classification').notNull().$type<CostClassification>(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => personRefs.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    effectiveDate: date('effective_date').notNull().default(sql`current_date`),
  },
  (t) => [
    index('cost_entries_issue_id_idx').on(t.issueId),
    index('cost_entries_vendor_job_id_idx').on(t.vendorJobId),
    index('cost_entries_classification_idx').on(t.classification),
    check('cost_entries_amount_cents_check', sql`${t.amountCents} >= 0`),
    check(
      'cost_entries_classification_check',
      sql`${t.classification} in ('estimated', 'bid', 'committed', 'approved', 'invoiced', 'paid', 'additional_outside_contract', 'disputed', 'recoverable', 'customer_chargeable', 'waived', 'written_off')`,
    ),
  ],
);

export type CostEntry = typeof costEntries.$inferSelect;
export type NewCostEntry = typeof costEntries.$inferInsert;

export type PaymentRequestStatus =
  | 'draft'
  | 'submitted'
  | 'needs_information'
  | 'approved'
  | 'scheduled'
  | 'paid'
  | 'partially_paid'
  | 'denied'
  | 'cancelled'
  | 'voided';

export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    vendorJobId: uuid('vendor_job_id').references(() => vendorJobs.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    invoiceNumber: text('invoice_number'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    // FK to evidence_files added by later `alter table` in the migration.
    sourceDocumentEvidenceFileId: uuid('source_document_evidence_file_id'),
    status: text('status').notNull().default('draft').$type<PaymentRequestStatus>(),
    requestedBy: uuid('requested_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    approvedBy: uuid('approved_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    paidAt: tsTz('paid_at'),
    denialReason: text('denial_reason'),
    likelyDuplicateOf: uuid('likely_duplicate_of'),
  },
  (t) => [
    index('payment_requests_issue_id_idx').on(t.issueId),
    index('payment_requests_vendor_job_id_idx').on(t.vendorJobId),
    index('payment_requests_vendor_id_idx').on(t.vendorId),
    index('payment_requests_status_idx').on(t.status),
    index('payment_requests_source_document_evidence_file_id_idx').on(t.sourceDocumentEvidenceFileId),
    // Partial unique guard: same vendor + invoice number cannot have more
    // than one payment request outside denied/cancelled/voided.
    uniqueIndex('payment_requests_vendor_invoice_dup_guard_idx')
      .on(t.vendorId, t.invoiceNumber)
      .where(sql`${t.invoiceNumber} is not null and ${t.status} not in ('denied', 'cancelled', 'voided')`),
    check('payment_requests_amount_cents_check', sql`${t.amountCents} >= 0`),
    check(
      'payment_requests_status_check',
      sql`${t.status} in ('draft', 'submitted', 'needs_information', 'approved', 'scheduled', 'paid', 'partially_paid', 'denied', 'cancelled', 'voided')`,
    ),
  ],
);

export type PaymentRequest = typeof paymentRequests.$inferSelect;
export type NewPaymentRequest = typeof paymentRequests.$inferInsert;

// payment_requests.likely_duplicate_of -> payment_requests.id is a
// self-referential FK in the SQL, declared inline there (not a deferred
// alter table). Drizzle allows a self-reference via a getter; add it here
// so the TS type carries the relation without breaking table definition
// order (the table object exists by the time this module finishes
// evaluating, so the lazy callback resolves fine at runtime).
// NOTE: left as a plain uuid column above (no `.references()`) to avoid a
// self-referential TS type issue in some drizzle-orm versions; the DB-level
// FK is authoritative and defined in the migration.

export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    requestedAction: text('requested_action').notNull(),
    thresholdRule: text('threshold_rule'),
    objectTable: text('object_table').notNull(),
    objectId: uuid('object_id').notNull(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => personRefs.id, { onDelete: 'restrict' }),
    approverId: uuid('approver_id').references(() => personRefs.id, { onDelete: 'restrict' }),
    decision: text('decision').notNull().default('pending').$type<ApprovalDecision>(),
    decidedAt: tsTz('decided_at'),
    decisionReason: text('decision_reason'),
  },
  (t) => [
    index('approvals_requester_id_idx').on(t.requesterId),
    index('approvals_approver_id_idx').on(t.approverId),
    index('approvals_decision_idx').on(t.decision),
    index('approvals_object_table_object_id_idx').on(t.objectTable, t.objectId),
    check('approvals_decision_check', sql`${t.decision} in ('pending', 'approved', 'rejected', 'withdrawn')`),
  ],
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;

// =====================================================================
// EVIDENCE / COMMS / DOCS
// =====================================================================

export type AccessClassification = 'internal' | 'restricted_legal' | 'restricted_financial';

export const evidenceFiles = pgTable(
  'evidence_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    // Self-referential FK (derivative -> original). Declared without
    // `.references()` at the Drizzle level to avoid a TS circular type on
    // the table's own definition; the DB-level FK is set in the migration.
    originalVersionId: uuid('original_version_id'),
    storageRef: text('storage_ref').notNull(),
    originalFilename: text('original_filename'),
    fileType: text('file_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    checksum: text('checksum'),
    capturedAt: tsTz('captured_at'),
    uploadedAt: tsTz('uploaded_at').notNull().defaultNow(),
    uploaderPersonRefId: uuid('uploader_person_ref_id').references(() => personRefs.id, {
      onDelete: 'restrict',
    }),
    sourceSystem: text('source_system'),
    deviceOrLocationMetadata: jsonb('device_or_location_metadata').notNull().default({}),
    providerId: text('provider_id'),
    accessClassification: text('access_classification')
      .notNull()
      .default('internal')
      .$type<AccessClassification>(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'restrict' }),
    propertyRefId: uuid('property_ref_id').references(() => propertyRefs.id, { onDelete: 'restrict' }),
    personRefId: uuid('person_ref_id').references(() => personRefs.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'restrict' }),
    archivedAt: tsTz('archived_at'),
    archivedReason: text('archived_reason'),
  },
  (t) => [
    index('evidence_files_original_version_id_idx').on(t.originalVersionId),
    index('evidence_files_uploader_person_ref_id_idx').on(t.uploaderPersonRefId),
    index('evidence_files_issue_id_idx').on(t.issueId),
    index('evidence_files_property_ref_id_idx').on(t.propertyRefId),
    index('evidence_files_person_ref_id_idx').on(t.personRefId),
    index('evidence_files_task_id_idx').on(t.taskId),
    index('evidence_files_access_classification_idx').on(t.accessClassification),
    index('evidence_files_archived_at_idx').on(t.archivedAt),
    check('evidence_files_size_bytes_check', sql`${t.sizeBytes} >= 0`),
    check(
      'evidence_files_access_classification_check',
      sql`${t.accessClassification} in ('internal', 'restricted_legal', 'restricted_financial')`,
    ),
  ],
);

export type EvidenceFile = typeof evidenceFiles.$inferSelect;
export type NewEvidenceFile = typeof evidenceFiles.$inferInsert;

export type CommunicationChannel = 'call' | 'text' | 'email' | 'voicemail' | 'notice' | 'other';
export type CommunicationDirection = 'inbound' | 'outbound';

export const communicationEvents = pgTable(
  'communication_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    channel: text('channel').notNull().$type<CommunicationChannel>(),
    direction: text('direction').notNull().$type<CommunicationDirection>(),
    providerSystem: text('provider_system'),
    providerEventId: text('provider_event_id'),
    occurredAt: tsTz('occurred_at').notNull(),
    fromPersonRefId: uuid('from_person_ref_id').references(() => personRefs.id, { onDelete: 'restrict' }),
    toPersonRefId: uuid('to_person_ref_id').references(() => personRefs.id, { onDelete: 'restrict' }),
    summary: text('summary'),
    evidenceFileId: uuid('evidence_file_id').references(() => evidenceFiles.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('communication_events_from_person_ref_id_idx').on(t.fromPersonRefId),
    index('communication_events_to_person_ref_id_idx').on(t.toPersonRefId),
    index('communication_events_occurred_at_idx').on(t.occurredAt),
    index('communication_events_evidence_file_id_idx').on(t.evidenceFileId),
    uniqueIndex('communication_events_provider_dedup_idx')
      .on(t.providerSystem, t.providerEventId)
      .where(sql`${t.providerSystem} is not null and ${t.providerEventId} is not null`),
    check('communication_events_channel_check', sql`${t.channel} in ('call', 'text', 'email', 'voicemail', 'notice', 'other')`),
    check('communication_events_direction_check', sql`${t.direction} in ('inbound', 'outbound')`),
  ],
);

export type CommunicationEvent = typeof communicationEvents.$inferSelect;
export type NewCommunicationEvent = typeof communicationEvents.$inferInsert;

export const communicationLinks = pgTable(
  'communication_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    communicationEventId: uuid('communication_event_id')
      .notNull()
      .references(() => communicationEvents.id, { onDelete: 'restrict' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'restrict' }),
    personRefId: uuid('person_ref_id').references(() => personRefs.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('communication_links_communication_event_id_idx').on(t.communicationEventId),
    index('communication_links_issue_id_idx').on(t.issueId),
    index('communication_links_task_id_idx').on(t.taskId),
    index('communication_links_person_ref_id_idx').on(t.personRefId),
    check(
      'communication_links_linked_to_something_check',
      sql`${t.issueId} is not null or ${t.taskId} is not null or ${t.personRefId} is not null`,
    ),
  ],
);

export type CommunicationLink = typeof communicationLinks.$inferSelect;
export type NewCommunicationLink = typeof communicationLinks.$inferInsert;

export type DeliveryMethod = 'mail' | 'email' | 'hand_delivery' | 'posting' | 'other';
export type NoticeStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'cured' | 'expired';

export const notices = pgTable(
  'notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    templateVersion: text('template_version').notNull(),
    recipientPersonRefId: uuid('recipient_person_ref_id')
      .notNull()
      .references(() => personRefs.id, { onDelete: 'restrict' }),
    addressUsed: text('address_used'),
    deliveryMethod: text('delivery_method').$type<DeliveryMethod>(),
    deliveryEvidenceFileId: uuid('delivery_evidence_file_id').references(() => evidenceFiles.id, {
      onDelete: 'restrict',
    }),
    sentAt: tsTz('sent_at'),
    cureDeadline: date('cure_deadline'),
    status: text('status').notNull().default('pending').$type<NoticeStatus>(),
  },
  (t) => [
    index('notices_issue_id_idx').on(t.issueId),
    index('notices_recipient_person_ref_id_idx').on(t.recipientPersonRefId),
    index('notices_delivery_evidence_file_id_idx').on(t.deliveryEvidenceFileId),
    index('notices_status_idx').on(t.status),
    index('notices_cure_deadline_idx').on(t.cureDeadline),
    check(
      'notices_delivery_method_check',
      sql`${t.deliveryMethod} is null or ${t.deliveryMethod} in ('mail', 'email', 'hand_delivery', 'posting', 'other')`,
    ),
    check(
      'notices_status_check',
      sql`${t.status} in ('pending', 'sent', 'delivered', 'failed', 'cured', 'expired')`,
    ),
  ],
);

export type Notice = typeof notices.$inferSelect;
export type NewNotice = typeof notices.$inferInsert;

export type ChecklistItemStatus =
  | 'required_missing'
  | 'present'
  | 'verified'
  | 'waived'
  | 'not_applicable'
  | 'superseded';

export const checklistItems = pgTable(
  'checklist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    phaseInstanceId: uuid('phase_instance_id')
      .notNull()
      .references(() => phaseInstances.id, { onDelete: 'restrict' }),
    checklistVersion: text('checklist_version').notNull(),
    itemKey: text('item_key').notNull(),
    label: text('label').notNull(),
    status: text('status').notNull().default('required_missing').$type<ChecklistItemStatus>(),
    evidenceFileId: uuid('evidence_file_id').references(() => evidenceFiles.id, { onDelete: 'restrict' }),
    waivedBy: uuid('waived_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    waivedReason: text('waived_reason'),
    verifiedBy: uuid('verified_by').references(() => personRefs.id, { onDelete: 'restrict' }),
    verifiedAt: tsTz('verified_at'),
  },
  (t) => [
    unique('checklist_items_phase_version_key_unique').on(t.phaseInstanceId, t.checklistVersion, t.itemKey),
    index('checklist_items_phase_instance_id_idx').on(t.phaseInstanceId),
    index('checklist_items_status_idx').on(t.status),
    index('checklist_items_evidence_file_id_idx').on(t.evidenceFileId),
    check(
      'checklist_items_status_check',
      sql`${t.status} in ('required_missing', 'present', 'verified', 'waived', 'not_applicable', 'superseded')`,
    ),
  ],
);

export type ChecklistItem = typeof checklistItems.$inferSelect;
export type NewChecklistItem = typeof checklistItems.$inferInsert;

// =====================================================================
// PLATFORM
// =====================================================================

export const configVersions = pgTable(
  'config_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    configKey: text('config_key').notNull(),
    versionLabel: text('version_label').notNull(),
    effectiveFrom: tsTz('effective_from').notNull().defaultNow(),
    effectiveTo: tsTz('effective_to'),
    description: text('description'),
  },
  (t) => [
    unique('config_versions_config_key_version_label_unique').on(t.configKey, t.versionLabel),
    index('config_versions_config_key_idx').on(t.configKey),
    index('config_versions_effective_from_idx').on(t.effectiveFrom),
    index('config_versions_effective_to_idx').on(t.effectiveTo),
  ],
);

export type ConfigVersion = typeof configVersions.$inferSelect;
export type NewConfigVersion = typeof configVersions.$inferInsert;

export const configEntries = pgTable(
  'config_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    configVersionId: uuid('config_version_id')
      .notNull()
      .references(() => configVersions.id, { onDelete: 'restrict' }),
    entryKey: text('entry_key').notNull(),
    entryValue: jsonb('entry_value').notNull(),
    retired: boolean('retired').notNull().default(false),
  },
  (t) => [
    unique('config_entries_config_version_id_entry_key_unique').on(t.configVersionId, t.entryKey),
    index('config_entries_config_version_id_idx').on(t.configVersionId),
    index('config_entries_entry_key_idx').on(t.entryKey),
  ],
);

export type ConfigEntry = typeof configEntries.$inferSelect;
export type NewConfigEntry = typeof configEntries.$inferInsert;

export type IntegrationDirection = 'inbound' | 'outbound' | 'bidirectional';
export type SyncStatus = 'pending' | 'synced' | 'error' | 'stale';

export const integrationIdentities = pgTable(
  'integration_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    objectTable: text('object_table').notNull(),
    objectId: uuid('object_id').notNull(),
    sourceSystem: text('source_system').notNull(),
    externalObjectType: text('external_object_type'),
    externalId: text('external_id').notNull(),
    direction: text('direction').notNull().default('inbound').$type<IntegrationDirection>(),
    idempotencyKey: text('idempotency_key'),
    syncStatus: text('sync_status').notNull().default('pending').$type<SyncStatus>(),
    lastAttemptAt: tsTz('last_attempt_at'),
    lastError: text('last_error'),
  },
  (t) => [
    unique('integration_identities_source_external_unique').on(
      t.sourceSystem,
      t.externalObjectType,
      t.externalId,
    ),
    index('integration_identities_object_table_object_id_idx').on(t.objectTable, t.objectId),
    index('integration_identities_source_system_idx').on(t.sourceSystem),
    index('integration_identities_sync_status_idx').on(t.syncStatus),
    check('integration_identities_direction_check', sql`${t.direction} in ('inbound', 'outbound', 'bidirectional')`),
    check('integration_identities_sync_status_check', sql`${t.syncStatus} in ('pending', 'synced', 'error', 'stale')`),
  ],
);

export type IntegrationIdentity = typeof integrationIdentities.$inferSelect;
export type NewIntegrationIdentity = typeof integrationIdentities.$inferInsert;

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    eventType: text('event_type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    sourceModule: text('source_module').notNull().default('property_operations'),
    payload: jsonb('payload').notNull().default({}),
    personRefId: uuid('person_ref_id').references(() => personRefs.id, { onDelete: 'set null' }),
    propertyRefId: uuid('property_ref_id').references(() => propertyRefs.id, { onDelete: 'set null' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    occurredAt: tsTz('occurred_at').notNull().defaultNow(),
    recordedAt: tsTz('recorded_at').notNull().defaultNow(),
    actor: text('actor'),
    correlationId: uuid('correlation_id'),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => [
    unique('domain_events_idempotency_key_unique').on(t.idempotencyKey),
    index('domain_events_event_type_idx').on(t.eventType),
    index('domain_events_person_ref_id_idx').on(t.personRefId),
    index('domain_events_property_ref_id_idx').on(t.propertyRefId),
    index('domain_events_issue_id_idx').on(t.issueId),
    index('domain_events_occurred_at_idx').on(t.occurredAt),
    index('domain_events_correlation_id_idx').on(t.correlationId),
  ],
);

export type DomainEvent = typeof domainEvents.$inferSelect;
export type NewDomainEvent = typeof domainEvents.$inferInsert;

export type ConsumedEventResult = 'processed' | 'skipped_duplicate' | 'error';

export const consumedEvents = pgTable(
  'consumed_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),
    updatedAt: tsTz('updated_at').notNull().defaultNow(),

    sourceSystem: text('source_system').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    processedAt: tsTz('processed_at').notNull().defaultNow(),
    result: text('result').notNull().default('processed').$type<ConsumedEventResult>(),
    errorDetail: text('error_detail'),
  },
  (t) => [
    unique('consumed_events_source_system_idempotency_key_unique').on(t.sourceSystem, t.idempotencyKey),
    index('consumed_events_source_system_idx').on(t.sourceSystem),
    index('consumed_events_processed_at_idx').on(t.processedAt),
    check(
      'consumed_events_result_check',
      sql`${t.result} in ('processed', 'skipped_duplicate', 'error')`,
    ),
  ],
);

export type ConsumedEvent = typeof consumedEvents.$inferSelect;
export type NewConsumedEvent = typeof consumedEvents.$inferInsert;

// audit_events — append-only: NO updated_at column, NO updated_at trigger.
// UPDATE/DELETE are rejected at the DB level by a trigger (see migration);
// Drizzle has no way to express "reject at DB level" — that's DB-only.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: tsTz('created_at').notNull().defaultNow(),

    actorId: uuid('actor_id').references(() => personRefs.id, { onDelete: 'set null' }),
    // Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — free
    // text, not a person_refs uuid (20260731090500_issues_rls_audit_hardening.sql).
    actorExternalId: text('actor_external_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    objectTable: text('object_table').notNull(),
    objectId: uuid('object_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    correlationId: uuid('correlation_id'),
    source: text('source'),
    occurredAt: tsTz('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_actor_id_idx').on(t.actorId),
    index('audit_events_object_table_object_id_idx').on(t.objectTable, t.objectId),
    index('audit_events_occurred_at_idx').on(t.occurredAt),
    index('audit_events_correlation_id_idx').on(t.correlationId),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
