# Fix: Load County CPA Targets from Airtable (Not Hardcoded)

## The Problem

The scraper at `/Users/nora/clawd/services/land-scraper/` uses a hardcoded JSON file (`acquisition_counties.json`) for county CPA targets. Those targets are WRONG — they're too high, which is why the last run let 1,665 leads through instead of ~50-100.

The real CPA targets live in the Airtable **"county"** table (synced from the main CCL base). The scraper needs to read from that table every time it runs so Emma can update target prices in Airtable without touching code.

## The Airtable "county" Table

- **Table name**: `county`
- **Primary field** (Name): County name (e.g. "Anderson", "Dallas")
- **State field**: `State` — contains FULL state names (e.g. "Texas", not "TX")
- **CPA target field**: `CPA top target` — contains the max $/acre. **Only scrape counties where this field has a number.**
- This table is **read-only** (synced from another base). The scraper only reads from it.

## Files to Change

All files are relative to `/Users/nora/clawd/services/land-scraper/`.

### 1. `lib/airtable.js` — Add state mapping + loadCountyTargets()

**Add this constant** after the `FIELDS` object and before `let base = null;`:

```js
// Full state name → abbreviation mapping
const STATE_ABBREV = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY',
};
```

**Add this function** (can go after `loadDedupIndex` or anywhere before `module.exports`):

```js
/**
 * Load county CPA targets from the Airtable "county" table.
 * Only returns counties where "CPA top target" has a number.
 * Converts full state names (e.g. "Texas") to abbreviations (e.g. "TX").
 *
 * Returns { counties: [{ county, state, maxCPA }], countyMap: Map<"county|state", maxCPA> }
 */
async function loadCountyTargets() {
  if (!base) init();

  const counties = [];

  await new Promise((resolve, reject) => {
    base('county').select({
      filterByFormula: `{CPA top target} != ''`,
    }).eachPage(
      (pageRecords, fetchNextPage) => {
        for (const rec of pageRecords) {
          const countyName = rec.get('Name');
          const stateRaw = rec.get('State');
          const cpaTarget = rec.get('CPA top target');

          if (!countyName || !stateRaw || !cpaTarget) continue;

          const maxCPA = parseFloat(cpaTarget);
          if (isNaN(maxCPA) || maxCPA <= 0) continue;

          // Convert full state name to abbreviation
          const stateAbbrev = STATE_ABBREV[stateRaw.toLowerCase().trim()] || stateRaw.trim().toUpperCase();

          counties.push({ county: countyName.trim(), state: stateAbbrev, maxCPA });
        }
        fetchNextPage();
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  // Build lookup map: "county|state" -> maxCPA
  const countyMap = new Map();
  for (const c of counties) {
    const key = `${c.county.toLowerCase()}|${c.state.toUpperCase()}`;
    countyMap.set(key, c.maxCPA);
  }

  const states = new Set(counties.map(c => c.state));
  console.log(`[Airtable] County targets loaded: ${counties.length} counties across ${states.size} states from Airtable`);

  return { counties, countyMap };
}
```

**Add `loadCountyTargets` to `module.exports`.**

### 2. `lib/filter.js` — Remove hardcoded JSON, accept dynamic county map

The filter currently does something like `require('../config/acquisition_counties.json')` or has a hardcoded county map at the top. Replace that entire approach with:

- **Remove** any `require` of `acquisition_counties.json`
- **Remove** any hardcoded `countyMap` built at module load time
- **Add** a module-level `let countyMap = null;`
- **Add** an `initFilter(airtableCountyMap)` function that sets `countyMap`
- **In `filterListing()`**, use that `countyMap` for the county lookup (same logic as before, just reading from the dynamic map instead of the hardcoded one)
- **Export** `initFilter` alongside the existing exports

The county lookup key format is: `countyName.toLowerCase() + '|' + stateAbbrev.toUpperCase()`

The filter logic itself (minAcres check, newLeadThreshold at 20%, watchThreshold at 30%, reject above 30%) stays exactly the same. Only the SOURCE of the county targets changes.

### 3. `lib/scraper.js` — Load targets from Airtable at startup

The scraper currently does something like `require('../config/acquisition_counties.json')` for the county list.

**Replace that with**:
1. `require('./airtable')` (if not already imported) and `require('./filter').initFilter`
2. At the START of `runScraper()`, before doing anything else:
   ```js
   // Load county targets from Airtable
   const countyTargets = await airtable.loadCountyTargets();
   initFilter(countyTargets.countyMap);
   ```
3. Use `countyTargets.counties` (array of `{ county, state, maxCPA }`) wherever it previously used the JSON county list — specifically when passing counties to the site parsers
4. Remove the `require` of `acquisition_counties.json`

### 4. `index.js` — Init filter for price-check-only mode

The main `index.js` has two modes: full scrape and `--price-check-only`. The full scrape path calls `runScraper()` which now inits the filter itself. But the price-check-only path skips the scraper and goes straight to `runPriceCheck()`, which uses `getCPATarget()` from the filter.

**Add** at the top:
```js
const airtable = require('./lib/airtable');
const { initFilter } = require('./lib/filter');
```

**In the price-check-only branch** (where it skips the scraper), add before `runPriceCheck()`:
```js
const countyTargets = await airtable.loadCountyTargets();
initFilter(countyTargets.countyMap);
```

### 5. `review-leads.js` — Init filter before review

The review script uses `getCPATarget()` from the filter. It needs to init from Airtable too.

**Add** at the top:
```js
const airtable = require('./lib/airtable');
const { initFilter } = require('./lib/filter');
```

**At the start of the main function**, before `runReview()`:
```js
const countyTargets = await airtable.loadCountyTargets();
initFilter(countyTargets.countyMap);
```

### 6. Any parser that imports from filter.js for county lookups

Search all files in `lib/parsers/` for any `require('../filter')` that uses `getCountiesForState` or `getTargetStates`. Those functions no longer exist. Instead, the parsers already receive the `counties` array via `scrapeAll(counties)` → `buildSearchUrls(counties)`. Use that array directly.

For example, if a parser does:
```js
const { getCountiesForState } = require('../filter');
const targetCounties = new Set(getCountiesForState(state).map(c => c.county.toLowerCase()));
```

Replace with:
```js
// counties is already available from buildSearchUrls or stored as this._counties
const targetCounties = new Set(
  counties.filter(c => c.state.toUpperCase() === state.toUpperCase())
    .map(c => c.county.toLowerCase())
);
```

## How to Verify

After making the changes, test with:

```bash
cd /Users/nora/clawd/services/land-scraper

# Quick test: just load county targets and print them
node -e "
  require('dotenv').config();
  const airtable = require('./lib/airtable');
  airtable.loadCountyTargets().then(result => {
    console.log('Counties loaded:', result.counties.length);
    console.log('States:', [...new Set(result.counties.map(c => c.state))].sort().join(', '));
    console.log('Sample targets:');
    result.counties.slice(0, 10).forEach(c =>
      console.log('  ' + c.county + ', ' + c.state + ': $' + c.maxCPA + '/ac')
    );
  }).catch(err => console.error('ERROR:', err.message));
"
```

**Expected output**: A list of counties with CPA targets that match what Emma has in the Airtable "county" table. If you see `$1,500` for Dallas County, AL — that's correct. If you see `$4,500` — something is still reading the old JSON.

Then test the full filter:

```bash
node -e "
  require('dotenv').config();
  const airtable = require('./lib/airtable');
  const { initFilter, filterListing } = require('./lib/filter');
  airtable.loadCountyTargets().then(({ countyMap }) => {
    initFilter(countyMap);
    // Test with a county you know the target for
    const result = filterListing({
      price: 200000, acres: 50,
      county: 'Dallas', state: 'AL',
      url: 'https://example.com/test'
    });
    console.log('Passed:', result.passed);
    console.log('CPA Target:', result.cpaTarget);
    console.log('Computed CPA:', 200000/50);
    console.log('Reason:', result.reason);
  });
"
```

At $4,000/ac with a $1,500/ac target, that listing should be **rejected** (167% over target).

## What NOT to Change

- The filter logic itself (thresholds, stages, validation) stays the same
- The dedup logic stays the same
- The parsers stay the same (except removing old filter imports)
- The `config/settings.json` stays the same
- The Airtable field names for the Leads table stay the same

## Why This Matters

Every time the scraper runs, it now reads fresh targets from Airtable. If Emma updates "CPA top target" for a county, or adds/removes counties, the next scraper run automatically uses the new values. No code changes, no deploys, no JSON files to edit.
