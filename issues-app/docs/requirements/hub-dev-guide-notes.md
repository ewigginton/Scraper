# The Hub — Team Development Guide (transcription notes)

Transcribed from the scanned PDF "The Hub — Team Development Guide" (2026-07-28).
This document is treated as controlling for how code is delivered into the Hub.

## Setup and flow

- The Hub is one codebase on GitHub (`shwig1/the-hub`) that deploys automatically:
  merging to `main` deploys to production via Vercel. `main` is protected; all work
  happens on branches and enters `main` through a reviewed Pull Request.
- Approvers: Scott and Isaac are the code owners. One approval is required to merge.
- You CAN: clone and read all code; create branches and push freely; open PRs into
  main; get an automatic preview URL for every push; create/change tables in the
  DEV database.
- You CANNOT: push directly to main; merge without code-owner approval; force-push
  to or delete main; change repo settings; touch the production database or its
  credentials.
- One-time setup: accept the GitHub invite; verified git email; `npm install`;
  get `.env.local` from Scott (DEVELOPMENT database credentials — never commit,
  never share, never substitute other credentials); `npm run dev` →
  `http://127.0.0.1:4182/`.

## Daily workflow

1. Branch: `git checkout main && git pull`, then `git checkout -b feature/short-description`.
   One branch per task.
2. Work and commit on the branch; every push builds a private Vercel preview URL.
3. Stay current: pull main into the branch at least every day or two.
4. Validate before asking for review: `npm run validate` must pass.
5. Open a small, single-topic PR into main; describe it and paste the preview URL.
6. Scott or Isaac reviews; respond by pushing more commits to the same branch.
7. Once approved it merges and goes live automatically; delete the branch after.

Conflicts: `git pull origin main` on the branch, fix, commit, push. Never resolve a
conflict by deleting other people's code.

## Databases, new tables, migrations

- Develop against the dev database (`.env.local` points at the development Supabase
  project) — it is scratch space.
- The deliverable is a migration file: a timestamped SQL file in
  `supabase/migrations/`, named like `20260728120000_add_loan_tables.sql`,
  containing the CREATE TABLE / ALTER TABLE statements. Commit it in the same PR
  as the code that uses it.
- Migrations must replay cleanly: `npm run validate` replays every migration in
  timestamp order against a fresh database. If yours depends on a later-named one,
  rename yours to a later timestamp — never "fix" ordering any other way.
- You never touch production. When a PR is approved, Scott or Isaac applies the
  migration to production and merges. Production data moves/transforms are written
  as scripts in the PR for them to run.
- New app = same process; the PR is the request.
- Architecture note: keep database access behind repository/service modules per
  `AGENTS.md` — don't scatter Supabase calls through components. New repository
  modules use Drizzle (`lib/db/schema.ts`, regenerate with `npm run db:introspect`
  after schema changes).

## House rules

- Never commit secrets — no keys, passwords, or .env files. Accidental commit →
  tell Scott immediately (rotation required; deleting the commit is not enough).
- Never share or copy production credentials; need production data → ask (safe dev
  copy or Scott runs the step).
- Follow `AGENTS.md` in the repo root — authoritative for build commands,
  validation, and code conventions.
- AI-generated code is YOUR code — read and understand everything before review.
- Small PRs, merged often, beat big branches that live for weeks.
- Stuck for more than 30 minutes? Ask Isaac.
