#!/bin/bash
# CCL Land Scraper — launchd wrapper
# Schedule: 2:00 AM daily on Classic's iMac
# Service: com.ccl.land-scraper

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
LOG_FILE="$LOG_DIR/scrape-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

echo "=== Scraper starting at $(date) ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

# Run the scraper, capturing all output. Keep logging even if Node fails.
set +e
/usr/local/bin/node index.js >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
set -e

echo "=== Scraper finished at $(date) with exit code $EXIT_CODE ===" >> "$LOG_FILE"

# Clean up logs older than 30 days
find "$LOG_DIR" -name "scrape-*.log" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE
