#!/bin/bash
# CCL Land Scraper — launchd wrapper
# Schedule: 2:00 AM daily on Classic's iMac (nightly: scrape + price check +
# intake + review + evidence capture, one email), plus an optional 12:30 PM
# midday sweep (services/com.ccl.land-scraper.midday.plist, SCRAPER_MIDDAY=1:
# scrape + intake only, no price check/review/evidence — see index.js and the
# quiet-if-empty gate in lib/notify.js). Both services run this SAME script
# and share the SAME run lock below, so a midday run can never overlap a
# nightly one (or vice versa).
# Service: com.ccl.land-scraper (+ com.ccl.land-scraper.midday)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
# Midday runs get their own log file so a same-day nightly/midday pair don't
# interleave into one file.
LOG_SUFFIX=""
MODE_LABEL="nightly"
if [ "${SCRAPER_MIDDAY:-}" = "1" ]; then
  LOG_SUFFIX="-midday"
  MODE_LABEL="midday"
fi
LOG_FILE="$LOG_DIR/scrape-$(date +%Y-%m-%d)${LOG_SUFFIX}.log"

mkdir -p "$LOG_DIR"

# Nightly's banner text is unchanged from before this feature; midday gets an
# explicit mode tag so its log is unambiguous at a glance.
if [ "$MODE_LABEL" = "midday" ]; then
  echo "=== Scraper starting (midday) at $(date) ===" >> "$LOG_FILE"
else
  echo "=== Scraper starting at $(date) ===" >> "$LOG_FILE"
fi

cd "$SCRIPT_DIR"

# Nightly keeps the original "scraper" job label unchanged; only midday gets a
# distinguishing suffix, so the nightly run's on-disk lock stays byte-for-byte
# identical to before this feature.
if [ "$MODE_LABEL" = "midday" ]; then
  LOCK_JOB_LABEL="scraper-midday"
else
  LOCK_JOB_LABEL="scraper"
fi

# The lock rules (stale-steal with PID/comm liveness + grace, the EXIT-trap
# release, the exit-75 contract) live in scripts/run-lock.sh so the run-request
# poller (scripts/poll-run-requests.sh) takes the identical lock instead of
# reimplementing it. Nothing about this job's on-disk lock or its log lines
# changed when that code moved out of this file.
source "$SCRIPT_DIR/scripts/run-lock.sh"
if ! acquire_run_lock "$LOCK_JOB_LABEL" "$LOG_FILE"; then
  exit 75
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node was not found in PATH" >> "$LOG_FILE"
  exit 127
fi

# --- Self-update -----------------------------------------------------------
# Production kept drifting behind GitHub (new parsers never ran because
# nobody pulled). Fast-forward to origin/main before every run. A failed
# update NEVER blocks the night's run — the run proceeds on current code and
# the email carries the warning via SCRAPER_UPDATE_WARNING.
#
# The run lock is held for the whole self-update, so a stalled fetch must not
# be allowed to hang forever (it would wedge every subsequent night). macOS
# ships no `timeout` binary but always has perl, so `perl -e 'alarm shift;
# exec @ARGV' SECONDS cmd...` is used as a portable timeout: alarm() fires
# SIGALRM into the exec'd process; git doesn't catch it, so the default
# (terminate) disposition applies and the shell sees a nonzero/signal exit
# code, which is treated the same as any other fetch/merge failure below.
UPDATE_WARNING=""
NPM_INSTALL_SENTINEL="$SCRIPT_DIR/services/land-scraper/.npm-install-retry"
if git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CURRENT_BRANCH="$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [ "$CURRENT_BRANCH" = "main" ]; then
    BEFORE_REV="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    # No TTY under launchd — a credential prompt on a stalled/misconfigured
    # remote would otherwise hang forever instead of failing fast.
    export GIT_TERMINAL_PROMPT=0
    if perl -e 'alarm shift; exec @ARGV' 120 \
        git -C "$SCRIPT_DIR" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
        fetch origin main >> "$LOG_FILE" 2>&1; then
      if perl -e 'alarm shift; exec @ARGV' 120 \
          git -C "$SCRIPT_DIR" merge --ff-only origin/main >> "$LOG_FILE" 2>&1; then
        :
      else
        UPDATE_WARNING="Self-update failed: $SCRIPT_DIR has local edits or diverged from GitHub — production is running OLD code. Run 'git status' there and reconcile."
      fi
    else
      UPDATE_WARNING="Self-update failed: could not reach GitHub, or the fetch stalled and was killed after 120s — running possibly outdated code"
    fi
    unset GIT_TERMINAL_PROMPT
    AFTER_REV="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    if [ "$BEFORE_REV" != "$AFTER_REV" ]; then
      echo "Self-update: $BEFORE_REV -> $AFTER_REV" >> "$LOG_FILE"
    fi
    # `git merge --ff-only` above already advanced HEAD, so BEFORE/AFTER can't
    # gate npm install on its own: if npm install then fails, next night's
    # revs are equal and a plain rev-check would never retry, leaving new
    # code running on stale node_modules indefinitely. A sentinel file
    # (outside $LOCK_DIR, which is removed every run) survives across nights
    # so a failed install is retried until it succeeds.
    if [ "$BEFORE_REV" != "$AFTER_REV" ] || [ -f "$NPM_INSTALL_SENTINEL" ]; then
      if [ -f "$NPM_INSTALL_SENTINEL" ] && [ "$BEFORE_REV" = "$AFTER_REV" ]; then
        echo "Retrying npm install (previous attempt failed)" >> "$LOG_FILE"
      fi
      if npm install --silent --no-audit --no-fund >> "$LOG_FILE" 2>&1; then
        rm -f "$NPM_INSTALL_SENTINEL"
      else
        touch "$NPM_INSTALL_SENTINEL"
        NPM_WARNING="'npm install' failed — run it manually in $SCRIPT_DIR (will retry automatically next run)"
        if [ -n "$UPDATE_WARNING" ]; then
          UPDATE_WARNING="$UPDATE_WARNING Also: $NPM_WARNING"
        else
          UPDATE_WARNING="Code was updated but $NPM_WARNING"
        fi
      fi
    fi
  else
    UPDATE_WARNING="Self-update skipped: checkout is on branch '$CURRENT_BRANCH', not main — production may be running OLD code"
  fi
fi
[ -n "$UPDATE_WARNING" ] && echo "WARNING: $UPDATE_WARNING" >> "$LOG_FILE"
export SCRAPER_UPDATE_WARNING="$UPDATE_WARNING"
export SCRAPER_GIT_COMMIT="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# ---------------------------------------------------------------------------

# Run the scraper, capturing all output. Keep logging even if Node fails.
set +e
"$NODE_BIN" index.js >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
set -e

echo "=== Scraper finished at $(date) with exit code $EXIT_CODE ===" >> "$LOG_FILE"

# --- Evidence capture (post-scrape, NIGHTLY ONLY) ---------------------------
# Fetch the URLs the assistant queued in config/evidence-requests.json and push
# the rendered HTML to the disposable `evidence-inbox` branch. Runs AFTER the
# scrape + email so it never delays lead generation, and is fully guarded with
# `|| true`: a capture/push failure must never fail the night's run or change
# its exit code. Idempotent (already-captured URLs are skipped), ~8 requests, so
# holding the run lock for it is fine.
#
# Skipped entirely on a midday run (SCRAPER_MIDDAY=1) — it's a light scrape+
# intake sweep, and evidence capture stays a nightly-only step.
if [ "${SCRAPER_MIDDAY:-}" = "1" ]; then
  echo "=== Evidence capture skipped (midday run) ===" >> "$LOG_FILE"
else
  echo "=== Evidence capture starting at $(date) ===" >> "$LOG_FILE"
  # The evidence step fetches URLs and pushes to a branch WHILE STILL HOLDING the
  # run lock, so a stalled fetch/push must not be allowed to hang forever (it would
  # wedge every subsequent night). Bound it with the same portable perl-alarm
  # timeout the self-update block uses (macOS ships no `timeout` binary), and set
  # GIT_TERMINAL_PROMPT=0 (scoped to this step) so a misconfigured remote fails
  # fast under launchd's no-TTY session instead of blocking on a credential prompt.
  # Still fully `|| true`: a timeout or failure here must never fail the night's
  # run or change its exit code.
  export GIT_TERMINAL_PROMPT=0
  perl -e 'alarm shift; exec @ARGV' 600 \
      "$NODE_BIN" scripts/process-evidence-requests.js >> "$LOG_FILE" 2>&1 || true
  unset GIT_TERMINAL_PROMPT
  echo "=== Evidence capture finished at $(date) ===" >> "$LOG_FILE"
fi
# ---------------------------------------------------------------------------

# Clean up old logs and evidence files
find "$LOG_DIR" -name "scrape-*.log" -mtime +30 -delete 2>/dev/null || true
find "$SCRIPT_DIR/data/source-health" -name "*.jsonl" -mtime +30 -delete 2>/dev/null || true
find "$SCRIPT_DIR/data/source-health/snapshots" -name "*.html" -mtime +30 -delete 2>/dev/null || true
# Replayed failed-write files (keep 90 days of history; pending files are kept until replayed)
find "$SCRIPT_DIR/data/failed-writes/done" -name "*.jsonl" -mtime +90 -delete 2>/dev/null || true

# Rotate launchd stdout/stderr logs (appended forever otherwise)
for LAUNCHD_LOG in "$LOG_DIR"/launchd-*.log; do
  if [ -f "$LAUNCHD_LOG" ] && [ "$(wc -c < "$LAUNCHD_LOG")" -gt 5242880 ]; then
    tail -c 1048576 "$LAUNCHD_LOG" > "$LAUNCHD_LOG.tmp" && mv "$LAUNCHD_LOG.tmp" "$LAUNCHD_LOG"
  fi
done

exit $EXIT_CODE
