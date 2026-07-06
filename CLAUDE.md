# CCL Land Scraper

## Setup (required before running)

Before running any scraper commands, create the `.env` file if it doesn't exist.
The required env vars are: `AIRTABLE_LAND_TOKEN`, `AIRTABLE_BASE_ID`, `EMAIL_TO`.
Recommended: `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` for real email delivery
and `HEALTHCHECK_URL` for dead-man's-switch monitoring.
See `.env.example` for the full list.

## Running

- Install deps: `npm install --silent`
- Full scrape + price check: `node index.js`
- Dry run (scrape and report without Airtable writes): `node index.js --dry-run`
- Targeted dry run: `SCRAPER_TARGET_COUNTIES="Wayne|KY,Pittsburg|OK,Shannon|MO" SCRAPER_MAX_PAGE=1 node index.js --dry-run --skip-price-check`
- Review leads only: `node review-leads.js`
- Price check only: `node index.js --price-check-only`
- Scrape without price check: `node index.js --skip-price-check`

## GitHub Actions

The nightly scraper workflow lives at `.github/workflows/nightly-scraper.yml`.
It runs on a nightly schedule as an independent monitor (it opens a GitHub
issue on failure) and can also be run manually. GitHub scraper runs are always
dry-run only — enforced in `index.js` via `GITHUB_ACTIONS`, not just in the
workflow file.

Required GitHub repository secrets:

- `AIRTABLE_LAND_TOKEN`
- `AIRTABLE_BASE_ID`
- `EMAIL_TO`

Production scraping should run from Nora's always-on desktop in `/Users/nora/ccl-land-scraper` via the `launchd` service files in `services/` (see `services/README.md` for wake scheduling, SMTP, and monitoring setup).
GitHub Actions should be used for tests and dry-runs only.
GitHub dry-runs upload the scraper report and any failed Airtable write queue as workflow artifacts.

## Architecture

- Site parsers in `lib/parsers/` (LandWatch, Land.com, LandAndFarm, LivingTheDream; LandsOfAmerica exists but is disabled — it redirects to Land.com)
- County targets loaded dynamically from Airtable `county` table using `CPA Target`
- Filtering: accepts listings within 20% of CPA target, watches 20-30% over, rejects >30%
- Deduplication: URL match + property fingerprint (county/state/acres/price hash) + location/price-tolerance match; the dedup index includes `Not Interested` records so rejected leads are not re-created
- Results written to Airtable `Leads` table
- Failed Airtable writes are queued in `data/failed-writes/` and replayed automatically at the start of the next scrape (processed files move to `data/failed-writes/done/`)
- Launch scripts use a local run lock so scraper/review jobs do not overlap
- Parser fetch/parse failures, bot-block detections, and markup-drift suspicions are saved locally under `data/source-health/` (HTML evidence in `source-health/snapshots/`) and summarized in reports
