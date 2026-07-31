#!/bin/bash
# CCL Land Scraper — remote run-request poller
# Schedule: every 15 minutes on Classic's iMac (services/com.ccl.run-request-poller.plist).
# Service: com.ccl.run-request-poller
#
# Why this exists: the assistant's only channel to the production Mac is
# GitHub, and the Mac only acted on its 2:00 AM nightly and 12:30 PM midday
# schedules. Anything the assistant needed from that machine — a page capture
# from the residential IP, a targeted dry-run against a county — meant waiting
# for the next 2 AM. This poller reads a request file from GitHub every 15
# minutes and runs it, so the wait is minutes instead of hours.
#
# What it is NOT: a remote shell. The request file names a TASK from a
# hardcoded whitelist (the `case` statement below); it never carries a command.
# Nothing read out of the JSON is ever eval'd, sourced, or passed to a shell.
#
# Two rules make that hold, and BOTH are load-bearing:
#   1. Every value out of the JSON is allowlisted before use — the id and the
#      task against ^[A-Za-z0-9._-]{1,64}$, the params against anchored
#      patterns — and no value may begin with '-'.
#   2. No value out of the JSON is ever passed to `node` as an argv element.
#      They go in through the environment (the result builder) or on stdin (the
#      parser). This matters because argv is an OPTION list: `node -e <ours>
#      -e <theirs>` runs THEIRS (the last -e wins), and `-r <path>` is
#      --require. An id of `-e` plus a task of arbitrary JS would have been
#      remote code execution through a path that never touches a shell. Rule 1
#      alone would stop it; rule 2 alone would stop it; we do both, because a
#      future edit that adds one more `node -e ... "$SOMETHING"` should have to
#      get past two locks, not one.
#
# The security posture is unchanged from before this file existed: anyone who
# can push to `main` already gets code execution here via the nightly's
# self-update. This only narrows that window from ~24h to ~15min, and only for
# the two whitelisted tasks.
#
# It shares the run lock with the nightly and midday scrapes (scripts/run-lock.sh),
# so a request can never run on top of a scrape — and it refuses to start at all
# when a scheduled scrape is close enough that the task could still be holding
# that lock when the scrape wakes up (see "scheduled_run_is_too_close" below).
#
# This script must NEVER leave the checkout dirty or off `main` — the nightly's
# `git merge --ff-only` self-update would start failing and production would
# silently run old code. It therefore only ever READS from git objects
# (`git show origin/main:...`), fast-forwards, and does its committing in a
# throwaway worktree outside the checkout.
#
# It also never force-pushes the results branch. Results share `evidence-inbox`
# with the nightly's captured HTML, which only this machine's residential IP can
# produce; the publish in step 8 is a compare-and-swap against a tip read moments
# earlier, and when it can't prove what it is overwriting it doesn't push at all.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
LOG_FILE="$LOG_DIR/poller-$(date +%Y-%m-%d).log"
# Last handled request id, one line. Lives next to the nightly's npm-install
# sentinel (NOT inside the lock dir, which is deleted after every run) so a
# handled id survives reboots and lock churn.
STATE_FILE="$SCRIPT_DIR/services/land-scraper/.run-requests-handled"
REQUEST_PATH="config/run-requests.json"
RESULTS_DIR="$SCRIPT_DIR/data/run-results"
RESULTS_BRANCH="evidence-inbox"
GIT_REMOTE="origin"
NPM_INSTALL_SENTINEL="$SCRIPT_DIR/services/land-scraper/.npm-install-retry"

# Exit codes recorded in the result file when nothing was dispatched. Chosen
# from sysexits so they can't collide with a real scraper exit code.
EXIT_CODE_UNKNOWN_TASK=64
EXIT_CODE_INVALID_PARAMS=65

# --- Timeout budget ---------------------------------------------------------
# Every command below that can block on the network or on npm's registry is
# wrapped in `run_with_timeout` with one of these ceilings. They are NAMED
# constants rather than numbers spelled at the call sites for one specific
# reason: the scheduled-scrape blackout further down is COMPUTED from them.
#
# The blackout has to reserve the entire span for which this script may hold the
# shared run lock — which is not just the task's own ceiling, it is
# self-update + npm install + task + result publish. A hand-picked slack number
# is wrong the moment any one of those changes, and "wrong" here means the
# poller is still holding the lock at 02:00 and the night's scrape is cancelled.
# So the slack is derived, and every ceiling that contributes to it is used from
# exactly one place.
GIT_FETCH_TIMEOUT_SECONDS=60
GIT_MERGE_TIMEOUT_SECONDS=120
GIT_PUSH_TIMEOUT_SECONDS=120
# worktree add, git add, git commit, worktree remove — all local, all bounded
# because a stuck index.lock is exactly the kind of thing that hangs forever.
GIT_LOCAL_TIMEOUT_SECONDS=60
# `npm install` is the one command here that legitimately wants minutes: a
# dependency bump can pull the Playwright browser bundle down residential
# broadband. It still MUST have a ceiling. Unbounded (as it was), it is the
# single command that can hold the run lock past a scheduled scrape no matter
# how carefully the rest of the budget is sized — the ceiling is what makes the
# blackout arithmetic below a guarantee instead of an estimate. A timeout is
# reported exactly like any other install failure: sentinel + warning, and the
# nightly retries it.
NPM_INSTALL_TIMEOUT_SECONDS=600
# Building the result JSON reads the dispatch log; a runaway task can leave a
# very large one, so even this gets a ceiling.
RESULT_BUILD_TIMEOUT_SECONDS=60

# One publish attempt = resolve_publish_target's ls-remote AND its fetch (two
# separate network round trips, both bounded by GIT_FETCH_TIMEOUT_SECONDS), then
# publish_result_file's worktree prune + worktree add + git add + git commit +
# worktree remove + the trailing cleanup prune (six local calls), then the push.
PUBLISH_ATTEMPT_TIMEOUT_SECONDS=$(( 2 * GIT_FETCH_TIMEOUT_SECONDS \
  + 6 * GIT_LOCAL_TIMEOUT_SECONDS + GIT_PUSH_TIMEOUT_SECONDS ))
# Three compare-and-swap attempts, each one re-resolving the remote tip first
# (see step 8). Never a force push — losing all three means the result stays on
# disk, which is the correct trade.
PUBLISH_ATTEMPTS=3

# Everything that can still be running AFTER the request is accepted and the
# lock is taken, other than the task itself. This is the number the blackout
# adds to the task's own ceiling.
POST_ACCEPT_TIMEOUT_BUDGET_SECONDS=$(( GIT_MERGE_TIMEOUT_SECONDS \
  + NPM_INSTALL_TIMEOUT_SECONDS \
  + RESULT_BUILD_TIMEOUT_SECONDS \
  + PUBLISH_ATTEMPTS * PUBLISH_ATTEMPT_TIMEOUT_SECONDS ))

# --- Scheduled-scrape blackout ----------------------------------------------
# The scrape schedules in local time, HH:MM, space separated. These MUST match
# the launchd jobs: 02:00 = services/com.ccl.land-scraper.plist, 12:30 =
# services/com.ccl.land-scraper.midday.plist.
#
# Why a blackout at all: the poller holds the SAME run lock as those jobs for
# the whole dispatch, and a validation-dry-run may legitimately run for an hour.
# The Mac is woken at 01:55 by `pmset repeat` (see services/README.md step 1),
# and launchd fires a missed StartInterval job the moment it wakes — so without
# this guard a request queued overnight starts at ~01:55, still holds the lock
# at 02:00, and run-scraper.sh exits 75 before `node index.js`. That is not a
# delayed nightly, it is a CANCELLED one: StartCalendarInterval does not retry,
# so there is no scrape, no price check, no intake, no review, and no email —
# the whole night lost to a one-line entry in a log nobody reads.
#
# So: don't start work that could still be running when a scrape is due. The
# request is not consumed (the id stays unrecorded), it just waits for a cycle
# after the window.
SCHEDULED_RUN_TIMES="${POLLER_SCHEDULED_RUN_TIMES-02:00 12:30}"
# A few minutes on top of the measured budget for the handful of steps that are
# local, bounded in practice, but not individually timed: the lock acquire, the
# mkdir/cp of the result file, `git worktree prune`, and the housekeeping
# `find`s. Deliberately small — it is a rounding allowance, not the guard.
BLACKOUT_MINUTES_MARGIN=5
# Kept clear of a scheduled start by the task's own ceiling plus this slack.
# DERIVED, not hand-picked: the lock is held across self-update, `npm install`,
# the task, and the result publish, and the earlier version reserved only the
# task ceiling plus a flat 15 minutes. That left ~20 minutes of real timeout
# budget (an unbounded `npm install` plus three publish attempts) outside the
# reservation, which is enough for a request accepted just before the window to
# still hold the lock when the scrape fires — the exact outcome this guard
# exists to prevent. Rounding up so a partial minute never under-reserves.
BLACKOUT_MINUTES_SLACK=$(( (POST_ACCEPT_TIMEOUT_BUDGET_SECONDS + 59) / 60 + BLACKOUT_MINUTES_MARGIN ))
# ...and for this long after a start, which covers only the race where launchd
# fires the poller and the scrape in the same minute and the poller wins the
# lock. Once the scrape holds the lock the poller loses it the normal way.
BLACKOUT_MINUTES_AFTER=15
# Set by scheduled_run_is_too_close so the log line can name the scrape.
BLACKOUT_SCHEDULED_TIME=""

mkdir -p "$LOG_DIR"
cd "$SCRIPT_DIR"

# This runs 96 times a day and is idle almost every time. Logging a heartbeat
# would bury the one line that matters under 96 that don't, so the quiet paths
# (no request, already-handled request) log NOTHING. Only errors and actions
# are written.
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

# --- Housekeeping -----------------------------------------------------------
# Deliberately FIRST, before the fetch and before anything can `exit 0`. The
# early exits are not the exception here, they are the common case: 96 polls a
# day and almost all of them stop at "no request file", "already handled this
# id", "a scrape is too close", "the run lock is busy" or "node is missing".
# Cleanup that lived at the bottom of the script therefore ran only on the rare
# poll that dispatched something, and the three things that accumulate — the
# poller's own daily log, the per-request dispatch logs, and the published
# result files (which nothing cleaned at all) — grew without bound on a Mac
# nobody logs into.
#
# 30 days, matching the nightly's retention. Every `find` is `|| true`: a
# cleanup failure (a missing dir on a fresh checkout, a permissions oddity) is
# never a reason to skip a poll.
housekeeping() {
  find "$LOG_DIR" -name "poller-*.log" -mtime +30 -delete 2>/dev/null || true
  find "$LOG_DIR" -name "run-request-*.log" -mtime +30 -delete 2>/dev/null || true
  find "$RESULTS_DIR" -name "*.json" -mtime +30 -delete 2>/dev/null || true
}
housekeeping

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  log "ERROR: node was not found in PATH — cannot poll for run requests"
  exit 0
fi

# No TTY under launchd — a credential prompt on a stalled/misconfigured remote
# would otherwise hang forever instead of failing fast. Every git command below
# is network-capable, so this is set once for the whole script.
export GIT_TERMINAL_PROMPT=0

# macOS ships no `timeout` binary but always has perl, so
# `perl -e 'alarm shift; exec @ARGV' SECONDS cmd...` is the portable timeout
# used throughout this repo (see scripts/run-scraper.sh): alarm() fires SIGALRM
# into the exec'd process; git/node don't catch it, so the default (terminate)
# disposition applies and the caller sees a nonzero exit — treated the same as
# any other failure.
run_with_timeout() {
  local seconds="$1"
  shift
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
}

# --- 1. Cheap poll ----------------------------------------------------------
# One quiet fetch. If GitHub is unreachable (Mac just woke, wifi flapping),
# log a single line and wait for the next cycle — there is nothing to recover.
#
# Not part of POST_ACCEPT_TIMEOUT_BUDGET_SECONDS: this runs before the request
# is accepted and before the run lock is taken, so it cannot delay a scrape.
if ! run_with_timeout "$GIT_FETCH_TIMEOUT_SECONDS" \
    git -C "$SCRIPT_DIR" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 \
    fetch --quiet "$GIT_REMOTE" main >> "$LOG_FILE" 2>&1; then
  log "ERROR: 'git fetch $GIT_REMOTE main' failed or timed out — skipping this cycle"
  exit 0
fi

# Read the request straight out of the fetched objects. Deliberately NOT
# `cat config/run-requests.json`: the working tree is on whatever commit the
# last self-update left, and touching it here is exactly what would break the
# nightly's ff-only update.
REQUEST_JSON="$(git -C "$SCRIPT_DIR" show "$GIT_REMOTE/main:$REQUEST_PATH" 2>/dev/null || echo "")"
if [ -z "$REQUEST_JSON" ]; then
  exit 0 # No request file on main at all — nothing to do, silently.
fi

# --- 2. Parse and validate --------------------------------------------------
# Parsed by node (guaranteed present on the Mac — the scraper is a node app)
# rather than by grep/sed, so a hand-edited file can't be half-understood. The
# JSON arrives on stdin, never as an argument, and comes back as tab-separated
# fields with tabs/newlines stripped from the values so one field can never
# forge another.
PARSED="$("$NODE_BIN" -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.log("MALFORMED");
      return;
    }
    const request = parsed && parsed.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      console.log("NONE");
      return;
    }
    const params = (request.params && typeof request.params === "object") ? request.params : {};
    const flat = (value) => (value == null ? "" : String(value)).replace(/[\t\r\n]/g, " ");
    console.log(["OK", flat(request.id), flat(request.task), flat(params.counties), flat(params.maxPage)].join("\t"));
  });
' <<< "$REQUEST_JSON" 2>> "$LOG_FILE" || echo "MALFORMED")"

# `|| true` because `read` reports 1 on a short/empty line, which is a shape we
# already handle below via PARSE_STATUS — not a reason to abort under `set -e`.
IFS=$'\t' read -r PARSE_STATUS REQUEST_ID REQUEST_TASK PARAM_COUNTIES PARAM_MAX_PAGE <<< "$PARSED" || true

if [ "$PARSE_STATUS" = "MALFORMED" ]; then
  log "ERROR: $REQUEST_PATH on $GIT_REMOTE/main is not valid JSON — ignoring it until it is fixed"
  exit 0
fi
if [ "$PARSE_STATUS" != "OK" ]; then
  exit 0 # "request": null — the idle state, and the committed template. Silent.
fi

# The id and the task both become parts of file names, log lines and command
# arguments, so BOTH are checked against the same strict allowlist before they
# are used anywhere. Rejecting (rather than sanitizing) is deliberate: a mangled
# id would make the result file impossible for the assistant to find.
#
# The leading-dash rule is the one that is easy to miss. `[A-Za-z0-9._-]` looks
# like a filesystem-safety check, and as one it is fine — but these values also
# end up in argv lists, where a value like `-e`, `-p` or `--require` stops being
# a name and becomes an OPTION. An allowlist that is correct for a path
# component is not automatically correct for an argv element; they are different
# sinks with different metacharacters. Hence: no leading dash, ever, for either
# field. (Rule 2 in the header — nothing from the JSON is passed as node argv —
# is the other half of this.)
#
# Prints why the value is unacceptable and returns 0 (reject); returns 1 when
# the value is fine.
reject_field_reason() {
  local field_value="$1"
  if [ -z "$field_value" ]; then
    echo "it is empty"
    return 0
  fi
  case "$field_value" in
    -*)
      echo "it starts with '-', which an argv list would read as an option"
      return 0
      ;;
    *[!A-Za-z0-9._-]*)
      echo "it must match ^[A-Za-z0-9._-]{1,64}\$"
      return 0
      ;;
  esac
  if [ "${#field_value}" -gt 64 ]; then
    echo "it is longer than 64 characters"
    return 0
  fi
  return 1
}

if REJECT_REASON="$(reject_field_reason "$REQUEST_ID")"; then
  log "ERROR: rejecting run request — the id is invalid: $REJECT_REASON (got: '$REQUEST_ID')"
  exit 0
fi
if REJECT_REASON="$(reject_field_reason "$REQUEST_TASK")"; then
  log "ERROR: rejecting run request '$REQUEST_ID' — the task is invalid: $REJECT_REASON (got: '$REQUEST_TASK')"
  exit 0
fi

# Already done? The state file is the at-most-once guard; see step 5.
LAST_HANDLED_ID="$(head -n 1 "$STATE_FILE" 2>/dev/null || echo "")"
if [ "$REQUEST_ID" = "$LAST_HANDLED_ID" ]; then
  exit 0 # Same request we already ran. Silent — this is the steady state.
fi

# --- 3. Stay out of the scheduled scrapes' way ------------------------------
# How long this task may hold the run lock. Declared here rather than at the
# dispatch site because the blackout check below needs it BEFORE the lock is
# taken, and two copies of "how long can this run" would eventually disagree.
case "$REQUEST_TASK" in
  # ~8 polite requests through real Chrome.
  evidence-capture) DISPATCH_TIMEOUT_SECONDS=900 ;;
  # A full sweep can legitimately take a while (browser fallback, polite delays).
  validation-dry-run) DISPATCH_TIMEOUT_SECONDS=3600 ;;
  # Nothing is dispatched for anything else; only the lock/self-update/publish
  # overhead applies, which BLACKOUT_MINUTES_SLACK already covers.
  *) DISPATCH_TIMEOUT_SECONDS=0 ;;
esac

# Returns 0 when a scheduled scrape is close enough that this task could still
# be holding the run lock when it fires (or has just fired).
scheduled_run_is_too_close() {
  local ceiling_seconds="$1"
  local now_minutes lead_minutes entry start_minutes minutes_until minutes_since

  # Local time on purpose: launchd's StartCalendarInterval is local time too.
  now_minutes=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))
  lead_minutes=$(( ceiling_seconds / 60 + BLACKOUT_MINUTES_SLACK ))

  for entry in $SCHEDULED_RUN_TIMES; do
    case "$entry" in
      [0-9][0-9]:[0-9][0-9]) : ;;
      # A malformed schedule entry is ignored rather than fatal — a typo here
      # must not stop the poller, and the remaining entries still guard.
      *) continue ;;
    esac
    # 10# forces base 10: "08" and "09" are not valid octal and would abort the
    # script under `set -e` without it.
    start_minutes=$(( 10#${entry%%:*} * 60 + 10#${entry##*:} ))
    minutes_until=$(( (start_minutes - now_minutes + 1440) % 1440 ))
    minutes_since=$(( (now_minutes - start_minutes + 1440) % 1440 ))
    if [ "$minutes_until" -le "$lead_minutes" ] || [ "$minutes_since" -le "$BLACKOUT_MINUTES_AFTER" ]; then
      BLACKOUT_SCHEDULED_TIME="$entry"
      return 0
    fi
  done
  return 1
}

if scheduled_run_is_too_close "$DISPATCH_TIMEOUT_SECONDS"; then
  # Logged, not silent: a request sitting in the window for up to an hour and a
  # half is worth ~6 lines a night, and "why did nothing happen at 01:56" is
  # exactly the question these lines answer. The id is NOT recorded, so the
  # first cycle after the window runs it.
  log "Deferring run request '$REQUEST_ID' ($REQUEST_TASK): the $BLACKOUT_SCHEDULED_TIME scheduled scrape is too close to risk holding the run lock — retrying after it"
  exit 0
fi

# --- 4. Take the shared run lock -------------------------------------------
# Same lock as the nightly and midday scrapes. A busy lock is NOT an error
# here: the nightly is mid-run, so exit 0 and let the next 15-minute cycle
# pick the request up. Critically, the id is NOT recorded yet — recording it
# now would silently swallow the request.
source "$SCRIPT_DIR/scripts/run-lock.sh"
if ! acquire_run_lock "run-request" "$LOG_FILE"; then
  exit 0
fi

# Hold off idle sleep for exactly as long as we hold the lock. macOS-only and a
# no-op anywhere else (there is no `caffeinate` on Linux, where the tests run).
#
# Why it matters: the blackout above reserves wall-clock minutes, and idle sleep
# does not pause the clock — a Mac that dozes off mid-task stretches a 15-minute
# capture across an hour of real time and can still be holding the lock when the
# 02:00 scrape fires, which is a cancelled night. The assertion is scoped, not
# global: `-i` blocks idle sleep only (the lid and a deliberate sleep still
# work), and `-w $$` ties it to this shell so it exits with the poller however
# the poller exits — no trap to forget and no stray process left behind.
# stdout/stderr are detached so it can never hold this log file's descriptor
# open or keep launchd waiting on the job.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -w $$ >/dev/null 2>&1 &
fi

# --- 5. Record the id BEFORE dispatching (at-most-once) ---------------------
# Deliberately before the work, not after. If a task wedges the Mac or the
# script dies mid-dispatch, recording afterwards would re-run it every 15
# minutes forever. The assistant reads the failure in the result file (or the
# absence of one) and re-triggers with a fresh id — a cheap, visible retry
# instead of an invisible loop.
echo "$REQUEST_ID" > "$STATE_FILE"
log "Run request '$REQUEST_ID' accepted (task: $REQUEST_TASK)"

# --- 6. Self-update, exactly like the nightly -------------------------------
# The point of a request is usually to exercise code the assistant just pushed,
# so pick it up first. The fetch already happened in step 1. As in the nightly,
# a failed update NEVER aborts the run: the task runs on current code and the
# result file carries the warning.
UPDATE_WARNING=""
CURRENT_BRANCH="$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$CURRENT_BRANCH" = "main" ]; then
  BEFORE_REV="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  if ! run_with_timeout "$GIT_MERGE_TIMEOUT_SECONDS" \
      git -C "$SCRIPT_DIR" merge --ff-only "$GIT_REMOTE/main" >> "$LOG_FILE" 2>&1; then
    UPDATE_WARNING="Self-update failed: $SCRIPT_DIR has local edits or diverged from GitHub — the task ran on OLD code."
  fi
  AFTER_REV="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ "$BEFORE_REV" != "$AFTER_REV" ]; then
    log "Self-update: $BEFORE_REV -> $AFTER_REV"
  fi
  # Same sentinel the nightly uses: `merge --ff-only` has already moved HEAD,
  # so a rev comparison alone would never retry a failed install. The sentinel
  # survives across runs (and is shared with the nightly) until it succeeds.
  if [ "$BEFORE_REV" != "$AFTER_REV" ] || [ -f "$NPM_INSTALL_SENTINEL" ]; then
    # Bounded, unlike the nightly's copy of this block — and the difference is
    # not cosmetic. The nightly OWNS the 2 AM slot, so a slow install there just
    # delays its own work. This script is a guest holding the same lock, and an
    # unbounded install is the one way it can still be holding it when the
    # scrape fires. The ceiling is generous (see NPM_INSTALL_TIMEOUT_SECONDS);
    # a timeout lands in the same failure branch as any other install failure,
    # so the sentinel is set and the nightly retries with no ceiling.
    if run_with_timeout "$NPM_INSTALL_TIMEOUT_SECONDS" \
        npm install --silent --no-audit --no-fund >> "$LOG_FILE" 2>&1; then
      rm -f "$NPM_INSTALL_SENTINEL"
    else
      touch "$NPM_INSTALL_SENTINEL"
      NPM_WARNING="'npm install' failed or exceeded ${NPM_INSTALL_TIMEOUT_SECONDS}s — run it manually in $SCRIPT_DIR (the nightly will retry it automatically)"
      if [ -n "$UPDATE_WARNING" ]; then
        UPDATE_WARNING="$UPDATE_WARNING Also: $NPM_WARNING"
      else
        UPDATE_WARNING="Code was updated but $NPM_WARNING"
      fi
    fi
  fi
else
  UPDATE_WARNING="Self-update skipped: checkout is on branch '$CURRENT_BRANCH', not main — the task ran on possibly OLD code"
fi
if [ -n "$UPDATE_WARNING" ]; then
  log "WARNING: $UPDATE_WARNING"
fi

# --- 7. Dispatch ------------------------------------------------------------
# The whitelist is this `case` statement — code, not data. Adding a task means
# editing this file and pushing it, which is a reviewed change; it can never be
# done from the request JSON.
DISPATCH_LOG="$LOG_DIR/run-request-$REQUEST_ID.log"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EXIT_CODE=0

# Tests set POLLER_TEST_MODE=1 so the suite can exercise the whole poll →
# validate → lock → record → dispatch → publish path without launching a real
# scrape. The substitute is a HARDCODED echo, never a command supplied by the
# environment or the request — a test hook that accepted a command string would
# be the remote shell this design is built to avoid.
run_dispatch() {
  if [ "${POLLER_TEST_MODE:-}" = "1" ]; then
    echo "TEST-DISPATCH $REQUEST_TASK" >> "$DISPATCH_LOG"
    return 0
  fi
  "$@" >> "$DISPATCH_LOG" 2>&1
}

set +e
case "$REQUEST_TASK" in
  evidence-capture)
    # Same step the nightly runs after its scrape: fetch the URLs queued in
    # config/evidence-requests.json through real Chrome and push the HTML to
    # the evidence-inbox branch. The ceiling was picked in step 3.
    run_dispatch run_with_timeout "$DISPATCH_TIMEOUT_SECONDS" "$NODE_BIN" scripts/process-evidence-requests.js
    EXIT_CODE=$?
    ;;

  validation-dry-run)
    # A targeted dry run — scrape a few counties, report, write nothing to
    # Airtable. Both parameters are pattern-checked before use; they are then
    # passed to `env` as single argv elements, so even a value that slipped
    # through the pattern could not become a second command.
    COUNTIES_PATTERN='^[A-Za-z .]+[|][A-Z]{2}(,[A-Za-z .]+[|][A-Z]{2})*$'
    if [ -z "$PARAM_MAX_PAGE" ]; then
      PARAM_MAX_PAGE=1
    fi
    if [[ ! "$PARAM_COUNTIES" =~ $COUNTIES_PATTERN ]]; then
      echo "Invalid params: counties must look like 'Wayne|KY' or 'Wayne|KY,Pittsburg|OK' (got: '$PARAM_COUNTIES')" >> "$DISPATCH_LOG"
      EXIT_CODE=$EXIT_CODE_INVALID_PARAMS
    elif [[ ! "$PARAM_MAX_PAGE" =~ ^[1-5]$ ]]; then
      echo "Invalid params: maxPage must be an integer from 1 to 5 (got: '$PARAM_MAX_PAGE')" >> "$DISPATCH_LOG"
      EXIT_CODE=$EXIT_CODE_INVALID_PARAMS
    else
      # The ceiling (step 3) is bounded because the run lock is held for the
      # whole thing — and step 3 also refused to start this at all if a
      # scheduled scrape were within that ceiling.
      run_dispatch run_with_timeout "$DISPATCH_TIMEOUT_SECONDS" \
        env "SCRAPER_TARGET_COUNTIES=$PARAM_COUNTIES" "SCRAPER_MAX_PAGE=$PARAM_MAX_PAGE" \
        "$NODE_BIN" index.js --dry-run --skip-price-check
      EXIT_CODE=$?
    fi
    ;;

  *)
    # Unknown task: report it and stop. The id stays recorded (step 4) so a
    # typo'd task doesn't retry every 15 minutes — the result file tells the
    # assistant what went wrong and it sends a corrected request.
    echo "Unknown task '$REQUEST_TASK'. Allowed tasks: evidence-capture, validation-dry-run." >> "$DISPATCH_LOG"
    EXIT_CODE=$EXIT_CODE_UNKNOWN_TASK
    ;;
esac
set -e

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Run request '$REQUEST_ID' finished (task: $REQUEST_TASK, exit code: $EXIT_CODE)"

# --- 8. Publish the result --------------------------------------------------
# The assistant can't read this Mac's disk, so the outcome goes back the only
# way it can: a small JSON file pushed to the disposable evidence-inbox branch.
mkdir -p "$RESULTS_DIR"
RESULT_FILE="$RESULTS_DIR/$REQUEST_ID.json"
# Built by node so every value is properly JSON-escaped (a task's log tail can
# contain quotes, backslashes, anything).
#
# The values go in through the ENVIRONMENT, not argv, and that is a security
# property rather than a style choice. `node -e <script> <values...>` keeps
# parsing the values as node's own options: a later `-e` beats the earlier one
# and `-r` is --require, so an id or task that happened to look like an option
# would execute instead of being written into a JSON field. This step runs on
# EVERY accepted request — including the ones the whitelist refused — so it is
# the last place that may hold a value-shaped-as-option sink. The environment
# has no such parsing. (The parser in step 2 reads its JSON from stdin for the
# same reason.)
#
# `env` rather than bare `VAR=… command` prefixes because the call is wrapped in
# run_with_timeout, which is a shell FUNCTION — assignments in front of a
# function call leak into the rest of the script in bash. Each `env` argument
# still begins with a fixed `RESULT_…=` prefix, so no request-derived value can
# be read as an option there either.
if ! run_with_timeout "$RESULT_BUILD_TIMEOUT_SECONDS" env \
     RESULT_ID="$REQUEST_ID" \
     RESULT_TASK="$REQUEST_TASK" \
     RESULT_STARTED_AT="$STARTED_AT" \
     RESULT_FINISHED_AT="$FINISHED_AT" \
     RESULT_EXIT_CODE="$EXIT_CODE" \
     RESULT_WARNING="$UPDATE_WARNING" \
     RESULT_LOG_PATH="$DISPATCH_LOG" \
     RESULT_OUT_PATH="$RESULT_FILE" \
     "$NODE_BIN" -e '
  const fs = require("fs");
  const env = process.env;
  let logTail = "";
  try {
    logTail = fs.readFileSync(env.RESULT_LOG_PATH, "utf8").split("\n").slice(-100).join("\n");
  } catch (err) {
    logTail = "(no dispatch log was produced)";
  }
  const result = {
    id: env.RESULT_ID,
    task: env.RESULT_TASK,
    startedAt: env.RESULT_STARTED_AT,
    finishedAt: env.RESULT_FINISHED_AT,
    exitCode: Number(env.RESULT_EXIT_CODE),
    warning: env.RESULT_WARNING,
    logTail,
  };
  fs.writeFileSync(env.RESULT_OUT_PATH, JSON.stringify(result, null, 2) + "\n");
' 2>> "$LOG_FILE"; then
  log "ERROR: could not write the result file $RESULT_FILE"
fi

# Resolve — FRESHLY, on every attempt — the two things a safe publish needs:
# the commit to build the result on, and the exact remote tip the push is
# allowed to replace. They are resolved together because they must agree: a base
# from one moment and an expectation from another is precisely the mismatch that
# lets a push overwrite something it never saw.
#
# The old version of this function fetched with `|| true` and fell back to
# `main` whenever it could not verify origin/evidence-inbox locally. Paired with
# a force push at the end of the ladder, that turned ONE transient fetch failure
# into "reset evidence-inbox to main plus this result" — every captured HTML
# file on the branch gone, silently. So a failure to read the remote now returns
# non-zero and the caller does not publish at all. Never fall back to main
# except when the remote has genuinely told us the branch does not exist.
#
# Prints "<base_ref>\t<expected_sha>"; expected_sha is empty when the branch is
# absent remotely, which is the lease's way of saying "expect no such ref".
resolve_publish_target() {
  local remote_line

  # `ls-remote` and not `fetch` first: it answers "does this branch exist, and
  # at what sha" without writing anything locally, so the absent-branch case
  # never has to be inferred from a missing local ref (which is also what a
  # never-fetched clone looks like — the exact confusion that caused the bug).
  if ! remote_line="$(run_with_timeout "$GIT_FETCH_TIMEOUT_SECONDS" \
      git -C "$SCRIPT_DIR" ls-remote --heads "$GIT_REMOTE" "$RESULTS_BRANCH" 2>> "$LOG_FILE")"; then
    return 1
  fi

  if [ -z "$remote_line" ]; then
    # The remote answered and the branch is not there: this publish creates it.
    printf 'main\t\n'
    return 0
  fi

  # The branch exists, so we must build on its actual tip. A failed fetch here
  # is NOT recoverable by using whatever origin/evidence-inbox happens to hold
  # locally — that ref can be hours stale, and a commit built on a stale tip is
  # a commit that drops everything pushed since.
  if ! run_with_timeout "$GIT_FETCH_TIMEOUT_SECONDS" \
      git -C "$SCRIPT_DIR" fetch --quiet "$GIT_REMOTE" "$RESULTS_BRANCH" >> "$LOG_FILE" 2>&1; then
    return 1
  fi
  local expected_sha
  expected_sha="$(git -C "$SCRIPT_DIR" rev-parse --verify --quiet "$GIT_REMOTE/$RESULTS_BRANCH" 2>/dev/null || echo "")"
  if [ -z "$expected_sha" ]; then
    return 1
  fi
  printf '%s\t%s\n' "$GIT_REMOTE/$RESULTS_BRANCH" "$expected_sha"
}

# Commit + push from a THROWAWAY WORKTREE (the pattern gitPushEvidence in
# scripts/process-evidence-requests.js uses), so the launchd checkout's branch
# and working tree are never touched. Every git call is timeout-bounded and the
# whole function is non-fatal: a failed publish must not fail the run.
publish_result_file() {
  local base_ref="$1"
  local expected_sha="$2"
  local worktree_dir status
  status=0

  worktree_dir="$(mktemp -d "${TMPDIR:-/tmp}/ccl-run-result-XXXXXX")" || return 1

  # Prune BEFORE the add, not just after. A previous run killed hard (SIGALRM
  # from run_with_timeout, a reboot mid-publish) leaves its worktree registered
  # against the results branch, and `worktree add -B` then refuses with "cannot
  # force update the branch ... used by worktree" — a leak that would otherwise
  # block every publish, and every nightly evidence push, until someone SSHes in.
  run_with_timeout "$GIT_LOCAL_TIMEOUT_SECONDS" git -C "$SCRIPT_DIR" worktree prune >> "$LOG_FILE" 2>&1 || true

  if run_with_timeout "$GIT_LOCAL_TIMEOUT_SECONDS" git -C "$SCRIPT_DIR" worktree add -f -B "$RESULTS_BRANCH" "$worktree_dir" "$base_ref" >> "$LOG_FILE" 2>&1; then
    # data/ is gitignored, so the add below needs -f to stage the result.
    mkdir -p "$worktree_dir/data/run-results"
    cp "$RESULT_FILE" "$worktree_dir/data/run-results/" \
      && run_with_timeout "$GIT_LOCAL_TIMEOUT_SECONDS" git -C "$worktree_dir" add -f data/run-results >> "$LOG_FILE" 2>&1 \
      && run_with_timeout "$GIT_LOCAL_TIMEOUT_SECONDS" git -C "$worktree_dir" \
        -c user.name="CCL Run Request Bot" \
        -c user.email="run-request-bot@classiccountryland.com" \
        commit -m "Run request result $REQUEST_ID ($REQUEST_TASK, exit $EXIT_CODE)" >> "$LOG_FILE" 2>&1 \
      || status=1

    if [ "$status" -eq 0 ]; then
      # Compare-and-swap, never a force. --force-with-lease=<branch>:<sha> lands
      # the push ONLY if the remote branch is still exactly the sha this
      # worktree was built on; an empty <sha> means "and only if it does not
      # exist yet". Either the remote is in the state we read a moment ago — in
      # which case our commit has every evidence file it had as an ancestor — or
      # the push is rejected and we start over from a fresh read. There is no
      # third outcome in which anything is overwritten unseen, which is the
      # whole reason the ladder no longer ends in `--force`.
      run_with_timeout "$GIT_PUSH_TIMEOUT_SECONDS" git -C "$worktree_dir" \
        push --force-with-lease="$RESULTS_BRANCH:$expected_sha" "$GIT_REMOTE" "$RESULTS_BRANCH" >> "$LOG_FILE" 2>&1 || status=1
    fi
  else
    status=1
  fi

  run_with_timeout "$GIT_LOCAL_TIMEOUT_SECONDS" git -C "$SCRIPT_DIR" worktree remove --force "$worktree_dir" >> "$LOG_FILE" 2>&1 || true
  rm -rf "$worktree_dir" || true
  run_with_timeout "$GIT_LOCAL_TIMEOUT_SECONDS" git -C "$SCRIPT_DIR" worktree prune >> "$LOG_FILE" 2>&1 || true
  return "$status"
}

# The publish ladder. Each rung re-reads the remote from scratch and pushes with
# a lease against exactly what it read, so the branch can only ever gain the
# result — it can never be rewound to whatever this Mac last happened to fetch.
#
# The ordering of priorities here is deliberate and is the opposite of what it
# used to be: EVIDENCE PRESERVATION BEATS RESULT DELIVERY. A result that never
# reaches the branch costs one round trip — the assistant sees no result file
# and re-requests with a fresh id, and the outcome is sitting in $RESULT_FILE on
# the Mac either way. Evidence destroyed by a blind force push costs the capture
# itself, which only the production Mac's residential IP can produce, and does
# it silently. So: three attempts, then stop.
publish_result() {
  local attempt=1 target base expected

  while [ "$attempt" -le "$PUBLISH_ATTEMPTS" ]; do
    if ! target="$(resolve_publish_target)"; then
      log "ERROR: could not read $GIT_REMOTE/$RESULTS_BRANCH (network, or the remote refused) — NOT publishing the result for '$REQUEST_ID'; it is on disk at $RESULT_FILE. Publishing without a verified base would mean pushing a branch built on main, which would destroy the evidence files on $RESULTS_BRANCH."
      return 1
    fi
    # `|| true` for the same reason as the request parse: `read` reports 1 on
    # the short line that the branch-creation case (empty expected sha) is.
    IFS=$'\t' read -r base expected <<< "$target" || true

    if publish_result_file "$base" "$expected"; then
      return 0
    fi

    if [ "$attempt" -lt "$PUBLISH_ATTEMPTS" ]; then
      # Either the lease was refused (someone pushed between our read and our
      # push — the nightly's evidence step is the likely someone) or the push
      # itself failed. Both are handled the same way: throw the worktree away,
      # read the remote again, rebuild on the new tip.
      log "Result publish attempt $attempt/$PUBLISH_ATTEMPTS did not land — re-reading $RESULTS_BRANCH and rebuilding on its current tip"
    fi
    attempt=$(( attempt + 1 ))
  done

  log "ERROR: could not publish the result for '$REQUEST_ID' to $RESULTS_BRANCH after $PUBLISH_ATTEMPTS attempts (it is still on disk at $RESULT_FILE)"
  return 1
}

publish_result || true

# Retention already ran at the top of this poll (see `housekeeping`), where the
# early-exit paths reach it too.

# The run lock is released by the EXIT trap that acquire_run_lock installed.
exit 0
