# CCL Land Scraper

## Setup (required before running)

Before running any scraper commands, create the `.env` file if it doesn't exist.
The required env vars are: `AIRTABLE_LAND_TOKEN`, `AIRTABLE_BASE_ID`, `EMAIL_TO`.
See `.env.example` for the full list.

## Running

- Install deps: `PUPPETEER_SKIP_DOWNLOAD=true npm install --silent`
- Full scrape + price check: `node index.js`
- Review leads only: `node review-leads.js`
- Price check only: `node index.js --price-check-only`

## Architecture

- 5 site parsers in `lib/parsers/` (LandWatch, Land.com, LandAndFarm, LandsOfAmerica, LivingTheDream)
- County targets loaded dynamically from Airtable `county` table
- Filtering: accepts listings within 20% of CPA target, watches 20-30% over, rejects >30%
- Deduplication: URL match + property fingerprint (county/state/acres/price hash)
- Results written to Airtable `Leads` table
