#!/bin/bash
# CCL Lead Review — launchd wrapper
# Schedule: 6:00 AM daily on Nora's Mac
# Service: com.ccl.land-review

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
LOG_FILE="$LOG_DIR/review-$(date +%Y-%m-%d).log"
LOCK_DIR="$SCRIPT_DIR/services/land-scraper/.run.lock"
LOCK_MAX_AGE_SECONDS=28800

mkdir -p "$LOG_DIR"

echo "=== Review starting at $(date) ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_STARTED="$(cat "$LOCK_DIR/started_epoch" 2>/dev/null || echo 0)"
  case "$LOCK_STARTED" in
    ''|*[!0-9]*) LOCK_STARTED=0 ;;
  esac
  NOW="$(date +%s)"
  LOCK_AGE=$((NOW - LOCK_STARTED))
  if [ "$LOCK_STARTED" -gt 0 ] && [ "$LOCK_AGE" -gt "$LOCK_MAX_AGE_SECONDS" ]; then
    echo "WARNING: removing stale run lock older than $LOCK_MAX_AGE_SECONDS seconds" >> "$LOG_FILE"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
  else
    echo "ERROR: another scraper/review run is already active; exiting without starting" >> "$LOG_FILE"
    exit 75
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT
date +%s > "$LOCK_DIR/started_epoch"
echo "$$" > "$LOCK_DIR/pid"
echo "review" > "$LOCK_DIR/job"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node was not found in PATH" >> "$LOG_FILE"
  exit 127
fi

# Run the review script. Keep logging even if Node fails.
set +e
"$NODE_BIN" review-leads.js >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
set -e

echo "=== Review finished at $(date) with exit code $EXIT_CODE ===" >> "$LOG_FILE"

# Clean up logs older than 30 days
find "$LOG_DIR" -name "review-*.log" -mtime +30 -delete 2>/dev/null || true
find "$SCRIPT_DIR/data/source-health" -name "*.jsonl" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE
