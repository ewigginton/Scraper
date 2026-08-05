# Local-session handoff — Issues (Property Operations)

For any Claude Code session (local or cloud) picking up this project.
Written 2026-08-05 at the close of the cloud build+review campaign.

## State of the world

- **The product** lives in `issues-app/` on branch
  `claude/issues-app-operations-crm-eehgog` of ewigginton/Scraper (public;
  PR #28 tracks it). Review-certified: 5 adversarial rounds + close-out,
  42 defects fixed, 481/481 tests across 42 files, typecheck + build green.
- **Controlling docs** (read in this order): `DESIGN.md` (architecture +
  hard rules), `PORTING.md` (port plan incl. Hub recon findings, ops_
  rename map, decided reconciliations), `docs/roadmap-waves.md` (Waves 3/4
  scope from Emma: Attio record pages, boards, Cmd+K, inline editing,
  Tremor system, breadcrumbs, steppers, change-log everywhere),
  `docs/integrations/google-chat-ingestion.md` (contract draft for Scott),
  `docs/requirements/` (the spec, master vision, Hub dev guide).
- **Demo:** `npm install && npm run demo` → http://127.0.0.1:4182
  (embedded DB, fictional data; then stop the server and run
  `node --experimental-strip-types scripts/demo-seed-comms.ts` for
  message timelines; `npm run demo -- --fresh` resets).
- **Validation:** `npm run validate` (typecheck + vitest + build) must be
  green before any push. House rules in the repo root `CLAUDE.md` and
  `docs/roadmap-waves.md` "Standing constraints".

## Decisions already made (do not relitigate)

- Table naming: `ops_` prefix per the definitive rename map in PORTING.md.
- RLS role: reuse the Hub's `hub_staff` (drop `issues_app` at port).
- Use Hub canonical tables (`core_persons`, `site_tracts`,
  `cadence_contracts`/`lsp_accounts`, `cadence_communications`); drop the
  ref tables at port. `ops_communication_links` survives as the one join
  Cadence doesn't model (prefix = writer).
- Routes nest under `app/issues/...`; auth via Hub `currentUser()` +
  `canAccess` + page-access guard; dates via `formatAppDate()`; CSS into
  the Hub's `app/styles` system.

## Open items (the actual work queue)

1. **CCL PR #142** (emma preview allowlist): Scott requested the Fable
   attestation; Emma's EMAILED reply bounced (Outlook→GitHub postmaster
   failure) so it never posted. Post the 5/5 attestation directly on the
   PR thread. Never reply to GitHub by email.
2. **The port**: execute PORTING.md against the Hub repo — ops_ rename
   pass, canonical-table swap, hub_staff alignment, route nesting,
   migration re-timestamping (re-check newest Hub timestamp first; two
   known filename collisions), fold into Hub `npm run validate` — then
   open the six-PR series. Scott pre-sign-offs needed: `ops_` naming nod
   + domain_events event names/schemas.
3. **Attestation gate**: Scott's queue requires a pre-submission Fable
   review rated 5/5 (or rated waiver) on every PR — this package's review
   evidence is in the git history (commits ~Aug 4-5) for the attestation
   note.
4. **After the port lands**: Waves 3/4 per docs/roadmap-waves.md, then
   the Hub-integration phase (JustCall/Gmail/Google Chat per the contract
   draft — Emma's priority: selective thread-capture first).

## Local-session notes

- A LOCAL session in the Hub clone (e.g. ~/Documents/CCL) uses the
  machine's own git/GitHub credentials — Emma can push branches and open
  CCL PRs directly (the cloud cross-owner limit does not apply locally).
  Still NEVER push to main; branch + PR per the Hub dev guide.
- The Hub dev DB: `.env.local` from Scott (DEV Supabase only, never
  production; non-BYPASSRLS connection for Issues paths per PORTING.md).
- A recurring 30-minute email check for PR feedback runs in the original
  cloud session (skill: `.claude/skills/check-pr-feedback/SKILL.md`) —
  it watches Gmail for approvals/kick-backs/bounces and reports to Emma.
