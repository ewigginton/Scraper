# Production services (Nora's desktop)

The full nightly run (scrape + price check + lead review) runs at 2:00 AM via
the single launchd plist in this directory and sends **one consolidated
email**. launchd's `StartCalendarInterval` does **not** wake a sleeping Mac
and skips the run entirely if the machine is off at the scheduled time, so a
few one-time setup steps make the schedule reliable.

Two things happen automatically every night:

- **Self-update**: `scripts/run-scraper.sh` fast-forwards the checkout to
  GitHub `main` (and runs `npm install` when needed) before scraping, so new
  parsers and fixes deploy themselves. If the update can't apply (local
  edits, no network, wrong branch), the run proceeds on the current code and
  the nightly email carries a warning. The email footer shows the running
  code version (`Code version: <commit>`).
- **Browser fallback for blocked sites**: LandWatch, Land.com, and
  LandAndFarm (all CoStar) answer HTTP 403 to plain HTTP clients. When a
  page is refused or served a challenge page, the scraper retries it through
  the Mac's installed **Google Chrome** (via `playwright-core`, installed by
  `npm install`). Keep Chrome installed on the production Mac; if Chrome
  lives somewhere unusual, set `SCRAPER_BROWSER_PATH` in `.env`.

  Validate it from the production Mac (the bot walls score the network's IP,
  so only a probe from that machine tells the truth):

  ```bash
  npm run test-browser -- --live
  ```

  It first self-tests that a browser launches and renders JavaScript, then
  probes the real LandWatch/Land.com/LandAndFarm search pages, comparing
  what a plain fetch gets vs what the browser gets.

**Easiest path: run the guided setup script instead of doing the steps below
by hand.** From the scraper folder on the production Mac:

```bash
bash scripts/setup-production.sh
```

It walks through every step in this file interactively (wake schedule, SMTP,
healthchecks.io, a test email, and loading the services) and is safe to
re-run any time. The sections below explain what it does and how to do each
step manually.

## 1. Wake the Mac for the runs (one time, requires admin)

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
```

This wakes (or powers on) the machine at 1:55 AM every day so the 2:00 AM
nightly run fires. Verify with `pmset -g sched`.

Also disable automatic sleep while on power:

```bash
sudo pmset -c sleep 0
```

## 2. Configure real email delivery (SMTP)

The default macOS `mail` command hands messages to local postfix, which has
no relay configured on a stock machine — mail silently never leaves the box.
Set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` in
`.env` (for Gmail use `smtp.gmail.com`, port 587, and an App Password) and
the scraper sends through nodemailer with confirmed delivery instead.

## 3. Set up the dead-man's switch

Email only tells you about runs that *happened*. To find out when a run
**didn't** happen (machine asleep, launchd unloaded after an OS update, lock
stuck), create a free check at https://healthchecks.io with a 24-hour period
and a few hours of grace, then put its ping URL in `.env` as
`HEALTHCHECK_URL`. The scraper pings it after every run (and pings `/fail`
on fatal errors); healthchecks.io emails you when the ping goes missing.

The nightly GitHub Actions dry-run (`.github/workflows/nightly-scraper.yml`)
is an independent second monitor: it opens a GitHub issue automatically if
the code itself starts failing.

## 4. Loading the service

```bash
launchctl load ~/Library/LaunchAgents/com.ccl.land-scraper.plist
```

After any macOS upgrade, confirm it is still loaded:

```bash
launchctl list | grep com.ccl
```

## 5. One email per day — remove leftover jobs

The 2:00 AM run sends the only scheduled email. If you still receive extra
daily emails, older jobs are still installed on the Mac. Remove them:

- **The old separate 6:00 AM review email** (`CCL Review — ...`):

  ```bash
  launchctl unload ~/Library/LaunchAgents/com.ccl.land-review.plist
  rm ~/Library/LaunchAgents/com.ccl.land-review.plist
  ```

- **The old Listing Intake poller**: intake submissions are now imported by
  the 2 AM nightly run (with the browser fallback, next-day retries, and
  results in the consolidated email — or on demand with `npm run intake`).
  `bash scripts/setup-production.sh` finds it and removes it with one
  keypress. Until it's removed you're still protected: the nightly run
  reclaims any submission the old poller fails (its "HTTP ... fetching"
  Needs Review rows) and retries it through the browser, and the email
  warns you the old poller is still installed.

- **The legacy 8:00 AM digest** (`CCL Daily Land Report - ...`) comes from a
  script that predates this repo's email reports and only exists on the
  production Mac. Find and remove whatever schedules it:

  ```bash
  crontab -l                      # look for a daily-report/digest entry; edit with: crontab -e
  ls ~/Library/LaunchAgents       # look for other ccl/land/report plists
  ```

  `bash scripts/setup-production.sh` also scans for these leftovers in its
  last step and prints removal commands.

GitHub also emails "Run failed" notifications when the nightly dry-run
workflow fails — those stop when the workflow is healthy, and can be tuned
in GitHub notification settings, not on this machine.

## 6. Optional: a midday sweep for same-day listings

The 2:00 AM run is the full pipeline (scrape + price check + intake +
review + evidence capture, one email). `com.ccl.land-scraper.midday.plist`
adds a **second, lighter** run at 12:30 PM so same-day listings surface
within hours instead of waiting for the next 2 AM — the scraper's
incremental early-stop and dedup make re-sweeping cheap.

The midday run does **scrape + listing intake only**: price check, lead
review, and evidence capture stay nightly-only (set via `SCRAPER_MIDDAY=1`
in the plist, read by both `scripts/run-scraper.sh` and `index.js`). It also
sends **no email at all** when nothing noteworthy happened (no new leads, no
write errors, no site newly bot-blocked/abandoned, no crashed site) — routine
"found nothing new" runs stay silent. When it does send, the subject is
prefixed `[Midday]` so it's never confused with the nightly report. It runs
the exact same `scripts/run-scraper.sh` and shares the same run lock as the
nightly job, so the two can never overlap.

Install it with one paste, from the scraper folder on the production Mac:

```bash
mkdir -p ~/Library/LaunchAgents
cp services/com.ccl.land-scraper.midday.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.ccl.land-scraper.midday.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.ccl.land-scraper.midday.plist
```

Verify it loaded:

```bash
launchctl list | grep com.ccl.land-scraper.midday
```

Its logs land next to the nightly ones in `services/land-scraper/logs/`, as
`scrape-YYYY-MM-DD-midday.log` (and `launchd-scraper-midday*.log`), so a
same-day nightly/midday pair never interleaves into one file.

## 7. Optional: the run-request poller (on-demand tasks from GitHub)

Without this, the Mac only ever acts on its own clock — 2:00 AM and (if
installed) 12:30 PM. Anything the assistant needs *from that machine* (a page
capture from the house's residential IP, a dry-run against a county to check a
parser fix) has to wait for the next 2 AM.

`com.ccl.run-request-poller.plist` runs `scripts/poll-run-requests.sh` every
**15 minutes**. Each poll fetches GitHub `main`, reads `config/run-requests.json`,
and — if it names a task that hasn't been run yet — self-updates the checkout
and runs it, then pushes the outcome back to the `evidence-inbox` branch. It
takes the **same run lock** as the nightly and midday jobs, so a request can
never run on top of a scrape; if the lock is busy the request simply waits for
the next 15-minute cycle. It also refuses to *start* a task when a scheduled
scrape is close enough that the task might still be holding that lock when the
scrape fires — see "Never at the expense of the nightly" below.

### The request file

`config/run-requests.json` on `main`. Its committed (idle) state is:

```json
{ "request": null }
```

A request looks like this:

```json
{
  "request": {
    "id": "2026-07-31-wayne-check",
    "task": "validation-dry-run",
    "params": { "counties": "Wayne|KY,Pittsburg|OK", "maxPage": 1 }
  }
}
```

- `id` — required, must match `^[A-Za-z0-9._-]{1,64}$` and must not start with
  `-` (it becomes a log and result file name, and a command argument). The
  poller records the last id it handled in
  `services/land-scraper/.run-requests-handled` and runs each id **at most
  once**, recording it *before* dispatch. A task that crashes or wedges the Mac
  therefore does **not** retry every 15 minutes forever — read the result, fix
  the cause, and send a new request with a **fresh id**.
- `task` — required, and held to the **same** `^[A-Za-z0-9._-]{1,64}$` / no
  leading `-` rule as the id before anything else happens to it. A task that
  fails that check is thrown out with a logged error and **no result file** —
  unlike a merely misspelled task (below), which is whitelist-rejected and does
  get a result. Both must then be one of the whitelisted tasks below.
- `params` — only read by tasks that take parameters.

### The task whitelist

The whitelist is a `case` statement in `scripts/poll-run-requests.sh` — it is
**code, not data**. Adding a task means editing and pushing that file.

| `task` | What runs | Params | Timeout |
| --- | --- | --- | --- |
| `evidence-capture` | `node scripts/process-evidence-requests.js` — the same capture step the nightly runs, fetching the URLs queued in `config/evidence-requests.json` and pushing the HTML to `evidence-inbox` | none | 15 min |
| `validation-dry-run` | `SCRAPER_TARGET_COUNTIES=… SCRAPER_MAX_PAGE=… node index.js --dry-run --skip-price-check` — scrapes and reports, writes nothing to Airtable | `counties` (required, e.g. `Wayne\|KY,Shannon\|MO`), `maxPage` (optional integer 1–5, default 1) | 60 min |

Anything else is rejected: the run isn't dispatched, the result file says
`Unknown task`, and the id stays recorded so a typo can't loop.

### Reading the result

Every handled request pushes `data/run-results/<id>.json` to the
`evidence-inbox` branch:

```json
{
  "id": "2026-07-31-wayne-check",
  "task": "validation-dry-run",
  "startedAt": "2026-07-31T18:15:04Z",
  "finishedAt": "2026-07-31T18:19:41Z",
  "exitCode": 0,
  "warning": "",
  "logTail": "…last 100 lines of the task's output…"
}
```

`exitCode` is the task's own exit code, except for two reserved values the
poller sets when it dispatched nothing: **64** = unknown task, **65** = invalid
params. `warning` carries self-update / `npm install` trouble (the task still
ran, just possibly on older code — same philosophy as the nightly).

**The poller never force-pushes `evidence-inbox`.** The branch also carries the
nightly's captured HTML — pages only this Mac's residential IP can fetch — so
publishing is a **compare-and-swap**, not an overwrite. Each attempt reads the
remote branch fresh (`git ls-remote`, then a bounded `git fetch`), builds the
result commit on exactly that tip, and pushes with
`--force-with-lease=evidence-inbox:<the sha it just read>`. The push lands only
if the branch is still that sha (or, when the branch doesn't exist yet, only if
it still doesn't exist), so a result can only ever *add* to what was there.

If the branch moved in between, the attempt is rejected and the whole thing
starts over from a fresh read — three attempts. And if the remote can't be read
at all (network down, a clone that never fetched the branch), the poller does
**not** publish: it logs an `ERROR` and leaves the result at
`data/run-results/<id>.json` on the Mac. That ordering is deliberate —
**evidence preservation beats result delivery**. An undelivered result costs one
round trip (the assistant sees no result file and re-requests with a fresh id);
destroyed evidence costs a capture only this machine can produce, silently.

To be precise about what that guarantee covers: it is a promise about the
**poller's result publishing**, not about the branch's lifetime. The evidence
capture step itself (`scripts/process-evidence-requests.js` — run nightly, or
as a dispatched `evidence-capture` task) deliberately rebuilds `evidence-inbox`
from `main` and force-pushes it: the branch is a **disposable inbox** by
design, and each new capture clears out whatever earlier captures and result
files were still sitting in it. Within a single dispatched capture the result
is published *after* the capture's own push, so that run's evidence and its
result both land together — but neither should be treated as archived. The
assistant is expected to collect promptly; anything worth keeping gets pulled
off the inbox, never left on it.

### Security model

This does **not** widen who can run code on the Mac. Anyone who can push to
`main` already has code execution here — `scripts/run-scraper.sh` fast-forwards
to `main` and runs it every night. What the poller changes is the *window*:
from ~24 hours down to ~15 minutes, and only for the two whitelisted tasks.

The properties that keep it that narrow:

- The request file names a **task**, never a command. Nothing read out of the
  JSON is ever `eval`'d, sourced, or handed to a shell.
- The `id` and the `task` are both allowlisted to `[A-Za-z0-9._-]`, ≤64
  characters, **no leading `-`**, before either is used in a path or a command
  argument. The leading-dash rule is not cosmetic: a value like `-e` or
  `--require` is a legal file name but an *option* once it reaches an argument
  list, and `node -e <ours> -e <theirs>` runs *theirs*. A filesystem allowlist
  is not automatically an argv allowlist — they are different sinks.
- Nothing out of the JSON is passed to `node` as an argument at all. The parser
  reads the request on **stdin**; the result builder reads its values from the
  **environment**. Neither is an option list, so there is nothing to smuggle an
  option into. This is deliberately belt-and-braces with the bullet above: the
  result file is written for *every* accepted request, including ones the
  whitelist rejected, so it is the one step no request can skip.
- `params` are pattern-checked against anchored regexes and then passed to
  `env` as single `NAME=value` argv elements.
- Requests are read with `git show origin/main:config/run-requests.json` — the
  working tree is never touched, so the checkout can't be left dirty or off
  `main` (which would break the nightly's `--ff-only` self-update and silently
  freeze production on old code). Results are committed from a throwaway
  worktree outside the checkout.
- Every git, `npm install` and task invocation is wrapped in the repo's portable
  `perl -e 'alarm shift; exec @ARGV'` timeout, so nothing can hold the run lock
  indefinitely — and each ceiling is a named constant at the top of the script,
  because the scheduled-scrape blackout below is computed from them.

### Never at the expense of the nightly

Sharing the run lock protects the nightly from *interleaving* with a request,
but not from being *starved* by one. The nightly does not queue behind a busy
lock — `run-scraper.sh` exits 75 and `StartCalendarInterval` does not retry, so
a lock still held at 2:00 AM costs the entire night: no scrape, no price check,
no intake, no review, no email. And the timing lines up badly on its own: the
`pmset repeat` wake in step 1 is at **01:55**, launchd runs a missed
`StartInterval` job the moment the machine wakes, and a `validation-dry-run` may
run for an hour.

So the poller will not *start* a task when a scheduled scrape is too close:

- The scheduled times are `02:00` and `12:30` (matching the two launchd scrape
  jobs). Override with `POLLER_SCHEDULED_RUN_TIMES="HH:MM HH:MM"` if you move
  them; set it empty to disable the guard entirely.
- The window is sized to **the task's own timeout plus the whole post-accept
  timeout budget** — because the lock is held for a good deal longer than the
  task itself: `git merge --ff-only` (2 min), `npm install` (10 min ceiling),
  building the result file (1 min), and up to three publish attempts of
  ls-remote + fetch + worktree prune/add/commit/remove/prune + push (10 min
  each). That budget is **43 minutes**, plus a 5-minute rounding margin, so
  `evidence-capture` (15 min ceiling) stands down for the last **63 minutes**
  before a scrape and `validation-dry-run` (60 min) for the last **108** — plus
  15 minutes *after* each scheduled start, covering the case where launchd fires
  both jobs at once and the poller wins the lock.
- The slack is **computed in the script** from those ceilings
  (`POST_ACCEPT_TIMEOUT_BUDGET_SECONDS` → `BLACKOUT_MINUTES_SLACK`), never
  hand-picked. If you change a timeout, the blackout follows automatically —
  which is the point, because a slack that no longer covers the real lock hold
  is exactly how the poller ends up still holding it at 2:00 AM.
- A deferred request is **not consumed**: the id stays unrecorded and the first
  cycle after the window runs it. The poller logs one `Deferring run request…`
  line per cycle so a quiet 01:56 has an explanation.
- Once a task *is* accepted, the poller holds off **idle sleep** for as long as
  it holds the lock (`caffeinate -i -w $$`, started right after the lock is
  taken and dying with the poller). Wall-clock minutes are what the blackout
  reserves, and a Mac that dozes off mid-task spends them without doing any
  work — which is another way to still be holding the lock at 02:00. macOS
  only; a no-op anywhere else.

Queue anything long-running well clear of 02:00 and 12:30 — or just accept the
delay, which is at most an hour and three quarters.

### Install it

One paste, from the scraper folder on the production Mac:

```bash
mkdir -p ~/Library/LaunchAgents
cp services/com.ccl.run-request-poller.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.ccl.run-request-poller.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.ccl.run-request-poller.plist
```

Verify it loaded:

```bash
launchctl list | grep com.ccl.run-request-poller
```

### Logs and limits

Logs land in `services/land-scraper/logs/` as `poller-YYYY-MM-DD.log` (poller
activity — **errors and actions only**, because this runs 96 times a day) and
`run-request-<id>.log` (the task's own output). Both are deleted after 30 days,
same as the nightly's logs, as are the local copies of the published results in
`data/run-results/`. That cleanup runs at the **top** of every poll, not the
bottom: nearly every one of the 96 daily polls exits early (nothing queued, id
already handled, blackout, busy lock), and retention that ran only on the polls
that dispatched something would almost never run at all.

`StartInterval` only fires **while the Mac is awake**. A request queued
overnight is picked up within 15 minutes of the machine waking (or by the
`RunAtLoad` poll at login), not at 3 AM while it sleeps. The 1:55 AM
`pmset repeat` wake in step 1 is for the nightly run, not for this.
