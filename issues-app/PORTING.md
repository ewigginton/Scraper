# Porting Issues into the Hub (`shwig1/CCL` / `shwig1/the-hub`)

This package was built in a session that had no access to the Hub repository
(cross-owner repo access is not available from a Scraper-repo session). Everything
here follows the Hub Team Development Guide so the move is mechanical.

## What moves where

| This package | Hub destination |
| --- | --- |
| `supabase/migrations/*.sql` | Hub `supabase/migrations/` — **rename each file's timestamp to be later than the newest existing Hub migration** (dev-guide rule: ordering is fixed by renaming to a later timestamp, never any other way). |
| `lib/db/schema.ts` | Merge into Hub `lib/db/schema.ts` (or keep as `lib/db/issues-schema.ts` and re-export) — then run `npm run db:introspect` per the guide. |
| `lib/repositories/*` | Hub `lib/repositories/` (naming per Hub `AGENTS.md`). |
| `lib/services/*` | Hub `lib/services/` — server-side only. |
| `lib/auth/current-user.ts` | **Delete**; replace call sites with the Hub's shared staff identity/session helper. Issues must not have its own auth (Master Vision §30.1). |
| `app/(issues)/*` | Hub app routes under the Hub's tile/navigation convention. |
| `test/*` | Hub test tree; keep the PGlite migration-replay test wired into `npm run validate`. |
| `docs/*` | Hub docs, or the PR description. |

## Wave 2 additions (this package now includes, beyond Phase 1)

The table above and the PR strategy below are path-based and already cover
these mechanically, but they are called out explicitly here so a Hub
reviewer doesn't have to discover Wave 2's existence by diffing file lists:

- **Migrations:** `supabase/migrations/20260804100000_issues_scale_indexes_search_views.sql`
  (saved_views table + search/keyset indexes), `20260804110000_issues_audit_feed_indexes.sql`,
  `20260804120000_issues_contract_refs.sql` (contract_refs table), and
  `20260804130000_issues_search_expansion_indexes.sql` — rename timestamps
  per the rule above, same as every other migration in this package.
- **Tables:** `contract_refs`, `saved_views` (see `docs/data-dictionary.md`
  and `docs/erd.md`, both updated for Wave 2).
- **Repositories:** `lib/repositories/timeline-repo.ts`,
  `lib/repositories/audit-metrics-repo.ts`, `lib/repositories/people-repo.ts`,
  `lib/repositories/contract-refs-repo.ts`, `lib/repositories/saved-views-repo.ts`,
  `lib/repositories/dashboard-repo.ts`, `lib/repositories/exceptions-repo.ts`
  (comms-repo.ts/issues-query-repo.ts predate Wave 2 but gained Wave 2
  filter/date-range fields).
- **Routes:** `/issues` (All Issues database view — filters/sort/search/saved
  views), `/issues/[id]/timeline`, `/people`, `/people/[id]`, `/activity`,
  `/admin/activity`, `/dashboard`, `/exceptions`, `/contracts/[id]`.
- **Demo data:** `scripts/demo-seed-comms.ts` (fictional communication_events
  seeded on top of `scripts/demo-seed.ts`'s base fixtures).

## PR strategy (dev guide: small, single-topic PRs)

Suggested series, each independently reviewable:
1. Migrations + Drizzle schema + seed config (no UI). PR body: data dictionary + ERD.
2. Services (transition engine, eligibility, holds, audit) + tests.
3. RLS policies + permission matrix doc (flag for Scott — security surface;
   central RLS program D17 is the eventual authority).
4. UI screens (task list, case view, intake) + preview URL.
5. Wave 2 data layer: `contract_refs`/`saved_views` migrations + the
   timeline/audit-metrics/people/contract-refs/saved-views/dashboard/
   exceptions repositories + tests.
6. Wave 2 UI: `/issues` database view, `/issues/[id]/timeline`, `/people`,
   `/people/[id]`, `/activity`, `/admin/activity`, `/dashboard`,
   `/exceptions`, `/contracts/[id]` + preview URL.

## Before opening PRs

- Read Hub `AGENTS.md` and align naming/conventions — it is authoritative and was
  not visible when this package was authored.
- Point `.env.local` at the DEV Supabase project from Scott. Never production.
- Whatever role `DATABASE_URL` authenticates as, it must NOT be a superuser or
  BYPASSRLS role (Supabase's default `postgres` role is BYPASSRLS) — that
  silently disables every RLS policy in this schema. This package's own
  migrations provision an `issues_app` role for exactly this
  (`supabase/migrations/20260731090700_issues_app_role_grants.sql`); confirm
  the Hub's equivalent role is also `nosuperuser nobypassrls`, and that
  `app/api/health`'s `rolsuper`/`rolbypassrls` assertion stays wired in
  after porting.
- `npm run validate` in the Hub must pass with the renamed migrations.
- The `domain_events` table here is an outbox seed; if the Hub has already
  promoted `cadence_events` → `domain_events` (Master Vision D18), drop ours and
  target the governed table/registry instead — event names/schemas need Scott's
  sign-off either way.
- Reconcile `property_refs`/`person_refs` with any canonical tables that already
  exist in the Hub (they are read-model references by design; if canonical
  `core_*` person/property tables exist, swap the FKs to point at them and delete
  the refs tables).
