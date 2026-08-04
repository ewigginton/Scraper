# Issues (Property Operations)

A Hub tile that manages foreclosure/recovery/cleanup cases for a land
company: default recovery, market readiness, property legal matters, buyer
cleanup, and covenant violations. Its safety core: no property may pass
release while an active hold, unresolved possession, or unverified cleanup
exists, and the app never writes inventory availability, website status,
loan, sales, or accounting-paid facts (one writer per fact).

This is Phase 1: it runs standalone (`npm run dev`) against any
Postgres/Supabase dev database so it can be demonstrated and reviewed before
being ported into the Hub monorepo (see `PORTING.md`).

## Prerequisites

- Node.js and npm
- A Postgres (or Supabase) database reachable via a connection string

## Quick start

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL to your dev database
npm run dev                  # http://localhost:4182
```

### Even faster: zero-setup local demo

No Postgres/Supabase install, no credentials, no `.env.local` needed:

```bash
npm install
npm run demo                 # http://127.0.0.1:4182
```

Builds a persisted PGlite (Postgres-in-WASM) database at `.demo-db/` via
`scripts/demo-seed.ts` (real service-layer writes — every row passes the
same validation/auditing as production data) and starts the dev server
against it with `ISSUES_DEMO=1`. Pass `npm run demo -- --fresh` to rebuild
the demo data from scratch. Dev/demo only — never part of the Hub port (see
`PORTING.md`) and never pointed at a real database. To also see fictional
communications on case/person timelines, run
`node --experimental-strip-types scripts/demo-seed-comms.ts` once the demo
database exists.

`DATABASE_URL` must authenticate as a role with `nosuperuser nobypassrls`
(never the migration-owner/superuser role) — a superuser or BYPASSRLS
connection silently disables every RLS policy in this schema. Migration
`supabase/migrations/20260731090700_issues_app_role_grants.sql` provisions
the `issues_app` role for exactly this; point `DATABASE_URL` at it.
`app/api/health` asserts this at runtime and fails loudly if misconfigured.

`lib/auth/current-user.ts` is a development-only auth stub (no login of any
kind — Property Operations must never have its own auth surface). It
refuses to run outside `NODE_ENV=development` unless
`ISSUES_ALLOW_AUTH_STUB=true` is explicitly set, which is meant only for a
reviewable, unauthenticated demo deployment.

## Validation

```bash
npm run validate   # typecheck + test + build, in that order
```

Individually:

```bash
npm run typecheck  # tsc --noEmit
npm test           # vitest run — spins up a fresh @electric-sql/pglite
                    # (Postgres-in-WASM) instance per test file and replays
                    # every migration under supabase/migrations/ in order
npm run build       # next build
```

## Project structure

| Path | What lives here |
| --- | --- |
| `supabase/migrations/` | Schema, RLS policies, seed config-as-data. Replayed in timestamp (filename) order — never edit a landed migration, only add new ones. |
| `lib/db/schema.ts` | Drizzle schema for every table. |
| `lib/repositories/` | Plain DB access — no business rules. |
| `lib/services/` | The command layer: every mutation goes through here, audited in-transaction, idempotent for consumed/retried events. |
| `lib/db/actor-context.ts` | Sets the session-local GUCs the RLS policies read; every authenticated read/write must go through this (`withActor`). |
| `lib/auth/current-user.ts` | Dev-only identity stub; replaced by the Hub's shared staff identity at deployment. |
| `app/actions.ts` | Server actions backing the screens — the only place `lib/services` is called from the UI. |
| `app/page.tsx`, `app/issues/[id]/page.tsx` | Personal work screen and case view. |
| `app/api/health/route.ts` | Health check, including the RLS-bypass guard above. |
| `test/` | Vitest + PGlite. `test/helpers/pglite.ts` spins up the DB fixture every other test file uses. |
| `docs/requirements/` | Full spec, master vision, and Hub dev guide this package was built against. |
| `docs/data-dictionary.md` | Schema reference, kept in sync with migrations. |

See `DESIGN.md` for the controlling design (hard rules, module boundaries,
event/idempotency model) and `PORTING.md` for how this package moves into
the Hub monorepo.
