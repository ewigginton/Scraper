-- 20260804110000_issues_audit_feed_indexes.sql
-- Wave 2a (communications/timeline data layer): composite indexes the new
-- lib/repositories/timeline-repo.ts and lib/repositories/audit-metrics-repo.ts
-- query shapes need on `audit_events`, verified missing against every
-- landed migration before being added here. New migration; does not edit
-- any landed file.
--
-- Existing audit_events indexes (20260731090100_issues_work_platform.sql):
--   audit_events_actor_id_idx            (actor_id)
--   audit_events_object_table_object_id_idx (object_table, object_id)
--   audit_events_occurred_at_idx         (occurred_at)
--   audit_events_correlation_id_idx      (correlation_id)
-- None of these is a composite covering (object_table, object_id,
-- occurred_at) together, and none covers actor_external_id at all (that
-- column was added later, by 20260731090500_issues_rls_audit_hardening.sql,
-- after the indexes above were created) — confirmed by grepping every
-- migration file for "create index" against audit_events.

-- timeline-repo.ts's issueTimeline/personTimeline fetch every audit_events
-- row for a bounded set of object ids (issue itself, its tasks/holds/
-- phase_instances, or a person's own object rows) via
-- `object_table = :t AND object_id IN (:ids)`, then sort by occurred_at
-- DESC — the existing (object_table, object_id) index supports the
-- equality+IN lookup but the sort still requires a separate step without
-- occurred_at in the index. Appending it (DESC, matching every other
-- occurred_at-ordered feed in this schema) lets that sort be satisfied
-- from the index directly.
create index audit_events_object_table_object_id_occurred_at_idx
  on audit_events (object_table, object_id, occurred_at desc);

-- audit-metrics-repo.ts's recentActivity filters the global feed by actor
-- (matching actor_external_id — the Hub staff identity string every
-- command actually populates, per 20260731090500's own comment: actor_id is
-- the rarer person_refs-linked case) and orders by occurred_at DESC for
-- keyset pagination. No index at all currently covers actor_external_id.
create index audit_events_actor_external_id_occurred_at_idx
  on audit_events (actor_external_id, occurred_at desc);
