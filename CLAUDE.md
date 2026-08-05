# CCL Land Scraper

## Working rules (apply in every session)

### Orchestration — standing opt-in, don't ask
- Substantive build/fix/design/research work runs through the **Workflow tool** by default
  (multi-agent, deterministic orchestration). Emma never needs to say "use the workflow" —
  it's assumed. Solo work only for conversation, trivial one-line edits, and actions that
  require her explicit go.
- **Orchestrator seat = Fable (the session model).** Fable holds the thinking seats ONLY —
  decomposition, lane/model selection, spec/prompt-writing, final diff review, and
  merging/synthesizing the lanes' work — and never takes a lane itself; lanes run on
  Haiku/Sonnet/Opus per the ladder below. Fable's end-of-run review is the integration pass
  on top of (not instead of) the verification ladder. If the session isn't running Fable,
  say so at the first workflow launch rather than silently proceeding.
- **At every workflow launch, report the plan as a table: lane → model → effort.** Always,
  unasked. Fable appears as TWO rows so Emma sees it bookending the run: "Fable — plan &
  instruct" first, "Fable — final review & merge" last.
- **At every workflow completion, report the same lane → model → effort table with actuals,
  including tokens burned per lane, a per-engine total, and the run's wall-clock duration.**
  Lane token counts and duration come from the harness's task output (per-agent tokens and
  the run's duration) — read and aggregate them, never estimate. Fable's orchestrator-seat
  usage isn't separately metered; say so rather than inventing a number. Hand-authored
  workflows must log() the lane plan at launch (visible live in /workflows) and return a
  `lanes` roster in their result.

### Model & effort ladder (per lane, inside workflows)
- **Haiku (low/med):** mechanical single-shot lanes with checkable outputs — probes, counts,
  test-rerun-and-summarize, screenshots, batch sweeps, triage. Earns most on volume (10+
  lanes). Never: adversarial verify, root-causing, design, security, long autonomous chains.
- **Sonnet (low→high):** docs, pattern-copies, well-specified modules with tests, standard
  verification.
- **Opus (high):** substantial implementation, security surfaces, adversarial verification.
- **Opus (xhigh):** design judges and the hardest single judgment calls. Escalation attaches
  to the task, never to the session.
- The orchestrator seat handles decomposition, spec-writing, diff review before shipping,
  synthesis, and talking to Emma.

### Verification ladder (match effort to blast radius)
- Security boundaries / production-data mutations / money-or-cost math → **adversarial
  Opus** verify (instructed to REFUTE), never cheaper.
- New features / net-new UI → **one** Sonnet or Haiku independent verifier with
  rendered/behavioral proof.
- Pattern-copies of a proven template → no separate verifier; implementer's tests +
  orchestrator diff review.
- Verifiers attribute failures honestly: NEW vs pre-existing (rerun on the untouched
  baseline when unsure).
- Batched gates: typecheck per commit; the expensive suites (full tests, builds, browser
  runs) once per lane at the end, not after every sub-step. A red verify lane repeats the
  phase — the bar doesn't drop to save time.

### Hard lines
- **Production writes are never delegated to agents.** The orchestrator runs them inline,
  dry-run first, with Emma's explicit go in chat.
- Agents never clobber concurrent work: `git status` before editing a file; uncommitted
  changes from another session = STOP and report.
- Never invent numbers — an honest "unavailable" beats a fabricated estimate. Fix root
  causes at the chokepoint all callers share, not per-symptom patches.
- Report outcomes faithfully: failing tests are reported as failing; skipped steps as
  skipped; deviations from spec with reasons.

### Working style
- Single-branch flow: edit → validate → commit → push. Commit verified work promptly;
  history is the protection in shared checkouts.
- Google-style literal naming (no clever/metaphor names).
- Best-in-class quality bar on foundations; lazy/minimal on speculative abstractions (YAGNI).

## Setup (required before running)

Before running any scraper commands, create the `.env` file if it doesn't exist.
The required env vars are: `AIRTABLE_LAND_TOKEN`, `AIRTABLE_BASE_ID`, `EMAIL_TO`.
Recommended: `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` for real email delivery
and `HEALTHCHECK_URL` for dead-man's-switch monitoring.
See `.env.example` for the full list.

## Running

- Install deps: `npm install --silent`
- Full nightly run (scrape + price check + review + lead recheck, ONE consolidated email): `node index.js`
- Dry run (scrape and report without Airtable writes; review and lead recheck are skipped): `node index.js --dry-run`
- Targeted dry run: `SCRAPER_TARGET_COUNTIES="Wayne|KY,Pittsburg|OK,Shannon|MO" SCRAPER_MAX_PAGE=1 node index.js --dry-run --skip-price-check`
- Review leads only (manual; sends its own review email): `node review-leads.js`
- Price check only: `node index.js --price-check-only`
- Scrape without price check: `node index.js --skip-price-check`
- Scrape without review: `node index.js --skip-review`
- Scrape without lead recheck: `node index.js --skip-lead-recheck`

## GitHub Actions

The nightly scraper workflow lives at `.github/workflows/nightly-scraper.yml`.
It runs on a nightly schedule as an independent monitor (it opens a GitHub
issue on failure) and can also be run manually. GitHub scraper runs are always
dry-run only — enforced in `index.js` via `GITHUB_ACTIONS`, not just in the
workflow file.

Required GitHub repository secrets:

- `AIRTABLE_LAND_TOKEN`
- `AIRTABLE_BASE_ID`
- `EMAIL_TO`

Production scraping should run from Nora's always-on desktop in `/Users/nora/ccl-land-scraper` via the `launchd` service files in `services/` (see `services/README.md` for wake scheduling, SMTP, and monitoring setup).
GitHub Actions should be used for tests and dry-runs only.
GitHub dry-runs upload the scraper report and any failed Airtable write queue as workflow artifacts.

## Airtable schema (IMPORTANT)

The leads table in the "Land" base is named **`Land`** (NOT `Leads`) and the
county table is **`County`**. Field quirks, all encoded in `FIELDS`/`STAGES`
in `lib/airtable.js` — never hardcode field names elsewhere:

- `Listing `, `Coordinate `, and `Price Check Log ` have trailing spaces
- `Name`, `$/A`, `Days On The Market`, `State` are formula/lookup fields —
  readable but never writable (`$/A` reads as text like "$2900")
- `County` is a linked-record field; text county name comes from the
  `County (from County)` lookup; links are written by County record ID
- Stage options include `Manual Check Price Drop` (not "Manual Check");
  the scraper only auto-changes stages in `SCRAPER_MANAGED_STAGES`
- Run `npm run check-airtable` to verify token/base/tables/fields with
  plain-English diagnostics

## Architecture

- Site parsers in `lib/parsers/` (LandWatch, Land.com, LandAndFarm, LivingTheDream, WhitetailProperties, MossyOakProperties; LandsOfAmerica exists but is disabled — it redirects to Land.com)
- Bot-blocked pages (403s and HTTP-200 challenge pages) are retried through a
  real Chrome via `lib/browser-fetch.js` (playwright-core, optionalDependency;
  disable with `SCRAPER_BROWSER_FALLBACK=false` — the CI workflow does);
  validate with `npm run test-browser -- --live` on the production Mac
- Stage policy (IMPORTANT, set by Emma): fresh scrape/intake records arrive
  with Stage `New Lead` and the scraper/review never move a record out of
  `New Lead` — only Emma does. Price-drop promotions arrive as `Price Drop`
  (not truly new leads). See `test/stage-policy.test.js`
- `scripts/run-scraper.sh` self-updates the checkout from GitHub `main`
  before each nightly run; failures surface as warnings in the report email.
  It also audits the Mac's installed launchd agents/crontab against
  `services/*.plist`, surfacing leftover or schedule-drifted jobs as a
  warning in the same email — detection is automatic, removal stays manual
  via `scripts/setup-production.sh`
- Whitetail/MossyOak use the class-name-agnostic `extractByDetailLinks` engine in `base-parser.js` (detail-link anchors + price/acreage text extraction); when adding a source, prefer that engine plus real-HTML fixtures captured from the production Mac
- Listing Intake (`lib/intake.js`, Airtable table `Listing Intake`): team
  members submit listing URLs via an Airtable form; the nightly run imports
  them into `Land` as `New Lead` records (browser fallback applies). First
  failure → Status `Retry` (re-attempted the next night); second failure →
  `Failed` (a human sets Status back to `New` to force another try). Results
  and failures appear in the consolidated email. Manual run: `npm run intake`
- Lead recheck (`lib/lead-recheck.js`): nightly, production-Mac-only step that
  re-fetches the listing URL of every `New Lead` / `Emma Review` record
  (browser fallback applies — the cloud can't reach LandWatch), capped at 100
  a night (oldest-unchecked-first, tracked in `data/lead-recheck/state.json`,
  not on the Airtable record). REPORT ONLY — it never changes Stage or writes
  any Airtable field; it lists leads that now match an availability phrase
  (under contract/sold/off-market) or whose live acreage disagrees with the
  record (>=10% relative difference or a crossing of the 40-acre floor) in a
  `LEAD RECHECK` section of the consolidated email. Skipped on `--dry-run` and
  midday runs (live-fetch, production-only, same as review); disable with
  `--skip-lead-recheck` / `SKIP_LEAD_RECHECK=true`
- County targets loaded dynamically from Airtable `County` table using `CPA Target`
- Filtering: accepts listings within 20% of CPA target, watches 20-30% over, rejects >30%;
  a hard 40-acre floor (`SCRAPER_MIN_ACRES`) and an under-contract/pending/off-market skip
  both apply after detail enrichment, regardless of source URL filter params, and are each
  itemized in the nightly report (`lib/scraper.js`, `lib/availability.js`)
- Deduplication: URL match + property fingerprint (county/state/acres/price hash) + location/price-tolerance match; the dedup index includes `Not Interested` records so rejected leads are not re-created
- Results written to the Airtable `Land` table
- Failed Airtable writes are queued in `data/failed-writes/` and replayed automatically at the start of the next scrape (processed files move to `data/failed-writes/done/`)
- The 2 AM nightly job runs scrape → price check → lead review and sends a
  single consolidated email (no separate scheduled review job/email)
- Launch scripts use a local run lock so scraper/review jobs do not overlap
- Parser fetch/parse failures, bot-block detections, and markup-drift suspicions are saved locally under `data/source-health/` (HTML evidence in `data/source-health/snapshots/`) and summarized in reports

## Source outage playbook (learned from the LandWatch outage, fixed Aug 2026)

When a source's report line drops to "0 checked" with markup-drift warnings
("pages load but no listings were recognized"), suspect a site redesign of
URLs/markup — NOT a bot-block. Bot-blocks show up as 403/challenge warnings
instead; "page fetched OK, zero cards matched" means our URL scheme or
selectors are stale. Urgent-fix path that worked for LandWatch (PR #29,
commit 108622c):

1. Get real evidence first: read `data/source-health/<date>.jsonl` and
   `data/source-health/snapshots/` from the production Mac (evidence-inbox
   flow) — fix against actual served HTML, never against guesses. Queue
   evidence-capture URL variants for any filter segment still unconfirmed
   (captures run on the 2 AM nightly only; midday skips them).
2. Fix the parser's URL builder + selectors against that HTML. LandWatch's
   2026 scheme: `/{state}-land-for-sale/{county}-county` paths, `/page-N`
   pagination (collapse the series), and error-shell detection (HTTP 200
   with an empty app shell must count as a failed page, not "no results").
3. Lock the fix in with a real-HTML fixture in `test/fixtures/` captured
   from the production Mac.
4. Ship via branch → PR → CI. The Mac self-updates from `main` before every
   run, so merged-by-2-AM-Central means the next nightly runs it; the
   12:30 PM midday run is the earliest same-day live confirmation (but it
   emails only when noteworthy — silence means no crash AND no new leads,
   see `isMiddayRunNoteworthy` in `lib/notify.js`).
5. Verify from the report email: real "N checked" counts with no
   markup-drift warnings for that source = fixed.
