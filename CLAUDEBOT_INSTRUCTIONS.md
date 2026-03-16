# CCL Scraper v2.0 — Instructions for Claudebot

## What This Is

This is a rebuilt version of the CCL land scraper pipeline. The old version had two problems:
1. **Duplicates** — The same property listed on LandWatch, Land.com, LandAndFarm, and LandsOfAmerica would appear as 4 separate records in Airtable because cross-site dedup didn't run until 4 hours after the scraper finished.
2. **Bad price filtering** — The scraper trusted the $/acre value from the listing site. If the site had bad data (wrong acreage, garbled price), the listing passed filtering when it shouldn't have.

The new version fixes both. Here's what you need to do to deploy it.

---

## Airtable Field Status

These fields are **already created** in the Leads table (no action needed):

| Field Name | Type | Purpose |
|---|---|---|
| `Fingerprint` | Single line text | SHA-256 hash for cross-site dedup |
| `Validation Status` | Single line text | "Clean" or "Has Warnings" |
| `Filter Reason` | Long text | Why each lead passed/was rejected |

All existing fields (`Name`, `LP`, `Acres`, `$/A`, `County`, `State`, `Listing URL`, `Source`, `Coordinate`, `Property Notes`, `Days On The Market`, `Stage`, `Price Check Log`) remain unchanged.

---

## How to Deploy

### 1. Back up the current scraper

```bash
cd /Users/nora/clawd
cp -r services/land-scraper services/land-scraper-v1-backup
```

### 2. Get the new code

The new code is in the GitHub repo on branch `claude/rebuild-scraper-filtering-xTHPI`.

```bash
cd /Users/nora/clawd
git clone -b claude/rebuild-scraper-filtering-xTHPI https://github.com/ewigginton/Scraper.git scraper-v2
cd scraper-v2
npm install
```

### 3. Create the .env file

```bash
cp .env.example .env
```

Then edit `.env` with the actual values:

```
AIRTABLE_LAND_TOKEN=pat_xxxxxxxxxxxxx
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
EMAIL_TO=emma@classiccountryland.com
```

**Finding the base ID:** Open Airtable in a browser, navigate to the land pipeline base. The URL looks like `https://airtable.com/appXXXXXXXXXXXXXX/...` — the `appXXXX` part is the base ID.

### 4. Verify the county CPA targets

The file `config/acquisition_counties.json` contains 181 counties across 8 states (TX, OK, AR, AL, KS, MS, MO, TN) with max cost-per-acre targets. These need to match the actual targets in the existing `acquisition_counties.json`.

To compare:
```bash
# Print all counties and targets from the new file
node -e "
  const data = require('./config/acquisition_counties.json');
  data.counties
    .sort((a,b) => a.state.localeCompare(b.state) || a.county.localeCompare(b.county))
    .forEach(c => console.log(c.state.padEnd(3) + c.county.padEnd(20) + '$' + c.maxCPA + '/ac'));
"
```

Compare these against the old file at `/Users/nora/clawd/services/land-scraper/acquisition_counties.json`. Update any targets that don't match by editing `config/acquisition_counties.json`. The format per entry is:

```json
{ "county": "Anderson", "state": "TX", "maxCPA": 4500 }
```

### 5. Test without writing to Airtable

```bash
cd /Users/nora/clawd/scraper-v2

# Test the filter logic
node -e "
  const { filterListing } = require('./lib/filter');
  const test = {
    price: 200000,
    acres: 50,
    county: 'Anderson',
    state: 'TX',
    url: 'https://example.com/test'
  };
  const result = filterListing(test);
  console.log('Passed:', result.passed);
  console.log('Stage:', result.stage);
  console.log('Reason:', result.reason);
  console.log('CPA Target:', result.cpaTarget);
"
# Expected: Passed: true, Stage: New Lead, CPA Target: 4500

# Test fingerprint dedup
node -e "
  const { generateFingerprint } = require('./lib/fingerprint');
  // Same property on LandWatch vs Land.com (slightly different acres/price from rounding)
  const landwatch = { county: 'Anderson', state: 'TX', acres: 162, price: 648000 };
  const landcom   = { county: 'Anderson', state: 'TX', acres: 163, price: 650000 };
  console.log('LandWatch FP:', generateFingerprint(landwatch));
  console.log('Land.com FP: ', generateFingerprint(landcom));
  console.log('Match:', generateFingerprint(landwatch) === generateFingerprint(landcom));
"
# Expected: Match: true (both round to 160ac / $650K)

# Test a listing that should be rejected (over threshold)
node -e "
  const { filterListing } = require('./lib/filter');
  const test = {
    price: 500000,
    acres: 50,
    county: 'Anderson',
    state: 'TX',
    url: 'https://example.com/test2'
  };
  // \$10,000/ac vs \$4,500/ac target = 122% over → rejected
  const result = filterListing(test);
  console.log('Passed:', result.passed);
  console.log('Reason:', result.reason);
"
# Expected: Passed: false
```

### 6. Run a full test (will write to Airtable)

```bash
cd /Users/nora/clawd/scraper-v2
node index.js
```

Watch the console output for:
- `[Airtable] Dedup index: X URLs, Y fingerprints from Z records` — Airtable connection works
- Per-site lines like `landwatch: 3200 checked → 45 passed → 38 new (7 dupes)` — parsing works
- `Cross-site dup` messages — fingerprint dedup is catching CoStar overlaps

**If a site returns 0 results:** The CSS selectors in `lib/parsers/*.js` probably need updating for the current HTML. See "Tuning Site Parsers" below.

### 7. Update launchd services

**On Classic's iMac (scraper — 2:00 AM):**
```bash
# Stop old service
launchctl unload ~/Library/LaunchAgents/com.ccl.land-scraper.plist 2>/dev/null

# Install new plist
cp /Users/nora/clawd/scraper-v2/services/com.ccl.land-scraper.plist ~/Library/LaunchAgents/

# IMPORTANT: Edit the plist if your install path is not /Users/nora/clawd/scraper-v2
# The plist references /Users/nora/clawd — update to actual path

# Start new service
launchctl load ~/Library/LaunchAgents/com.ccl.land-scraper.plist

# Verify
launchctl list | grep land-scraper
```

**On Nora's Mac (review — 6:00 AM):**
```bash
launchctl unload ~/Library/LaunchAgents/com.ccl.land-review.plist 2>/dev/null
cp /Users/nora/clawd/scraper-v2/services/com.ccl.land-review.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ccl.land-review.plist
launchctl list | grep land-review
```

### 8. Verify the first nightly run

The morning after deployment, check logs:

```bash
# Scraper log (Classic's iMac)
tail -50 /Users/nora/clawd/scraper-v2/services/land-scraper/logs/scrape-$(date +%Y-%m-%d).log

# Review log (Nora's Mac)
tail -50 /Users/nora/clawd/scraper-v2/services/land-scraper/logs/review-$(date +%Y-%m-%d).log
```

**Healthy scraper log looks like:**
```
[Scraper] Starting at 2026-03-17T02:00:01.000Z
[Scraper] Target: 181 counties across 8 states
[Airtable] Dedup index: 1247 URLs, 983 fingerprints from 1312 records
[Scraper] Running 5 site parsers...
[Scraper] landwatch: 3200 checked → 42 passed → 35 new (7 dupes, 3158 rejected)
[Scraper] landcom: 2900 checked → 38 passed → 12 new (26 dupes, 2862 rejected)
...
[Scraper] Done in 32.4 minutes
[Scraper] Dedup caught: 47 duplicates
```

**Healthy review log looks like:**
```
[Review] Starting lead review...
[Review] Reviewing 47 leads (42 new, 5 price drops)
[Review] AUTO-REJECT: Some Property — conservation easement
[Review] Done in 3.2 minutes: 47 reviewed, 8 standouts, 2 auto-rejected
```

---

## Tuning Site Parsers

The CSS selectors in `lib/parsers/*.js` are built from common patterns but may need adjustment for the current live HTML of each site. After the first run, if a site returns 0 results:

1. Visit the site manually in a browser
2. Right-click a listing → Inspect Element
3. Find the container element, price element, and acreage element class names
4. Update the corresponding parser file

Files to check:
- `lib/parsers/landwatch.js` — LandWatch.com
- `lib/parsers/landcom.js` — Land.com
- `lib/parsers/landfarm.js` — LandAndFarm.com
- `lib/parsers/landsofamerica.js` — LandsOfAmerica.com
- `lib/parsers/livingthedream.js` — LivingTheDreamLand.com

Each parser extends `base-parser.js` and overrides three methods:
- `buildSearchUrls(counties)` — builds the search URLs for each county
- `parseSearchPage(html, county, state)` — extracts listings from HTML
- `getHeaders()` — (optional) adds site-specific request headers

---

## Key Architecture Changes From v1

### Dedup now happens at scrape time (2 AM), not review time (6 AM)

The old system ran URL dedup at 2 AM but property-based dedup at 6 AM. The new system runs **both** at 2 AM in a single pass:

1. Loads all existing URLs + fingerprints from Airtable into memory (one API call)
2. For each new listing, checks URL match first, then fingerprint match
3. Also tracks fingerprints within the current session, so if LandWatch and Land.com both find the same property in one run, the second is caught immediately

### Fingerprinting is deterministic, not fuzzy

Old v1 used "same county + acreage within 5% + price within 5%" which was both too loose (caught non-matches) and too strict (missed matches at the boundary). New system uses:

```
SHA-256(lowercase_county | uppercase_state | acres_rounded_to_5 | price_rounded_to_5000)
```

Example: A property in Anderson County, TX at 162 acres / $648,000 and the same property on another site at 163 acres / $650,000 both produce the same fingerprint because both round to 160ac / $650K.

Settings in `config/settings.json`:
```json
"dedup": {
  "acreageRoundTo": 5,
  "priceRoundTo": 5000
}
```

### $/acre is always recomputed

The scraper never trusts the $/acre from the listing site. It always computes `price / acres` itself and checks for discrepancies. If the site says $4,000/ac but the math says $6,500/ac, the computed value is used and a validation warning is logged.

### Error isolation between sites

Each site parser runs independently via `Promise.allSettled`. If LandWatch crashes, Land.com still runs. The email report shows which sites succeeded and which failed.

---

## Configuration Reference

All in `config/settings.json`:

| Setting | Default | What It Does |
|---|---|---|
| `filtering.minAcres` | 40 | Skip anything under 40 acres |
| `filtering.newLeadThreshold` | 0.20 | Up to 20% over target CPA = "New Lead" |
| `filtering.watchThreshold` | 0.30 | 20-30% over target = "Watch For Price Drop" |
| `filtering.defaultLookbackDays` | 30 | Only scrape listings from last 30 days |
| `scraper.maxConcurrentSites` | 2 | Run 2 site parsers at a time |
| `scraper.requestDelayMs` | 2000 | 2 seconds between HTTP requests per site |
| `scraper.requestTimeoutMs` | 30000 | 30 second timeout per request |
| `scraper.maxRetries` | 3 | Retry failed requests 3 times |
| `priceCheck.delayBetweenChecksMs` | 3000 | 3 seconds between price check requests |
| `priceCheck.priceToleranceDollars` | 5 | $5/acre minimum change to count as a price change |
| `priceCheck.expirationDays` | 90 | Auto-expire watched listings after 90 days |
| `dedup.acreageRoundTo` | 5 | Round acres to nearest 5 for fingerprint |
| `dedup.priceRoundTo` | 5000 | Round price to nearest $5K for fingerprint |
| `review.autoRejectThresholdPercent` | 30 | Auto-reject anything 30%+ over target in review |
| `review.preferredAcresMin` | 150 | Preferred tract size lower bound |
| `review.preferredAcresMax` | 400 | Preferred tract size upper bound |
| `review.domNegotiationDays` | 180 | 180+ DOM = negotiation opportunity |

---

## Airtable Field Name Mapping

If any Airtable field name changes, update the `FIELDS` object at the top of `lib/airtable.js`:

```js
const FIELDS = {
  name: 'Name',
  price: 'LP',
  acres: 'Acres',
  cpa: '$/A',
  county: 'County',
  state: 'State',
  url: 'Listing URL',
  source: 'Source',
  coordinates: 'Coordinate',
  notes: 'Property Notes',
  dom: 'Days On The Market',
  stage: 'Stage',
  fingerprint: 'Fingerprint',
  validationStatus: 'Validation Status',
  filterReason: 'Filter Reason',
  priceCheckLog: 'Price Check Log',
};
```

Change the string value on the right side to match the Airtable field name. The left side (JS key) stays the same.

---

## File Structure

```
index.js                          Main entry point (runs scraper + price check)
review-leads.js                   Review entry point (runs analysis + keyword scan)
package.json                      Dependencies (airtable, node-fetch, cheerio)
.env.example                      Template for environment variables

config/
  settings.json                   All thresholds and toggles
  acquisition_counties.json       181 counties with CPA targets

lib/
  airtable.js                     Airtable client — reads, writes, dedup
  filter.js                       Price/acreage/county filtering engine
  fingerprint.js                  SHA-256 property fingerprint generator
  scraper.js                      Orchestrator — runs parsers, filters, dedup, writes
  price-checker.js                Visits watched listings, detects price drops
  review.js                       Keyword scan, scoring, dealbreaker detection
  notify.js                       Email report builder and sender

lib/parsers/
  base-parser.js                  Shared parser base class (fetch, retry, parse helpers)
  index.js                        Parser registry
  landwatch.js                    LandWatch.com parser
  landcom.js                      Land.com parser
  landfarm.js                     LandAndFarm.com parser
  landsofamerica.js               LandsOfAmerica.com parser
  livingthedream.js               LivingTheDreamLand.com parser

scripts/
  run-scraper.sh                  launchd wrapper for scraper job
  run-review.sh                   launchd wrapper for review job

services/
  com.ccl.land-scraper.plist      launchd plist for 2 AM scraper
  com.ccl.land-review.plist       launchd plist for 6 AM review
```

---

## Rollback

If something goes wrong, the old code is at `/Users/nora/clawd/services/land-scraper-v1-backup`.

```bash
launchctl unload ~/Library/LaunchAgents/com.ccl.land-scraper.plist
# Restore old plist and point it back to the v1 backup directory
launchctl load ~/Library/LaunchAgents/com.ccl.land-scraper.plist
```

The three new Airtable fields (`Fingerprint`, `Validation Status`, `Filter Reason`) can stay — the old scraper ignores them.
