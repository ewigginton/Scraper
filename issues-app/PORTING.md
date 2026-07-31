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

## PR strategy (dev guide: small, single-topic PRs)

Suggested series, each independently reviewable:
1. Migrations + Drizzle schema + seed config (no UI). PR body: data dictionary + ERD.
2. Services (transition engine, eligibility, holds, audit) + tests.
3. RLS policies + permission matrix doc (flag for Scott — security surface;
   central RLS program D17 is the eventual authority).
4. UI screens (task list, case view, intake) + preview URL.

## Before opening PRs

- Read Hub `AGENTS.md` and align naming/conventions — it is authoritative and was
  not visible when this package was authored.
- Point `.env.local` at the DEV Supabase project from Scott. Never production.
- `npm run validate` in the Hub must pass with the renamed migrations.
- The `domain_events` table here is an outbox seed; if the Hub has already
  promoted `cadence_events` → `domain_events` (Master Vision D18), drop ours and
  target the governed table/registry instead — event names/schemas need Scott's
  sign-off either way.
- Reconcile `property_refs`/`person_refs` with any canonical tables that already
  exist in the Hub (they are read-model references by design; if canonical
  `core_*` person/property tables exist, swap the FKs to point at them and delete
  the refs tables).
