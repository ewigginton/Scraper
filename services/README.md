# Production services (Nora's desktop)

The full nightly run (scrape + price check + lead review) runs at 2:00 AM via
the single launchd plist in this directory and sends **one consolidated
email**. launchd's `StartCalendarInterval` does **not** wake a sleeping Mac
and skips the run entirely if the machine is off at the scheduled time, so a
few one-time setup steps make the schedule reliable.

**Easiest path: run the guided setup script instead of doing the steps below
by hand.** From the scraper folder on the production Mac:

```bash
bash scripts/setup-production.sh
```

It walks through every step in this file interactively (wake schedule, SMTP,
healthchecks.io, a test email, and loading the services) and is safe to
re-run any time. The sections below explain what it does and how to do each
step manually.

## 1. Wake the Mac for the runs (one time, requires admin)

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
```

This wakes (or powers on) the machine at 1:55 AM every day so the 2:00 AM
nightly run fires. Verify with `pmset -g sched`.

Also disable automatic sleep while on power:

```bash
sudo pmset -c sleep 0
```

## 2. Configure real email delivery (SMTP)

The default macOS `mail` command hands messages to local postfix, which has
no relay configured on a stock machine — mail silently never leaves the box.
Set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` in
`.env` (for Gmail use `smtp.gmail.com`, port 587, and an App Password) and
the scraper sends through nodemailer with confirmed delivery instead.

## 3. Set up the dead-man's switch

Email only tells you about runs that *happened*. To find out when a run
**didn't** happen (machine asleep, launchd unloaded after an OS update, lock
stuck), create a free check at https://healthchecks.io with a 24-hour period
and a few hours of grace, then put its ping URL in `.env` as
`HEALTHCHECK_URL`. The scraper pings it after every run (and pings `/fail`
on fatal errors); healthchecks.io emails you when the ping goes missing.

The nightly GitHub Actions dry-run (`.github/workflows/nightly-scraper.yml`)
is an independent second monitor: it opens a GitHub issue automatically if
the code itself starts failing.

## 4. Loading the service

```bash
launchctl load ~/Library/LaunchAgents/com.ccl.land-scraper.plist
```

After any macOS upgrade, confirm it is still loaded:

```bash
launchctl list | grep com.ccl
```

## 5. One email per day — remove leftover jobs

The 2:00 AM run sends the only scheduled email. If you still receive extra
daily emails, older jobs are still installed on the Mac. Remove them:

- **The old separate 6:00 AM review email** (`CCL Review — ...`):

  ```bash
  launchctl unload ~/Library/LaunchAgents/com.ccl.land-review.plist
  rm ~/Library/LaunchAgents/com.ccl.land-review.plist
  ```

- **The legacy 8:00 AM digest** (`CCL Daily Land Report - ...`) comes from a
  script that predates this repo's email reports and only exists on the
  production Mac. Find and remove whatever schedules it:

  ```bash
  crontab -l                      # look for a daily-report/digest entry; edit with: crontab -e
  ls ~/Library/LaunchAgents       # look for other ccl/land/report plists
  ```

  `bash scripts/setup-production.sh` also scans for these leftovers in its
  last step and prints removal commands.

GitHub also emails "Run failed" notifications when the nightly dry-run
workflow fails — those stop when the workflow is healthy, and can be tuned
in GitHub notification settings, not on this machine.
