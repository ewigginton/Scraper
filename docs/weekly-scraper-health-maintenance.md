# Weekly Scraper Health, Testing & Maintenance Runbook

This runbook is the standing instruction for the **weekly scraper health
automation**. A scheduled Routine fires a fresh Claude Code session against
this repository **every Thursday at 11:00 PM Central Time** and that session
follows the procedure below. Emma can edit this file to change what the
automation does; the schedule itself lives in the Routine (see
"Scheduling & maintenance" at the bottom).

## Objective

Evaluate every **approved (enabled) scraper source**, repair ordinary
technical failures, validate all changes, and bring each source as close to
fully healthy as reasonably possible **without creating new problems or
bypassing access restrictions**.

Review each source **independently**. Never assign one overall score in place
of scoring the individual sources.

## Approved sources to evaluate

The approved sources are exactly those with `"enabled": true` in
`config/settings.json` → `sites`. As of this writing:

| Source key         | Parser class          |
| ------------------ | --------------------- |
| `livingthedream`   | LivingTheDream        |
| `whitetail`        | WhitetailProperties   |
| `mossyoak`         | MossyOakProperties    |
| `midwestlandgroup` | MidwestLandGroup      |
| `landflip`         | Landflip              |
| `nationalland`     | NationalLandRealty    |
| `tuttland`         | TuttLand              |

Re-read `config/settings.json` at the start of every session — the enabled
set is the source of truth, not this table. **Disabled** sources
(`landwatch`, `landcom`, `landfarm`, `landsofamerica`) are out of scope; do
not enable them to "fix" them.

## Environment caveat — read before scoring (IMPORTANT)

This automation runs in the **remote/web execution environment**, which
reaches the internet from a **datacenter IP** — the same class of IP the
CoStar-family and other anti-bot sites block regardless of scraper quality.
The nightly CI monitor already sets `SCRAPER_BROWSER_FALLBACK=false` for this
reason. Production scraping runs from Nora's residential-IP Mac in
`/Users/nora/ccl-land-scraper`.

Consequences you must honor when scoring:

- A source that returns **403 / 429 / challenge pages from this environment
  only** is an **environmental block, not a code defect**. Attribute it as
  such, escalate it for verification on the production Mac, and do **not**
  rewrite a working parser to chase a datacenter block. This is a score-0
  *stop-and-escalate* condition, not a repair target.
- Prefer **offline validation** wherever possible: run `npm test` and the
  parser fixture tests, which exercise extraction against captured real HTML
  and do not depend on live network access.
- When a live small-batch fetch is warranted and safe, keep it to **1–3
  pages / ≤10 records** and stop immediately on any stop condition below.

## Health score (0–5) — objective evidence only

Score each source on completed evidence (logs, record counts, validations,
response codes, screenshots, test results) — never on general confidence.

- **5 — Fully healthy:** run completed, expected pages returned, extraction
  passed, required fields validated, result volume plausible, dedup worked,
  no warnings. *A legitimate zero-result run scores 5* if the scraper reached
  the expected pages, completed the expected searches, and validation shows
  no new qualifying results were available.
- **4 — Working, minor warning:** valid results collected but a non-blocking
  anomaly (unusually low volume, a recoverable page omission, a minor
  optional-field issue).
- **3 — Partially working:** some valid records, but pages/fields/expected
  records are missing.
- **2 — Test-only success:** a small test worked but the full scheduled run
  did not complete.
- **1 — Failed:** ran but produced untrustworthy results.
- **0 — Unable to run:** auth failure, CAPTCHA, access restriction, explicit
  block, unavailable site, or missing credentials.

## Required response by score

- **5:** Mark complete. Make no unnecessary changes.
- **4:** Preserve the valid results. Investigate the warning; make a low-risk
  repair only if the cause is identifiable and testable.
- **2–3:** Continue diagnosis and repair within the time/request/retry
  limits.
- **0–1:** Repair **only** when the likely cause is an ordinary code,
  configuration, expired-session, dependency, or page-layout problem. **Stop
  and escalate** CAPTCHAs, account blocks, access restrictions, missing
  authorization, or repeated rate limits.

## Repair process (per source)

1. Review recent runs, logs, response codes, screenshots, record counts, and
   saved outputs (`data/source-health/`, `data/source-health/snapshots/`,
   `reports/`, `data/failed-writes/`).
2. Identify and **document the likely cause before modifying code**.
3. Make the **smallest source-specific change** necessary.
4. Preserve the last known working version; ensure the change is
   rollback-able (work on the branch, commit atomically per source).
5. Run a **small-batch test**: ≤3 pages or ≤10 records. Prefer
   `npm test` + the source's fixture tests first, then a targeted dry run,
   e.g.
   `SCRAPER_TARGET_COUNTIES="Wayne|KY,Pittsburg|OK,Shannon|MO" SCRAPER_MAX_PAGE=1 node index.js --dry-run --skip-price-check`.
6. Confirm expected pages returned and that required fields, formatting, and
   deduplication pass validation.
7. If the small test succeeds, rerun **only the affected source**.
8. Rescore the source using the completed test + rerun evidence.
9. Continue safe, evidence-based improvements until the source reaches 5, no
   further safe improvement exists, or a stop condition is hit.

## Time budget & prioritization

Work up to **two hours total** across all sources per session. Prioritize:

1. Sources rated **1–3** that normally produce the most valuable leads.
2. Sources rated **4**.
3. Preventive improvements for sources rated **5**.

Do not burn the session retrying one source while ignoring others. After
**45 minutes** on a single unresolved source, document its status and move
on — unless finishing the current repair is clearly within reach.

## Stop conditions (hard)

- Do not continue after an explicit block.
- Stop requests to a source after: access-denied, CAPTCHA, account
  restriction, **three consecutive** HTTP 403/429, or **ten consecutive**
  failed requests.
- Use **exponential backoff** for temporary errors.
- Never repeatedly retry the same failed request without a justified change.
- Never expose passwords, cookies, credentials, tokens, or personal info.
- Never delete existing lead data.
- Never deploy a change that fails testing.
- Do not make broad shared-system changes unless evidence shows the shared
  system is the cause.
- Never continue indefinitely merely to raise a score.

## End-of-session procedure

At the two-hour limit, finish the current safe operation and stop at a
**stable point**. Never leave a partially deployed change, a running repair,
an uncommitted production modification, or a corrupted dataset. Commit and
push completed, tested per-source changes to the working branch.

Produce a summary containing, for the session:

- Before-and-after score for **every** source
- Evidence supporting each score
- Problems identified and likely root causes
- Code/configuration changes made
- Small-batch tests performed
- Full source reruns performed
- Records recovered or added
- Changes rolled back
- Unresolved problems
- Sources requiring human attention
- Recommended next action for the following session

The session is successful when every source has been evaluated and is either
(1) fully healthy, (2) working with a documented minor warning, (3) improved
as far as safely possible, or (4) safely stopped and clearly escalated
because further work needs human input, authorization, or an external change.

## Scheduling & maintenance of the automation itself

- Cadence: **every Thursday, 11:00 PM Central Time.**
- Mechanism: a Claude Code Routine that spawns a fresh session in this
  environment on each firing and runs this runbook.
- **Daylight Saving caveat:** the Routine's cron fires at a fixed UTC time.
  It is set to `0 4 * * 5` (04:00 UTC Friday = 23:00 **CDT** Thursday),
  correct while Central observes Daylight Time. When Central falls back to
  **Standard Time (CST)**, update the cron to `0 5 * * 5` to keep the fire at
  11:00 PM local; reverse it in spring. (There is no DST-aware cron.)
