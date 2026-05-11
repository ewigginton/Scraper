#!/bin/bash
# CCL Lead Review — launchd wrapper
# Schedule: 6:00 AM daily on Nora's Mac
# Service: com.ccl.land-review

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
LOG_FILE="$LOG_DIR/review-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

echo "=== Review starting at $(date) ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

# Run the review script. Keep logging even if Node fails.
set +e
/usr/local/bin/node review-leads.js >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
set -e

echo "=== Review finished at $(date) with exit code $EXIT_CODE ===" >> "$LOG_FILE"

# Clean up logs older than 30 days
find "$LOG_DIR" -name "review-*.log" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE
