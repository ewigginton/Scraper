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

## Hub reconnaissance findings (2026-08-04, CCL-scoped session) — SUPERSEDES older guesses above where they conflict

A read-only recon of the actual Hub repo produced these port requirements.
The port session should treat this section + the recon report as controlling.

1. **Migrations:** newest Hub timestamp at recon time was
   `20260804130000_add_action_execution_owner_recorder.sql`; TWO incoming
   files collide exactly (`20260804100000_issues_scale_indexes_search_views`
   and `20260804130000_issues_search_expansion_indexes`). Re-check the
   newest timestamp AT PORT TIME (multiple migrations land per day) and
   rename ALL incoming files later. Verify via the Hub's
   `check:migrations-replay`.
2. **Table naming (needs Scott's decision before PR 1):** Hub convention is
   domain prefixes (`cadence_*`, `lsp_*`, `site_*`, `core_*`) or a
   dedicated Postgres schema (`messages.*`). Bare `issues`/`tasks`/`holds`/
   `audit_events`/`saved_views`/`config_versions` break it — `audit_events`
   worst (five per-domain audit tables already exist). Options: `issues_`
   prefix or an `issues.` schema. The rename is a scripted pass over the
   SQL + schema + code identifiers — mechanical, but do it before PR 1.
3. **domain_events:** the Hub already promoted `cadence_events` →
   `domain_events` (stage 1, with `domain_event_jobs` and
   `domain_event_subscriptions`). Drop our outbox table entirely; retarget
   publishes at the governed tables; event names/schemas need Scott's
   sign-off (as already stated above).
4. **Refs reconciliation:** canonical person spine EXISTS (`core_persons` +
   emails/phones/alt_names/external_ids). Point `person_refs.person_id` at
   `core_persons` (or replace the ref table — Scott's call). Property spine:
   `site_tracts` (+ developments/phases/states); contracts:
   `cadence_contracts`/`lsp_accounts`. Same swap-or-keep decision each.
5. **Auth:** replace `lib/auth/current-user.ts` with the Hub's
   `currentUser()` from `lib/session` + `canAccess(user, "<dashboard-id>")`,
   with a `page-access.ts` guard per the loans-app pattern (guard at layout
   AND per-page — Next can render a child before the layout guard).
6. **Routes:** nest EVERYTHING under one subtree (`app/issues/...`) per the
   loans-app full-page-app pattern. Our top-level `/people`, `/activity`,
   `/dashboard`, `/exceptions`, `/contracts` must move (`/issues/people`,
   etc.) — they'd squat shared Hub namespace otherwise.
7. **Tile registration (three touches):** dashboards entry in
   `lib/config.ts` (`source: "static"`), id in `TOP_LEVEL_DASHBOARD_IDS`
   in `lib/access.ts`, label in `lib/dashboard-app/constants.ts`.
8. **RLS role:** the Hub's RLS program already provisions `hub_staff`
   (LOGIN, NOSUPERUSER, NOBYPASSRLS, drift-checked) with
   `HUB_STAFF_DATABASE_URL` + `hub-staff-tx.ts` setting a transaction-local
   `hub.actor_email` GUC — currently dark. Align our `issues_app` role +
   `app.actor_id`/`app.roles` GUCs with that program (reuse `hub_staff` or
   register `issues_app` as a phase-0 sibling). Keep our `/api/health`
   rolbypassrls assertion — no Hub health route exists; it's net-new value.
   WARNING: the Hub's default `DATABASE_URL` (`postgres`) and
   `service_role` are both BYPASSRLS — Issues paths must not use them.
9. **Drizzle schema:** the Hub's `lib/db/schema.ts` is generated via
   `npm run db:introspect` — do NOT hand-merge ours; apply migrations then
   introspect (keep ours only as a reference/re-export if Scott prefers).
10. **Comms:** the Hub normalizes telephony in `cadence_communications` +
    `cadence_timeline_events` (JustCall/CloudTalk/PandaDoc land there
    TODAY). Our `communication_events` must consume from Cadence — never a
    second writer for the same facts. This accelerates timelines: real
    comms data exists already.
11. **UI conventions:** `formatAppDate()`/`formatAppDateTime()` (MM-DD-YY)
    from `lib/date-format.ts` — no toLocaleDateString; CSS into the
    `app/styles` lazy-chunk system (never globals.css); shadcn components
    are the Hub default; light+dark.
12. **Validation:** fold into the Hub's `npm run validate` (lint, knip,
    `check:script-imports` — our seed scripts already use relative `.ts`
    imports, verify anyway; merge our replay test into
    `check:migrations-replay` rather than a parallel harness).
13. **Foreclosure boundary:** the public foreclosure marketing page is
    manually curated and decoupled — nothing in Issues auto-publishes to it.

Scott sign-offs needed before PR 1: table naming (item 2), event
names/schemas (item 3), refs swap-or-keep (item 4), role alignment (item 8).
