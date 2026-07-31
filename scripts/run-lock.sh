#!/bin/bash
# CCL Land Scraper — shared run lock (SOURCE this file; do not execute it)
#
# Every job that can touch the production checkout takes the SAME lock with the
# SAME rules. There are three callers, and they are all of them:
#   - scripts/run-scraper.sh   — the 2:00 AM nightly and the 12:30 PM midday
#                                sweep (job labels "scraper"/"scraper-midday")
#   - scripts/run-review.sh    — the manual lead review (job label "review")
#   - scripts/poll-run-requests.sh — the 15-minute run-request poller (job
#                                label "run-request")
# The rules used to live inline in run-scraper.sh AND, verbatim, in
# run-review.sh; they were lifted here when the poller arrived and would have
# made a third copy, because a second hand-written copy of "is this lock stale?"
# would eventually drift and let two runs scrape/write Airtable at the same time.
#
# Usage:
#   source "$SCRIPT_DIR/scripts/run-lock.sh"
#   if ! acquire_run_lock "scraper" "$LOG_FILE"; then
#     exit 75
#   fi
#
# Only two things vary per caller: the job label written to $RUN_LOCK_DIR/job
# and the log file the lock's messages are appended to. Everything else — lock
# path, max age, stale grace, message wording, on-disk file names — is fixed
# here on purpose. Every caller's on-disk lock and log lines must stay
# byte-for-byte what they were before this file existed; that lock is the only
# thing standing between production and two concurrent Airtable writers.
#
# acquire_run_lock installs an EXIT trap that removes the lock. Callers must
# NOT install their own EXIT trap afterwards or the lock will outlive the run
# and wedge every later job until the stale-steal grace expires.
#
# Contract: returns 0 holding the lock; returns 75 (EX_TEMPFAIL, the code
# run-scraper.sh has always exited with) when the lock is held by a live run or
# exists but is too fresh to steal. Callers decide what a busy lock means —
# run-scraper.sh and run-review.sh exit 75, the poller exits 0 and retries on
# its next cycle.

# All three callers live in scripts/, so the repo root is one level up. Resolved
# from BASH_SOURCE rather than $0 because this file is sourced, not run: $0
# would be the *caller's* path, which happens to work today but silently breaks
# the moment something sources this from elsewhere.
RUN_LOCK_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_LOCK_DIR="$RUN_LOCK_REPO_DIR/services/land-scraper/.run.lock"

# A full nightly (scrape + price check + intake + review + evidence) has never
# come close to 8 hours; past that the lock holder is assumed wedged and we say
# so loudly rather than silently skipping night after night.
LOCK_MAX_AGE_SECONDS=28800

acquire_run_lock() {
  if [ "$#" -ne 2 ]; then
    echo "acquire_run_lock: usage: acquire_run_lock <job_label> <log_file>" >&2
    return 64
  fi
  local job_label="$1"
  local log_file="$2"

  # Lock rules:
  #  - Never steal a lock whose holder PID is alive (removing it would let the
  #    holder's EXIT trap delete OUR lock and allow a third concurrent run).
  #  - A lock with a dead/missing PID is stale after a short grace period —
  #    the grace covers the instant between another process's mkdir and its
  #    metadata write. Age falls back to the lock dir's mtime so a crash that
  #    left no metadata can never deadlock every future run.
  local STALE_GRACE_SECONDS=300
  local LOCK_PID LOCK_STARTED NOW LOCK_AGE HOLDER_ALIVE
  local LOCK_COMM_RECORDED LOCK_COMM_NOW

  mkdir -p "$(dirname "$RUN_LOCK_DIR")"

  if ! mkdir "$RUN_LOCK_DIR" 2>/dev/null; then
    LOCK_PID="$(cat "$RUN_LOCK_DIR/pid" 2>/dev/null || echo "")"
    LOCK_STARTED="$(cat "$RUN_LOCK_DIR/started_epoch" 2>/dev/null || echo 0)"
    case "$LOCK_STARTED" in
      ''|*[!0-9]*) LOCK_STARTED=0 ;;
    esac
    if [ "$LOCK_STARTED" -eq 0 ]; then
      # BSD stat first (macOS production), GNU stat fallback; GNU's -f mode can
      # emit filesystem text before failing, so keep only the last line and
      # re-sanitize to digits
      LOCK_STARTED="$( { stat -f %m "$RUN_LOCK_DIR" 2>/dev/null || stat -c %Y "$RUN_LOCK_DIR" 2>/dev/null || echo 0; } | tail -n 1 )"
      case "$LOCK_STARTED" in
        ''|*[!0-9]*) LOCK_STARTED=0 ;;
      esac
    fi
    NOW="$(date +%s)"
    LOCK_AGE=$((NOW - LOCK_STARTED))

    HOLDER_ALIVE=false
    case "$LOCK_PID" in
      ''|*[!0-9]*) : ;;
      *)
        if kill -0 "$LOCK_PID" 2>/dev/null; then
          # Guard against PID reuse after a reboot: only trust a live PID if
          # its command name still matches what the lock holder recorded
          LOCK_COMM_RECORDED="$(cat "$RUN_LOCK_DIR/comm" 2>/dev/null || echo "")"
          LOCK_COMM_NOW="$(ps -o comm= -p "$LOCK_PID" 2>/dev/null || echo "")"
          if [ -z "$LOCK_COMM_RECORDED" ] || [ "$LOCK_COMM_RECORDED" = "$LOCK_COMM_NOW" ]; then
            HOLDER_ALIVE=true
          fi
        fi
        ;;
    esac

    if [ "$HOLDER_ALIVE" = true ]; then
      if [ "$LOCK_AGE" -gt "$LOCK_MAX_AGE_SECONDS" ]; then
        echo "WARNING: run lock held by live pid $LOCK_PID for ${LOCK_AGE}s (> ${LOCK_MAX_AGE_SECONDS}s) — investigate a wedged run" >> "$log_file"
      fi
      echo "ERROR: another scraper/review run is already active (pid $LOCK_PID); exiting without starting" >> "$log_file"
      return 75
    fi

    if [ "$LOCK_AGE" -le "$STALE_GRACE_SECONDS" ]; then
      echo "ERROR: run lock exists and is too fresh to steal (age ${LOCK_AGE}s); exiting without starting" >> "$log_file"
      return 75
    fi

    echo "WARNING: removing stale run lock (holder pid '${LOCK_PID:-none}' not running, age ${LOCK_AGE}s)" >> "$log_file"
    # Steal atomically via rename so two simultaneous stealers cannot both win
    if ! mv "$RUN_LOCK_DIR" "$RUN_LOCK_DIR.stale.$$" 2>/dev/null; then
      echo "ERROR: lost the race re-taking the run lock; exiting without starting" >> "$log_file"
      return 75
    fi
    rm -rf "$RUN_LOCK_DIR.stale.$$"
    if ! mkdir "$RUN_LOCK_DIR" 2>/dev/null; then
      echo "ERROR: lost the race re-taking the run lock; exiting without starting" >> "$log_file"
      return 75
    fi
  fi

  # Single-quoted so $RUN_LOCK_DIR is read at trap time from the global set
  # above — the lock must be released no matter how the caller exits.
  trap 'rm -rf "$RUN_LOCK_DIR"' EXIT
  date +%s > "$RUN_LOCK_DIR/started_epoch"
  # $$ is the caller's shell PID even in here: this is a sourced function, not
  # a subshell, so the recorded PID really is the process holding the lock.
  echo "$$" > "$RUN_LOCK_DIR/pid"
  ps -o comm= -p $$ > "$RUN_LOCK_DIR/comm" 2>/dev/null || true
  echo "$job_label" > "$RUN_LOCK_DIR/job"
  return 0
}
