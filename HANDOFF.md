# Session Handoff — CCL Land Scraper

Last updated: **Aug 4, 2026, ~7:30 PM Central** (update this stamp when you edit).
Read CLAUDE.md first — it has the standing working rules (workflow orchestration,
model ladder, hard lines) and the Source outage playbook. This file is the
*live status*: what's in flight right now and why.

## What this project is

Nightly scraper that finds rural land listings for Emma (Classic Country Land),
filters them against county CPA price targets, and writes leads to Airtable
("Land" base). Production runs at 2:00 AM Central on Nora's always-on Mac
(`/Users/nora/ccl-land-scraper`, launchd, self-updates from `main` before each
run). A 12:30 PM midday sweep emails only when noteworthy. Cloud sessions
(like this one) develop, test, and ship via branch → PR → CI → merge to `main`;
the Mac picks changes up automatically. **Cloud IPs cannot fetch LandWatch/
CoStar sites (bot-blocked) — anything needing live LandWatch pages must run on
the Mac or come from `data/source-health/` evidence captures.**

## State of play (Aug 4)

- **LandWatch outage: FIXED, pending full confirmation tonight.** Site
  redesigned URLs (~May 2026) → months of "0 checked". Fix = PR #29, commit
  `108622c`, merged ~3 AM Aug 4 (new `/{state}-land-for-sale/{county}-county`
  URL scheme, `/page-N` pagination, error-shell detection). Proof it works: the
  stray 3:35 AM dry-run jobs ran post-merge code on the Mac and parsed
  **29 LandWatch listings** with zero bot-block/markup warnings. Tonight's
  2 AM run is the first FULL county rotation on the new scheme, plus 4 queued
  evidence-capture URL variants (the `minAcreage=150` filter segment is still
  unconfirmed in the new scheme). A check-in is armed for **2:45 AM Central
  Aug 5** to read the nightly report, pull evidence, commit a
  `landwatch-search.html` fixture, and fix any filter-segment issue via PR.
- **Stray scheduled jobs on the Mac**: leftover 3:35 AM validation dry-run
  jobs send Emma extra emails daily. Fix has two parts: (1) Nora runs
  `bash scripts/setup-production.sh` on the Mac and accepts removals —
  **answer "n" (keep) for `com.ccl.land-scraper.midday.plist`**, everything
  else scraper-shaped gets "y"; (2) commit `c242715` added a nightly
  launchd/cron audit that names any leftover/drifted job in the report email
  until it's removed.
- **Lead-quality fixes LANDED** (3 workflow rounds + inline round 3 after the
  subagent harness broke; verified by adversarial-Opus attack harnesses rerun
  to green, full suite 378 pass), from Emma's reports of bad leads (all
  LandWatch pids 427203701, 427406387, 426688209 — root cause: they entered
  via Listing Intake, which bypassed every filter):
  1. Under-contract/sale-pending/sold listings must be skipped at scrape time
     (itemized in the email) — today they become leads.
  2. `.24 acres` was parsed as `24` acres (leading-decimal bug) — corrupts
     $/acre CPA math. Fix at the shared extraction chokepoint.
  3. Hard 40-acre minimum in code (`SCRAPER_MIN_ACRES`, default 40) — the old
     URL param `minAcreage=40` was the only enforcement and the new LandWatch
     scheme may not honor it.
  4. Email lists sorted by acreage DESCENDING — Emma wants big listings first.
  5. New nightly "lead recheck": live re-fetch of `New Lead`/`Emma Review`
     records on the Mac, flagging now-under-contract and acreage-mismatch
     leads in the email. REPORT ONLY — only Emma moves stages, ever.
  6. Intake now enforces the same rules: under-contract/sold or below-floor
     submissions are rejected with Status `Failed` and a plain-English
     Result; missing acreage still creates-with-warning. Detection runs on
     the RAW page title (cleanTitle strips "SOLD - " prefixes). Sold is
     status-anchored (`SOLD_PATTERNS` in lib/availability.js) so comp prose
     ("tracts have sold for...") never matches. Recheck treats challenge
     pages, CoStar error shells, AND content-free app shells as fetch
     failures — never "looks live".
  Verified per the CLAUDE.md ladder by adversarial Opus REFUTE lanes over 3
  rounds; the attack harnesses live in the session scratchpad (attack-*.js)
  and all rerun green.
- **Job-audit verify lane** (workflow `wf_d21195ee-d1d`) was still running
  when this was written — it proves the audit catches a planted leftover job.
  Its implementation is already committed (`c242715`, 330 tests green).
- **Not yet done**: PR from branch `claude/landwatch-scraper-rebuild-j27tw8`
  to `main`. Open it once the in-flight verify lanes are green; it must merge
  before ~2 AM Central for the Mac to run tonight's code. The branch also
  carries the CLAUDE.md outage playbook and `.claude/settings.json`
  bypassPermissions (Emma's explicit choice).

## Emma's product rules (restated today — treat as requirements)

- **40 acres minimum, no exceptions; bigger is better** — surface largest
  first. She is worried big listings get buried.
- **No under-contract/pending/sold listings as new leads.**
- Fresh leads arrive as Stage `New Lead` and ONLY Emma moves them out.
  Price-drop promotions arrive as `Price Drop`. (See test/stage-policy.test.js.)
- One consolidated nightly email; midday emails only when noteworthy
  (`isMiddayRunNoteworthy`, lib/notify.js — a quiet midday is SUCCESS, not
  failure).
- Production Airtable writes: dry-run first, Emma's explicit go in chat,
  never delegated to agents (CLAUDE.md hard line).

## Quick orientation for a new session

- Working branch: `claude/landwatch-scraper-rebuild-j27tw8` (single-branch
  flow: edit → validate → commit → push promptly).
- `npm test` = full gate (~25s, ~330 tests). `npm run check-airtable`
  verifies Airtable wiring. Airtable schema quirks (trailing-space field
  names, formula fields, linked County records) are in CLAUDE.md — read them
  before touching lib/airtable.js callers.
- Emails to check state: search Gmail for subject "CCL Scraper". Nightly
  always sends; the report includes `Code version: <sha>` to confirm what the
  Mac actually ran.
- Workflow scripts + agent transcripts for the in-flight runs live under
  `/root/.claude/projects/-home-user-Scraper/*/workflows/` (session-local,
  not in git) — journal.jsonl has each lane's returned result.
