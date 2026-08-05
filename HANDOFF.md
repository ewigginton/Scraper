# Session Handoff — CCL Land Scraper

Last updated: **Aug 5, 2026, ~9:30 AM Central** (update this stamp when you edit).
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

## State of play (Aug 5)

- **LandWatch outage: FIXED and CONFIRMED.** The Aug 5 2 AM nightly (code
  `6c1d488`) ran the first full county rotation on the new URL scheme:
  **2199 checked → 15 passed → 15 new**, 71/189 counties (rotation group
  1 of 3), 15/15 detail fetches OK, zero bot-block/markup-drift warnings.
  All 4 queued evidence captures landed on `evidence-inbox`; the
  `/acres-over-150` path segment is CONFIRMED as real server-side filtering
  (4 listings all ≥201ac vs 5ac lots on the unfiltered page). Real-HTML
  fixtures now live in `test/fixtures/landwatch-search*.html` and the two
  formerly-skipped parser tests run for real.
- **Lead recheck's first night proved the concept**: 93/98 leads rechecked;
  4 flagged now-unavailable; 11 acreage mismatches — including Emma's
  original bad lead pid 426688209 (recorded 241ac, live 0.24ac). NOTE a
  likely NEW defect visible in the mismatches: several leads scraped tonight
  recorded lake/community acreage from prose ("1,000 acre Lake Halford" →
  recorded 1000ac for a 0.94ac lot; also 600→5.01, 440→80, 80→36). The
  scraper's enrichment acreage and the recheck's extraction disagree on the
  same pages — the recheck side looks right. Root-cause candidate: enrichment
  extraction picks the most-frequent/wrong number where intake's
  extractListingDetails does better. NOT yet fixed — next session should
  diagnose at the shared chokepoint before more 1000ac-lot leads accumulate.
- **WhitetailProperties: 0 listings parsed** in the Aug 5 nightly (site-issue
  flagged in the email). Not yet diagnosed — could be blocked or markup
  drift; follow the Source outage playbook if it repeats.
- **Stray scheduled jobs on the Mac**: leftover 3:35 AM validation dry-run
  jobs send Emma extra emails daily — they fired again Aug 5 (~3:34 AM).
  Fix has two parts: (1) Nora runs `bash scripts/setup-production.sh` on
  the Mac and accepts removals — **answer "n" (keep) for
  `com.ccl.land-scraper.midday.plist`**, everything else scraper-shaped
  gets "y"; (2) commit `c242715` added a nightly launchd/cron audit that
  names any leftover/drifted job in the report email until it's removed.
  The audit section did NOT appear in the Aug 5 email — expected: the
  running `run-scraper.sh` instance was the pre-update version (the script
  self-updates the checkout, but the already-running shell is old). It
  should appear from the Aug 6 nightly onward; if it still doesn't, debug.
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
