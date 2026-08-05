-- 20260731090700_issues_app_role_grants.sql
-- Property Operations ("Issues") — fixes from adversarial review, batch 4:
-- provision the application's own database role. New migration; does not
-- edit any landed file.
--
-- ADVERSARIAL-REVIEW FINDING (P1): the migrations up to this point contain
-- zero GRANT/CREATE ROLE statements, so the only role that can run this
-- application at all is the table owner (the role that applied these
-- migrations) or a superuser. On Supabase the default `postgres` role
-- carries rolbypassrls, which silently disables the entire RLS scaffold —
-- every case-table write policy, the evidence_files classification policy,
-- and the audit_events append-only policies (see 20260731090200_issues_rls.sql
-- and 20260731090500_issues_rls_audit_hardening.sql, both of which are
-- inert on a BYPASSRLS connection). test/rls.test.ts had to hand-create a
-- test-only role in `beforeEach` precisely because nothing in the repo
-- provisioned one; this migration is that provisioning, applied for real.
--
-- `nobypassrls` is the default for a freshly created role (Postgres does
-- not grant BYPASSRLS unless asked), stated explicitly here anyway so the
-- intent is unambiguous to a future reader/migration.
--
-- No DELETE is granted anywhere: no table in this schema has a DELETE
-- policy (audit_events/domain_events/consumed_events are append-only by
-- design; every other table's rows are retired/soft-closed via an UPDATE,
-- e.g. issues.lifecycle_status, holds.released_at, not removed).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'issues_app') then
    create role issues_app nologin nosuperuser nobypassrls;
  end if;
end;
$$;

grant usage on schema public to issues_app;
grant select, insert, update on all tables in schema public to issues_app;
grant usage, select on all sequences in schema public to issues_app;
grant execute on function issues_current_actor() to issues_app;
grant execute on function issues_current_roles() to issues_app;

-- Future tables/sequences created by later migrations (run by the owner
-- role, the same role that must issue this ALTER DEFAULT PRIVILEGES so it
-- applies to objects THAT role creates) automatically pick up the same
-- select/insert/update-only grant, so a forgotten GRANT statement in a
-- future migration does not silently leave issues_app unable to reach a
-- new table (or, worse, someone reaching for a broader ad hoc grant).
alter default privileges in schema public grant select, insert, update on tables to issues_app;
alter default privileges in schema public grant usage, select on sequences to issues_app;

comment on role issues_app is
  'The only role Property Operations'' own DATABASE_URL should ever authenticate as (see .env.example, PORTING.md). nosuperuser/nobypassrls so every RLS policy in 20260731090200_issues_rls.sql / 20260731090500_issues_rls_audit_hardening.sql actually governs this connection, unlike the table-owner/superuser connection this app has run on to date. No DELETE grant: nothing in this schema is hard-deleted by the application.';
