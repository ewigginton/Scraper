# CCL Land Scraper

## Setup (required before running)

Before running any scraper commands, create the `.env` file if it doesn't exist.
The required env vars are: `AIRTABLE_LAND_TOKEN`, `AIRTABLE_BASE_ID`, `EMAIL_TO`.
See `.env.example` for the full list.

## Running

- Install deps: `PUPPETEER_SKIP_DOWNLOAD=true npm install --silent`
- Full scrape + price check: `node index.js`
- Dry run (scrape and report without Airtable writes): `node index.js --dry-run`
- Review leads only: `node review-leads.js`
- Price check only: `node index.js --price-check-only`

## GitHub Actions

The nightly scraper workflow lives at `.github/workflows/nightly-scraper.yml`.
It can be run manually from GitHub Actions, and manual runs default to dry-run mode.

Required GitHub repository secrets:

- `AIRTABLE_LAND_TOKEN`
- `AIRTABLE_BASE_ID`
- `EMAIL_TO`

The scheduled run uses GitHub's UTC cron at `0 7 * * *`, which is 2:00 AM Central during daylight saving time and 1:00 AM Central during standard time.
Each run uploads the scraper report and any failed Airtable write queue as a workflow artifact.

## Architecture

- 5 site parsers in `lib/parsers/` (LandWatch, Land.com, LandAndFarm, LandsOfAmerica, LivingTheDream)
- County targets loaded dynamically from Airtable `county` table
- Filtering: accepts listings within 20% of CPA target, watches 20-30% over, rejects >30%
- Deduplication: URL match + property fingerprint (county/state/acres/price hash)
- Results written to Airtable `Leads` table
