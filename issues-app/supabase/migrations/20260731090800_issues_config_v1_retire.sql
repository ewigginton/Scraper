-- 20260731090800_issues_config_v1_retire.sql
-- Property Operations ("Issues") — fixes from adversarial review, batch 4:
-- explicitly retire config_versions version '1' of 'phase_1_defaults'. New
-- migration; does not edit 20260731090300 or 20260731090600.
--
-- ADVERSARIAL-REVIEW FINDING (maintainability): 20260731090600 superseded
-- v1 with v2 but never set v1's effective_to, so "v2 is current" was
-- guaranteed only by config-repo.ts's currentVersion() ordering
-- `effective_from DESC` tie-break (now `effective_from DESC, created_at
-- DESC, id DESC` — see the config-repo.ts fix in this same round) picking
-- the row with the later effective_from — true today only because the two
-- migrations run in separate statements/transactions and each used now()
-- at apply time, an INCIDENTAL guarantee (relies on wall-clock time
-- actually advancing between two migration files), not a structural one.
-- v1 still contains 19 prerequisite names with no implemented checker
-- (see 20260731090600's own header comment); if a future config_versions
-- insert/replay ever ties or reverses that ordering, v1 could silently
-- resurface as "current", and transitionPhase would throw
-- 'unimplemented_prerequisite' on real default_recovery/covenant_violation
-- cases in production rather than at deploy time.
--
-- This migration removes that dependency on ordering *for the two versions
-- that exist today* by giving v1 an explicit effective_to: with
-- effective_to set, v1 no longer matches currentVersion()'s WHERE clause
-- (`effective_to IS NULL OR effective_to > now()`) at all, regardless of
-- ordering, tie-breaks, or future clock issues.
update config_versions
set effective_to = (
  select v2.effective_from
  from config_versions v2
  where v2.config_key = 'phase_1_defaults' and v2.version_label = '2'
)
where config_key = 'phase_1_defaults'
  and version_label = '1'
  and effective_to is null;

comment on column config_versions.effective_to is
  'When set, this version is retired as of this timestamp regardless of any other version''s effective_from — see 20260731090800_issues_config_v1_retire.sql. A superseding config_versions insert SHOULD set the prior current version''s effective_to in the same migration/transaction going forward, rather than relying on currentVersion()''s ORDER BY tie-break alone.';
