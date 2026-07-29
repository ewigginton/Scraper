# Daily scraper health-check & repair runbook

**Schedule:** every day at **9:00 AM Central Time**.
**Goal:** confirm every *enabled* site scraper completed and produced valid
results overnight; diagnose, repair, test, and re-run only the affected site
when one did not — safely, and with a human in the loop before anything ships.

This runbook is the operating procedure for that daily automation. The
deterministic review (steps 1–4 below) is done by `npm run health-check`; the
diagnosis-and-repair loop is done by an agent (or a person) following the rest
of this document. Nothing here writes to Airtable or touches lead data.

Enabled sources are whatever `config/settings.json → sites` has
`"enabled": true`. As of this writing: **livingthedream, whitetail, mossyoak,
midwestlandgroup, landflip, nationalland, tuttland**. The disabled CoStar
sources (landwatch, landcom, landfarm, landsofamerica) are intentionally off
and are *not* health-checked.

---

## Where the run data comes from

`data/` and `reports/` are gitignored and machine-local, so the run being
reviewed lives wherever the scrape ran:

- **On the production Mac** (the real 2 AM nightly run): the health check reads
  `data/run-history/history.jsonl`, which `index.js` appends to at the end of
  every scrape via `lib/run-history.js`. This is the only place with a real
  7-run baseline, so the trend checks (unusually-low / unexpected-zero) work
  fully here.
- **In the cloud / GitHub Actions**: read the most recent nightly-scraper
  workflow run — its job summary contains the full scraper report, and the
  uploaded artifact contains `reports/` and `data/run-history/`. Without a
  persisted multi-run history the trend checks degrade to single-run checks;
  `npm run health-check` says so in its header ("single-run checks only").

The check compares like-with-like: a dry-run is only ever measured against
prior dry-runs, and a midday run only against prior midday runs (different
county subset, different expected volume).

---

## 1–4. Review & classify (deterministic — `npm run health-check`)

For the most recent run, for **each enabled site**, the check looks at:

- whether the job started and finished (a missing site entry ⇒ *Needs human
  review*; a crash ⇒ *Failed*);
- exit status / error messages and the HTTP response codes recorded as source
  issues (404 / 403 / 429 / 503 / timeouts);
- pages examined (`checked`) and records returned (`parsed`);
- whether records passed the field/price/acreage gate (`passed`) — a record
  that passed necessarily had its required fields populated, since the filter
  rejects records missing filter-critical fields;
- whether the result count is unusually low or zero **versus the previous seven
  successful runs** — never assume a zero-result run is broken; a quiet search
  with a zero-heavy baseline is *Successful*;
- whether the site returned a login/CAPTCHA/access-denied/rate-limit page
  (recorded as `blocked`) or an unexpected layout (recorded as `markup_drift`).

Each source is marked exactly one of:

| Mark | Meaning | Automation response |
|------|---------|---------------------|
| **Successful** | Finished cleanly, results in range (incl. a legitimately quiet zero) | none |
| **Successful but anomalous** | Finished, but volume is off / a transient wobble | note it; light spot-check |
| **Failed** | Crashed, or parser broken (404 storm / markup drift) | diagnose & repair (below) |
| **Access restricted** | Bot wall / CAPTCHA / access-denied is blocking | **STOP**, back off, escalate |
| **Needs human review** | Stark unexplained change (reliable source → zero), or a source that never ran | escalate |

`npm run health-check` exits `0` (all good), `1` (only soft anomalies), or `2`
(something needs attention), and `--json` emits the same analysis for tooling.

---

## Repair loop — for each Failed / anomalous source

Do this **per source**, newest evidence first, and stop at the first success.

1. **Inspect before changing anything.** Read the run logs, the saved response
   snapshot (`data/source-health/snapshots/`), the recorded source issues
   (`data/source-health/<date>.jsonl`), and the site's parser in
   `lib/parsers/`. Identify the *most likely* cause first.
2. **Smallest source-specific repair.** Fix only that site's parser/config. Do
   **not** touch shared components (`base-parser.js`, `browser-fetch.js`,
   `scraper.js`, filtering, dedup) unless the failure clearly originates there —
   a shared change is high blast-radius and needs explicit human approval.
3. **Small test — ≤ 1–3 pages or ≤ 10 records.** Use the targeted dry-run:
   ```
   SCRAPER_TARGET_COUNTIES="<County|ST,...>" SCRAPER_MAX_PAGE=1 \
     node index.js --dry-run --skip-price-check --skip-review
   ```
   Validate: the expected page came back; records were extracted; required
   fields are present; no duplicate/malformed records; and no
   access-denied / CAPTCHA / rate-limit response.
4. **Re-run only that source for the day** once the test passes, then validate
   the full re-run and let the normal pipeline load only new, deduplicated
   records into Airtable (dedup + the failed-write queue already handle this;
   never bulk-insert around them).
5. Keep diagnosing ordinary code / config / session / page-layout failures
   until the source succeeds **or** a stop condition below is reached.

---

## Safety & stop conditions (hard limits)

**Immediately stop requests to a source** on any of:

- a CAPTCHA or access-denied response;
- an account restriction;
- **three consecutive HTTP 403s**;
- **three consecutive HTTP 429s**;
- **ten consecutive failed requests**.

(The scraper's own circuit breaker in `base-parser.js` already aborts a site
after a run of blocked/error pages and records a `site_abandoned` issue — do not
work around it.)

Also:

- Use **exponential backoff** for transient server (5xx) and rate-limit errors;
  never hammer the same failing request.
- **Never** expose credentials, cookies, tokens, customer data, or secrets in
  logs, commits, or reports. Run history stores only category tallies and
  URL-scrubbed messages.
- **Do not delete existing lead data.**
- **Do not deploy broad or high-risk changes without human approval.**
- **Budget: 60 minutes of autonomous repair per source per day.** If a source
  is unresolved after that, stop and escalate for human review.
- Preserve the failed response, screenshot, logs, and the exact error for later
  diagnosis (the scraper already persists these under `data/source-health/`).

---

## For every code change

- Work on a **separate branch** (never commit fixes straight to `main`).
- In the commit / PR, record **the cause of the failure and the specific
  repair**, plus the test performed and its result.
- Run the relevant tests (`npm test`, plus the targeted dry-run above).
- **Do not merge or deploy** unless the approval policy explicitly permits it.
  Default policy: open a PR and **request Emma's review** — the automation does
  not self-merge. If deployment is later approved, verify the deployed version
  with another small test before running the full source.

---

## Daily report (always produced)

`npm run health-check` prints, and the automation relays:

- Overall status
- Status of each site
- Records found by each site
- New deduplicated leads added
- Anomalies detected
- Failures discovered
- Repairs made · tests performed and their results · sources re-run
- Sources still requiring attention · any recommended human action

---

## Definition of done

The day's run is complete only when **every source** is one of:

1. successfully validated and its results collected;
2. confirmed to have legitimately returned no new records; or
3. safely stopped and clearly escalated because of an access restriction, an
   unresolved failure, or a decision that needs a human.
