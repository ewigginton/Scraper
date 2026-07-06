# Production services (Nora's desktop)

The scraper runs at 2:00 AM and the review at 6:00 AM via the launchd plists
in this directory. launchd's `StartCalendarInterval` does **not** wake a
sleeping Mac and skips the run entirely if the machine is off at the
scheduled time, so a few one-time setup steps make the schedule reliable.

## 1. Wake the Mac for the runs (one time, requires admin)

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
```

This wakes (or powers on) the machine at 1:55 AM every day so the 2:00 AM
scraper and 6:00 AM review both fire. Verify with `pmset -g sched`.

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

## 4. Loading the services

```bash
launchctl load ~/Library/LaunchAgents/com.ccl.land-scraper.plist
launchctl load ~/Library/LaunchAgents/com.ccl.land-review.plist
```

After any macOS upgrade, confirm they are still loaded:

```bash
launchctl list | grep com.ccl
```
