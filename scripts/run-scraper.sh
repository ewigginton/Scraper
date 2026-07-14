#!/bin/bash
# CCL Land Scraper — launchd wrapper
# Schedule: 2:00 AM daily on Classic's iMac
# Service: com.ccl.land-scraper

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
LOG_FILE="$LOG_DIR/scrape-$(date +%Y-%m-%d).log"
LOCK_DIR="$SCRIPT_DIR/services/land-scraper/.run.lock"
LOCK_MAX_AGE_SECONDS=28800

mkdir -p "$LOG_DIR"

echo "=== Scraper starting at $(date) ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

# Lock rules:
#  - Never steal a lock whose holder PID is alive (removing it would let the
#    holder's EXIT trap delete OUR lock and allow a third concurrent run).
#  - A lock with a dead/missing PID is stale after a short grace period —
#    the grace covers the instant between another process's mkdir and its
#    metadata write. Age falls back to the lock dir's mtime so a crash that
#    left no metadata can never deadlock every future run.
STALE_GRACE_SECONDS=300
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
  LOCK_STARTED="$(cat "$LOCK_DIR/started_epoch" 2>/dev/null || echo 0)"
  case "$LOCK_STARTED" in
    ''|*[!0-9]*) LOCK_STARTED=0 ;;
  esac
  if [ "$LOCK_STARTED" -eq 0 ]; then
    # BSD stat first (macOS production), GNU stat fallback; GNU's -f mode can
    # emit filesystem text before failing, so keep only the last line and
    # re-sanitize to digits
    LOCK_STARTED="$( { stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0; } | tail -n 1 )"
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
        LOCK_COMM_RECORDED="$(cat "$LOCK_DIR/comm" 2>/dev/null || echo "")"
        LOCK_COMM_NOW="$(ps -o comm= -p "$LOCK_PID" 2>/dev/null || echo "")"
        if [ -z "$LOCK_COMM_RECORDED" ] || [ "$LOCK_COMM_RECORDED" = "$LOCK_COMM_NOW" ]; then
          HOLDER_ALIVE=true
        fi
      fi
      ;;
  esac

  if [ "$HOLDER_ALIVE" = true ]; then
    if [ "$LOCK_AGE" -gt "$LOCK_MAX_AGE_SECONDS" ]; then
      echo "WARNING: run lock held by live pid $LOCK_PID for ${LOCK_AGE}s (> ${LOCK_MAX_AGE_SECONDS}s) — investigate a wedged run" >> "$LOG_FILE"
    fi
    echo "ERROR: another scraper/review run is already active (pid $LOCK_PID); exiting without starting" >> "$LOG_FILE"
    exit 75
  fi

  if [ "$LOCK_AGE" -le "$STALE_GRACE_SECONDS" ]; then
    echo "ERROR: run lock exists and is too fresh to steal (age ${LOCK_AGE}s); exiting without starting" >> "$LOG_FILE"
    exit 75
  fi

  echo "WARNING: removing stale run lock (holder pid '${LOCK_PID:-none}' not running, age ${LOCK_AGE}s)" >> "$LOG_FILE"
  # Steal atomically via rename so two simultaneous stealers cannot both win
  if ! mv "$LOCK_DIR" "$LOCK_DIR.stale.$$" 2>/dev/null; then
    echo "ERROR: lost the race re-taking the run lock; exiting without starting" >> "$LOG_FILE"
    exit 75
  fi
  rm -rf "$LOCK_DIR.stale.$$"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "ERROR: lost the race re-taking the run lock; exiting without starting" >> "$LOG_FILE"
    exit 75
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT
date +%s > "$LOCK_DIR/started_epoch"
echo "$$" > "$LOCK_DIR/pid"
ps -o comm= -p $$ > "$LOCK_DIR/comm" 2>/dev/null || true
echo "scraper" > "$LOCK_DIR/job"

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
UPDATE_WARNING=""
if git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CURRENT_BRANCH="$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [ "$CURRENT_BRANCH" = "main" ]; then
    BEFORE_REV="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    if git -C "$SCRIPT_DIR" fetch origin main >> "$LOG_FILE" 2>&1; then
      if git -C "$SCRIPT_DIR" merge --ff-only origin/main >> "$LOG_FILE" 2>&1; then
        AFTER_REV="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
        if [ "$BEFORE_REV" != "$AFTER_REV" ]; then
          echo "Self-update: $BEFORE_REV -> $AFTER_REV" >> "$LOG_FILE"
          if ! npm install --silent --no-audit --no-fund >> "$LOG_FILE" 2>&1; then
            UPDATE_WARNING="Code was updated but 'npm install' failed — run it manually in $SCRIPT_DIR"
          fi
        fi
      else
        UPDATE_WARNING="Self-update failed: $SCRIPT_DIR has local edits or diverged from GitHub — production is running OLD code. Run 'git status' there and reconcile."
      fi
    else
      UPDATE_WARNING="Self-update failed: could not reach GitHub — running possibly outdated code"
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
