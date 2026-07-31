#!/bin/bash
# CCL Lead Review — manual wrapper (with run-lock protection).
# The nightly review runs inside the 2:00 AM scraper job (index.js) and is
# part of the consolidated email; there is no scheduled review service.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
LOG_FILE="$LOG_DIR/review-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

echo "=== Review starting at $(date) ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

# The lock rules (stale-steal with PID/comm liveness + grace, the EXIT-trap
# release, the exit-75 contract) live in scripts/run-lock.sh so this manual
# review, the nightly/midday scrapes (scripts/run-scraper.sh) and the
# run-request poller (scripts/poll-run-requests.sh) all take the IDENTICAL lock
# instead of each carrying its own copy of "is this lock stale?". Nothing about
# this job's on-disk lock or its log lines changed when that code moved out of
# this file: same lock dir, same "review" job label, same exit 75 on a busy lock.
source "$SCRIPT_DIR/scripts/run-lock.sh"
if ! acquire_run_lock "review" "$LOG_FILE"; then
  exit 75
fi

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

# Clean up old logs and evidence files
find "$LOG_DIR" -name "review-*.log" -mtime +30 -delete 2>/dev/null || true
find "$SCRIPT_DIR/data/source-health" -name "*.jsonl" -mtime +30 -delete 2>/dev/null || true

# Rotate launchd stdout/stderr logs (appended forever otherwise)
for LAUNCHD_LOG in "$LOG_DIR"/launchd-*.log; do
  if [ -f "$LAUNCHD_LOG" ] && [ "$(wc -c < "$LAUNCHD_LOG")" -gt 5242880 ]; then
    tail -c 1048576 "$LAUNCHD_LOG" > "$LAUNCHD_LOG.tmp" && mv "$LAUNCHD_LOG.tmp" "$LAUNCHD_LOG"
  fi
done

exit $EXIT_CODE
