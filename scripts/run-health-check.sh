#!/bin/bash
# CCL daily scraper health check — launchd wrapper (Nora's desktop, 9:00 AM).
#
# Reviews the most recent recorded scrape (data/run-history/history.jsonl, the
# 2:00 AM nightly run) against the previous successful runs, classifies each
# enabled source, and emails the report to EMAIL_TO. Read-only: it never
# scrapes, writes to Airtable, or touches lead data, so — unlike the scraper
# and review wrappers — it needs no run lock. The nightly job self-updates the
# checkout before it runs, so by 9 AM this uses current code.
#
# Exit status mirrors scripts/health-check.js: 0 all healthy, 1 soft anomalies,
# 2 something needs attention. launchd ignores it; it is here for manual runs.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/services/land-scraper/logs"
LOG_FILE="$LOG_DIR/health-check-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$SCRIPT_DIR"

{
  echo "=== Health check starting at $(date) ==="
  node scripts/health-check.js --email
  STATUS=$?
  echo "=== Health check finished at $(date) (exit $STATUS) ==="
  exit $STATUS
} 2>&1 | tee -a "$LOG_FILE"
