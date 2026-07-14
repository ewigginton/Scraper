#!/bin/bash
# CCL Land Scraper — one-time production setup for the always-on Mac.
# Run from the scraper folder:  bash scripts/setup-production.sh
# It walks through: wake schedule, .env (email + monitoring), a test email,
# and loading the launchd services. Safe to re-run any time.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
ENV_FILE="$REPO_DIR/.env"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }

# Read a value with a default; empty input keeps the default.
ask() {
  local prompt="$1" default="$2" reply
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply
  else
    read -r -p "  $prompt: " reply
  fi
  printf '%s' "${reply:-$default}"
}

# Current value of a key in .env (empty if unset).
env_get() {
  [ -f "$ENV_FILE" ] || { printf ''; return; }
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1
}

# Set KEY=VALUE in .env, replacing an existing line or appending.
env_set() {
  k="$1" v="$2"
  export k v
  touch "$ENV_FILE"
  if grep -q "^${k}=" "$ENV_FILE"; then
    awk 'BEGIN { k = ENVIRON["k"]; v = ENVIRON["v"] }
         index($0, k "=") == 1 { print k "=" v; next }
         { print }' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
  unset k v
}

IS_MAC=false
[ "$(uname)" = "Darwin" ] && IS_MAC=true

say "CCL Land Scraper — production setup"
note "Folder: $REPO_DIR"

# ---------------------------------------------------------------- step 1
say "Step 1 of 5 — wake the Mac for the 2:00 AM run"
if [ "$IS_MAC" = true ]; then
  note "This runs 'sudo pmset' — macOS will ask for THIS MAC'S login password."
  note "(Nothing appears while you type it. That's normal. Type it and press Return.)"
  if [ "$(ask 'Set the 1:55 AM wake schedule now? (y/n)' 'y')" = "y" ]; then
    sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
    sudo pmset -c sleep 0
    note "Done. Current schedule:"
    pmset -g sched | sed 's/^/    /'
  else
    note "Skipped. Run later with: sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00"
  fi
else
  note "Not a Mac — skipping wake scheduling (only needed on the production desktop)."
fi

# ---------------------------------------------------------------- step 2
say "Step 2 of 5 — where reports get emailed"
[ -f "$ENV_FILE" ] || { [ -f "$REPO_DIR/.env.example" ] && cp "$REPO_DIR/.env.example" "$ENV_FILE"; }
EMAIL_TO_VAL="$(ask 'Send reports to' "$(env_get EMAIL_TO)")"
[ -n "$EMAIL_TO_VAL" ] && env_set EMAIL_TO "$EMAIL_TO_VAL"

say "Step 2b — SMTP so the email actually gets delivered"
note "For Gmail: host smtp.gmail.com, port 587, your Gmail address as user,"
note "and an App Password (NOT your normal password) created at:"
note "    https://myaccount.google.com/apppasswords"
if [ "$(ask 'Configure SMTP now? (y/n)' 'y')" = "y" ]; then
  SMTP_HOST_VAL="$(ask 'SMTP host' "$(env_get SMTP_HOST)")"
  [ -z "$SMTP_HOST_VAL" ] && SMTP_HOST_VAL="smtp.gmail.com"
  SMTP_PORT_VAL="$(ask 'SMTP port' "$(env_get SMTP_PORT)")"
  [ -z "$SMTP_PORT_VAL" ] && SMTP_PORT_VAL="587"
  SMTP_USER_VAL="$(ask 'SMTP user (the sending email address)' "$(env_get SMTP_USER)")"
  CURRENT_PASS="$(env_get SMTP_PASS)"
  if [ -n "$CURRENT_PASS" ]; then
    read -r -s -p "  SMTP password / App Password [keep existing]: " SMTP_PASS_VAL; echo
    SMTP_PASS_VAL="${SMTP_PASS_VAL:-$CURRENT_PASS}"
  else
    read -r -s -p "  SMTP password / App Password: " SMTP_PASS_VAL; echo
  fi
  env_set SMTP_HOST "$SMTP_HOST_VAL"
  env_set SMTP_PORT "$SMTP_PORT_VAL"
  env_set SMTP_USER "$SMTP_USER_VAL"
  env_set SMTP_PASS "$SMTP_PASS_VAL"
  env_set SMTP_FROM "$SMTP_USER_VAL"
  note "SMTP saved to .env"
else
  note "Skipped. Without SMTP, email falls back to macOS 'mail' which usually"
  note "cannot deliver off this machine."
fi

# ---------------------------------------------------------------- step 3
say "Step 3 of 5 — the 'scraper went silent' alarm (dead-man's switch)"
note "1. Open https://healthchecks.io and sign up (free)."
note "2. Create one check, set Period to 1 day and Grace to 6 hours."
note "3. Copy its ping URL (looks like https://hc-ping.com/abc123...)."
HC_VAL="$(ask 'Paste the ping URL here (or press Return to skip)' "$(env_get HEALTHCHECK_URL)")"
if [ -n "$HC_VAL" ]; then
  env_set HEALTHCHECK_URL "$HC_VAL"
  note "Saved. healthchecks.io will email you if a nightly run ever goes missing."
else
  note "Skipped — you will NOT be alerted when runs silently stop happening."
fi

# ---------------------------------------------------------------- step 4
say "Step 4 of 5 — send a test email"
if [ "$(ask 'Send a test email now? (y/n)' 'y')" = "y" ]; then
  if node scripts/test-email.js; then
    note "Check the inbox (and spam folder) for 'CCL Scraper — test email'."
  else
    note "Test send FAILED — re-run this script to correct the SMTP values."
  fi
fi

# ---------------------------------------------------------------- step 4b
say "Step 4b — verify the anti-block browser fallback"
note "LandWatch/Land.com/LandAndFarm block plain scrapers; the scraper routes"
note "blocked pages through this Mac's Google Chrome. Testing that now."
if [ "$(ask 'Test the browser fallback against the real sites? (y/n)' 'y')" = "y" ]; then
  node scripts/test-browser-fallback.js --live || note "Fallback test FAILED — install Google Chrome and re-run, or set SCRAPER_BROWSER_PATH in .env"
fi

# ---------------------------------------------------------------- step 5
say "Step 5 of 5 — install the nightly launchd service"
if [ "$IS_MAC" = true ]; then
  if [ "$(ask 'Install/reload the 2 AM nightly service? (y/n)' 'y')" = "y" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    plist=com.ccl.land-scraper.plist
    # The committed plist points at /Users/nora/ccl-land-scraper; rewrite to
    # wherever this repo actually lives before installing
    sed "s|/Users/nora/ccl-land-scraper|$REPO_DIR|g" "$REPO_DIR/services/$plist" \
      > "$HOME/Library/LaunchAgents/$plist"
    launchctl unload "$HOME/Library/LaunchAgents/$plist" 2>/dev/null || true
    launchctl load "$HOME/Library/LaunchAgents/$plist"
    note "Loaded $plist"

    # The review is now part of the 2 AM run and its email — remove the old
    # separate 6 AM review service so it stops sending a second email
    OLD_REVIEW="$HOME/Library/LaunchAgents/com.ccl.land-review.plist"
    if [ -f "$OLD_REVIEW" ]; then
      launchctl unload "$OLD_REVIEW" 2>/dev/null || true
      rm -f "$OLD_REVIEW"
      note "Removed the old separate 6 AM review service (now runs inside the 2 AM job)"
    fi
    note "Verify with: launchctl list | grep com.ccl"
  fi

  # Leftover jobs from earlier scraper versions cause duplicate daily emails
  # (e.g. an 8 AM 'CCL Daily Land Report' digest). Point them out if present.
  say "Checking for other scheduled jobs that send duplicate emails"
  OTHER_AGENTS="$(ls "$HOME/Library/LaunchAgents" 2>/dev/null | grep -iv '^com\.ccl\.land-scraper\.plist$' | grep -iE 'ccl|land|scraper|intake' || true)"
  CRON_JOBS="$(crontab -l 2>/dev/null | grep -ivE '^\s*#' | grep -iE 'ccl|land|scraper|report|intake' || true)"
  if [ -n "$OTHER_AGENTS" ]; then
    note "Found other launchd agents that look scraper-related — remove them if unwanted:"
    printf '%s\n' "$OTHER_AGENTS" | sed 's/^/    /'
    note "Remove with: launchctl unload ~/Library/LaunchAgents/<name> && rm ~/Library/LaunchAgents/<name>"
  fi
  if [ -n "$CRON_JOBS" ]; then
    note "Found cron entries that look scraper-related — remove them with 'crontab -e' if unwanted:"
    printf '%s\n' "$CRON_JOBS" | sed 's/^/    /'
  fi
  if [ -z "$OTHER_AGENTS" ] && [ -z "$CRON_JOBS" ]; then
    note "None found — the 2 AM job should be the only thing emailing."
  fi
else
  note "Not a Mac — skipping launchd install."
fi

say "Setup complete"
note "Nightly run (scrape + price check + review, one email): 2:00 AM"
note "Re-run this script any time to change settings: bash scripts/setup-production.sh"
