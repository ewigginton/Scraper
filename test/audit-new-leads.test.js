'use strict';

// Tests scripts/audit-new-leads.js's PURE helpers (csvField, reasonCategory,
// extractLdPrice, extractTitleAcres, parseArgs) — none of these touch
// Airtable or the network, so they run with no .env/token required. The
// module only runs `main()` (which does touch Airtable) when executed
// directly (`require.main === module`), so requiring it here is safe; see
// the guard at the bottom of scripts/audit-new-leads.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cheerio = require('cheerio');

const {
  csvField, csvRow, reasonCategory, extractLdPrice, extractTitleAcres,
  extractPageLoadAcreage, extractStructuredAcres, extractStructuredStatus,
  scopeHtmlToSubjectListing, deriveCountyFromUrlSlug, normalizeCountyAgainstAirtable,
  slugify, defaultOutDir, extractFromHtml, loadReplayMeta, loadReplaySnapshot,
} = require('../scripts/audit-new-leads');
const airtable = require('../lib/airtable');
const BaseParser = require('../lib/parsers/base-parser');
const { findAvailabilityMatches } = require('../lib/availability');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'audit-new-leads.js');
const LIB_LEAD_AUDIT_PATH = path.join(__dirname, '..', 'lib', 'lead-audit.js');

// --- csvField / csvRow ----------------------------------------------------

test('csvField: quotes values containing a comma, quote, or newline; passes plain values through', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(''), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(42), '42');
  assert.equal(csvField('now sold | county not a target: Nowhere, TX'), '"now sold | county not a target: Nowhere, TX"');
  assert.equal(csvField('9/1/2026 - $2,800/ac - 208'), '"9/1/2026 - $2,800/ac - 208"');
  assert.equal(csvField('has "quotes" inside'), '"has ""quotes"" inside"');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
});

test('csvRow: joins quoted fields with commas and ends with a newline', () => {
  const row = csvRow(['a', 'b,c', 'd"e']);
  assert.equal(row, 'a,"b,c","d""e"\n');
});

// --- reasonCategory --------------------------------------------------------
// Every reason string lib/lead-audit.js can actually produce must bucket to
// something other than 'other' — otherwise a reworded reason in
// lib/lead-audit.js silently stops showing up in summary.txt with no test
// failure to catch it.

test('reasonCategory: every reason phrasing auditLead can emit maps to a non-"other" category', () => {
  const sampleReasons = [
    'fetch failed: HTTP 500 for https://example.com',
    'could not extract price or acreage from the live page',
    'listing gone (HTTP 404)',
    'now under contract',
    'now sold',
    'below 40-acre floor: live 35 ac',
    'county not a target: Nowhere, TX',
    'county could not be determined from the page or the record',
    '$/ac over threshold: $7,000/ac vs $4,000/ac target (+75%)',
    'price sources disagree: page $500,000 vs structured $510,000',
    'acres sources disagree: structured 7.094 ac vs page 8 ac',
    'price: recorded $400,000, live $450,000',
    'acres: recorded 100, live 115',
    'county link missing; resolvable to Taney, MO',
    'county mismatch: recorded Cherokee, SC, live Darlington, SC',
    'watch zone: $5,500/ac is 22% over $4,500/ac target',
    'county (from page text) not a target: Nowhere, TX',
    'availability phrase outside subject listing: under contract',
    'corroborating page data: marketStatus=2 (pending)',
    'page data disagrees with phrase: marketStatus=1 (active)',
    'page data: marketStatus=7 (unmapped)',
    'county has no CPA Target in Airtable: Nowhere, TX (rejected by the nightly filter)',
  ];
  for (const reason of sampleReasons) {
    assert.notEqual(reasonCategory(reason), 'other', `expected a real category for: ${reason}`);
  }
});

test('reasonCategory: an unrecognized reason still buckets to "other" (no false-positive match)', () => {
  assert.equal(reasonCategory('something unrelated happened'), 'other');
});

// --- extractLdPrice ----------------------------------------------------

test('extractLdPrice: reads the price out of a JSON-LD offers block', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"582400"}}</script>
  </head><body></body></html>`;
  assert.equal(extractLdPrice(html), 582400);
});

test('extractLdPrice: skips malformed JSON-LD and keeps looking at later script tags', () => {
  const html = `<html><head>
    <script type="application/ld+json">{not valid json,,,}</script>
    <script type="application/ld+json">{"price": "199900"}</script>
  </head><body></body></html>`;
  assert.equal(extractLdPrice(html), 199900);
});

test('extractLdPrice: returns null when there is no JSON-LD at all', () => {
  assert.equal(extractLdPrice('<html><body>no structured data here</body></html>'), null);
});

// --- extractTitleAcres ---------------------------------------------------

test('extractTitleAcres: reads acreage from og:title when present', () => {
  const html = `<html><head>
    <meta property="og:title" content="New $199,900 &middot; 7.094&#177; Acres Graves County">
    <title>Some Other Title</title>
  </head><body><h1>A different h1</h1></body></html>`;
  assert.equal(extractTitleAcres(html), 7.094);
});

test('extractTitleAcres: falls back to h1 when there is no og:title', () => {
  const html = `<html><head><title>Whitetail Properties</title></head>
    <body><h1>177 Acres in Carroll County, TN</h1></body></html>`;
  assert.equal(extractTitleAcres(html), 177);
});

test('extractTitleAcres: falls back to <title> when there is neither og:title nor h1', () => {
  const html = `<html><head><title>40 Acres - Ozark County MO</title></head><body></body></html>`;
  assert.equal(extractTitleAcres(html), 40);
});

test('extractTitleAcres: returns null when the title/heading names no acreage', () => {
  const html = `<html><head><meta property="og:title" content="Beautiful Country Home"></head><body></body></html>`;
  assert.equal(extractTitleAcres(html), null);
});

// --- extractPageLoadAcreage / extractStructuredAcres ----------------------

test('extractPageLoadAcreage: reads listing_acreage from a data-track-data page_load payload', () => {
  const html = `<html><body>
    <div data-track="onload" data-track-event="page_load" data-track-data="{&quot;listing_state&quot;:&quot;kentucky&quot;,&quot;listing_acreage&quot;:7.094,&quot;listing_id&quot;:116446}"></div>
  </body></html>`;
  assert.equal(extractPageLoadAcreage(html), 7.094);
});

test('extractPageLoadAcreage: returns null when no page_load tracking element is present (most sources)', () => {
  assert.equal(extractPageLoadAcreage('<html><body><h1>177 Acres</h1></body></html>'), null);
});

test('extractPageLoadAcreage: returns null on a malformed data-track-data payload rather than throwing', () => {
  const html = `<div data-track-event="page_load" data-track-data="{not json}"></div>`;
  assert.equal(extractPageLoadAcreage(html), null);
});

test('extractStructuredAcres: prefers the page_load payload over the title when both are present, tagged source: "page_load"', () => {
  const html = `<html><head><meta property="og:title" content="8 Acres in Graves County"></head><body>
    <div data-track-event="page_load" data-track-data="{&quot;listing_acreage&quot;:7.094}"></div>
  </body></html>`;
  assert.deepEqual(extractStructuredAcres(html), { value: 7.094, source: 'page_load' });
});

test('extractStructuredAcres: falls back to the title when there is no page_load payload, tagged source: "title"', () => {
  const html = `<html><head><meta property="og:title" content="177 Acres in Carroll County"></head><body></body></html>`;
  assert.deepEqual(extractStructuredAcres(html), { value: 177, source: 'title' });
});

test('extractStructuredAcres: returns null when neither a page_load payload nor a title acreage is present', () => {
  assert.equal(extractStructuredAcres('<html><body>no acreage anywhere</body></html>'), null);
});

// --- extractStructuredStatus ------------------------------------------

test('extractStructuredStatus: reads marketStatus from a LandWatch-style inline page-state payload', () => {
  const html = '<script id="__SERVER_STATE__" type="application/json">{"propertyData":{"marketStatus":1}}</script>';
  assert.deepEqual(extractStructuredStatus(html), { field: 'marketStatus', value: 1 });
});

test('extractStructuredStatus: never reads a NEARBY listing\'s bare "status" field (only the subject\'s own "marketStatus")', () => {
  const html = '<script>{"otherListings":[{"status":1},{"status":2}]}</script>';
  assert.equal(extractStructuredStatus(html), null);
});

test('extractStructuredStatus: returns null when the page carries no marketStatus field at all (most sources)', () => {
  assert.equal(extractStructuredStatus('<html><body><h1>177 Acres</h1></body></html>'), null);
});

// --- scopeHtmlToSubjectListing (DEFECT 1) ---------------------------------

function loadFixtureHtml(recordId) {
  const p = path.join(__dirname, '..', 'data', 'audit', 'verify-smoke-r2', 'html', `${recordId}.html`);
  return fs.readFileSync(p, 'utf8');
}

test('scopeHtmlToSubjectListing: cuts a MossyOak page before its "Nearby Properties Around ..." widget (real false-REMOVE case, rec0R1YFrqHx3yOQ8)', () => {
  const html = loadFixtureHtml('rec0R1YFrqHx3yOQ8');
  const { scopedHtml, boundaryFound } = scopeHtmlToSubjectListing(html);
  assert.equal(boundaryFound, true);
  assert.ok(scopedHtml.length < html.length);
  // The widget's own "Under Contract" badge (for a DIFFERENT listing) must
  // be excluded from the scoped html...
  assert.ok(!scopedHtml.includes('Under Contract'), 'the nearby widget\'s "Under Contract" badge leaked into scope');
  // ...while everything up to that widget (the subject's own content) is
  // still intact.
  assert.ok(scopedHtml.includes('Winston'));
});

test('scopeHtmlToSubjectListing: cuts a Whitetail page before its "Nearby Related Properties" heading (rec0gIpbWbIkp9Ly5)', () => {
  const html = loadFixtureHtml('rec0gIpbWbIkp9Ly5');
  const { scopedHtml, boundaryFound } = scopeHtmlToSubjectListing(html);
  assert.equal(boundaryFound, true);
  assert.ok(!scopedHtml.includes('Nearby Related Properties'));
});

test('scopeHtmlToSubjectListing: a CSS class selector in a <head> stylesheet (".rs-nearby-block", ".message-related") never triggers the boundary', () => {
  const html = `<html><head><style>
      .rs-nearby-block, .rs-moreby-block { padding: 80px 0; }
      .listings-content .message-related { font-weight: 700; }
    </style></head><body>
      <h1>208 Acres in Ozark County</h1>
      <p>The subject property's own description, well under contract... just kidding, for sale.</p>
    </body></html>`;
  const { scopedHtml, boundaryFound } = scopeHtmlToSubjectListing(html);
  assert.equal(boundaryFound, false);
  assert.equal(scopedHtml, html);
});

test('scopeHtmlToSubjectListing: plain body prose mentioning "nearby" (not a widget) never triggers the boundary', () => {
  const html = `<html><body><h1>Country Home</h1>
    <p>Convenient access to nearby public recreation and a nice pond.</p>
  </body></html>`;
  const { scopedHtml, boundaryFound } = scopeHtmlToSubjectListing(html);
  assert.equal(boundaryFound, false);
  assert.equal(scopedHtml, html);
});

test('scopeHtmlToSubjectListing: a LandWatch-style inline "otherListings" JSON widget payload is treated as a boundary', () => {
  const html = `<html><body><h1>208 Acres</h1><p>Subject description.</p>
    <script id="__SERVER_STATE__" type="application/json">{"otherListings":[{"title":"SOLD - Some Other Tract"}]}</script>
  </body></html>`;
  const { scopedHtml, boundaryFound } = scopeHtmlToSubjectListing(html);
  assert.equal(boundaryFound, true);
  assert.ok(!scopedHtml.includes('SOLD - Some Other Tract'));
  assert.ok(scopedHtml.includes('Subject description'));
});

test('scopeHtmlToSubjectListing: returns the html unchanged (boundaryFound: false) when there is no <body> tag at all', () => {
  const html = '<div>not a full document</div>';
  const { scopedHtml, boundaryFound } = scopeHtmlToSubjectListing(html);
  assert.equal(boundaryFound, false);
  assert.equal(scopedHtml, html);
});

// --- DEFECT 2: JSON-key boundary excises only the otherListings ARRAY ----
// Real LandWatch detail page (test/fixtures/landwatch-detail-rec0650SDW4OCCqo8.html,
// copied from data/audit/round3-smoke/html/rec0650SDW4OCCqo8.html): its
// inline __SERVER_STATE__ payload carries "otherListings" BEFORE the
// subject's own marketStatus/formattedDescription/listhubListingStatus
// fields in the SAME JSON object — a blanket truncation at the
// "otherListings" key (the old behavior) silently discarded those subject
// fields too.

function loadLandwatchFixture() {
  return fs.readFileSync(
    path.join(__dirname, 'fixtures', 'landwatch-detail-rec0650SDW4OCCqo8.html'), 'utf8'
  );
}

test('scopeHtmlToSubjectListing: DEFECT 2 — on a real LandWatch page, excises the otherListings array but keeps the subject\'s own marketStatus/formattedDescription/listhubListingStatus (which come AFTER it in the payload)', () => {
  const html = loadLandwatchFixture();
  // Sanity-check the fixture actually reproduces the real bug shape before
  // trusting the assertions built on it.
  assert.ok(html.indexOf('"otherListings"') < html.indexOf('"marketStatus"'), 'fixture must carry otherListings BEFORE marketStatus, or this test proves nothing');
  // This exact title belongs to ONE specific entry inside the otherListings
  // array (a different, unrelated tract) — never the subject's own.
  const otherListingTitle = '10 Acres in Gated Jefferson County Community';
  assert.ok(html.includes(otherListingTitle), 'fixture must actually contain the otherListings entry title this test excises');

  const { scopedHtml, boundaryFound } = scopeHtmlToSubjectListing(html);
  assert.equal(boundaryFound, true);
  assert.ok(scopedHtml.length < html.length);

  // The OTHER listing's own content must be gone...
  assert.ok(!scopedHtml.includes(otherListingTitle), 'a nearby listing\'s own title leaked into scope');
  // ...while the subject's own fields, which come AFTER "otherListings" in
  // the same payload, must survive (this is the actual DEFECT 2 fix).
  assert.ok(scopedHtml.includes('"marketStatus"'), 'the subject\'s own marketStatus was truncated away');
  assert.ok(scopedHtml.includes('formattedDescription'), 'the subject\'s own formattedDescription was truncated away');
  assert.ok(scopedHtml.includes('listhubListingStatus'), 'the subject\'s own listhubListingStatus was truncated away');
});

test('extractStructuredStatus: DEFECT 2 — reads the subject\'s marketStatus from the SCOPED html (not just the unscoped page)', () => {
  const html = loadLandwatchFixture();
  const unscoped = extractStructuredStatus(html);
  const { scopedHtml } = scopeHtmlToSubjectListing(html);
  const scoped = extractStructuredStatus(scopedHtml);
  assert.deepEqual(unscoped, { field: 'marketStatus', value: 1 });
  // The whole point of the fix: scoping must not cost us the field it used
  // to truncate away.
  assert.deepEqual(scoped, unscoped);
});

test('DEFECT 2 end-to-end: a subject-level "Under Contract" injected into marketStatusText (which sits AFTER otherListings, like the real payload) is detected as a SCOPED availability flag, and marketStatus is still readable', () => {
  const html = loadLandwatchFixture();
  // Inject a subject-level marketStatusText field right next to the
  // subject's own marketStatus — same position in the payload (after
  // otherListings) as LandWatch's real fields. Before the DEFECT 2 fix,
  // this text would have been truncated away along with everything else
  // past "otherListings", so "Under Contract" would never have reached
  // availability-phrase scanning at all.
  assert.ok(html.includes('"marketStatus":1'), 'fixture must contain the exact marketStatus field this test injects next to');
  const injected = html.replace('"marketStatus":1', '"marketStatus":1,"marketStatusText":"Under Contract"');

  const { scopedHtml } = scopeHtmlToSubjectListing(injected);

  const structuredStatus = extractStructuredStatus(scopedHtml);
  assert.deepEqual(structuredStatus, { field: 'marketStatus', value: 1 });

  const scopedBodyText = cheerio.load(scopedHtml)('body').text();
  const scopedFlags = findAvailabilityMatches(scopedBodyText);
  assert.ok(scopedFlags.includes('under contract'), `expected a scoped "under contract" flag, got: ${scopedFlags.join(', ')}`);
});

// --- deriveCountyFromUrlSlug (DEFECT 3) -----------------------------------

test('deriveCountyFromUrlSlug: LandWatch "<county>-county-<state>-...-for-sale/pid/<id>"', () => {
  const url = 'https://www.landwatch.com/ozark-county-missouri-recreational-property-for-sale/pid/427744258';
  assert.deepEqual(deriveCountyFromUrlSlug(url), { county: 'Ozark', state: 'missouri' });
});

test('deriveCountyFromUrlSlug: Whitetail Properties "/hunting-land/<state>/<county>/<slug>"', () => {
  const url = 'https://www.whitetailproperties.com/hunting-land/kentucky/graves/country-home-and-wooded-acreage-in-graves-county-ky';
  assert.deepEqual(deriveCountyFromUrlSlug(url), { county: 'Graves', state: 'kentucky' });
});

test('deriveCountyFromUrlSlug: Mossy Oak Properties "<slug>-<county>-<state>/<id>/"', () => {
  const url = 'https://www.mossyoakproperties.com/property/moreland-property-winston-alabama/89643/';
  assert.deepEqual(deriveCountyFromUrlSlug(url), { county: 'Winston', state: 'alabama' });
});

test('deriveCountyFromUrlSlug: LandWatch with a TWO-WORD state name is not truncated to its first word (real regression: "south" instead of "south-carolina")', () => {
  const url = 'https://www.landwatch.com/darlington-county-south-carolina-undeveloped-land-for-sale/pid/425066098';
  assert.deepEqual(deriveCountyFromUrlSlug(url), { county: 'Darlington', state: 'south-carolina' });
});

test('deriveCountyFromUrlSlug: Mossy Oak Properties with a TWO-WORD state name', () => {
  const url = 'https://www.mossyoakproperties.com/property/some-tract-chesterfield-south-carolina/12345/';
  assert.deepEqual(deriveCountyFromUrlSlug(url), { county: 'Chesterfield', state: 'south-carolina' });
});

test('deriveCountyFromUrlSlug: Whitetail Properties with a TWO-WORD state path segment', () => {
  const url = 'https://www.whitetailproperties.com/hunting-land/south-carolina/darlington/some-tract';
  assert.deepEqual(deriveCountyFromUrlSlug(url), { county: 'Darlington', state: 'south-carolina' });
});

test('deriveCountyFromUrlSlug: Tutt Land & Co "/land-sale/<state>/<county>-county/<slug>"', () => {
  const url = 'https://www.tuttland.com/land-sale/alabama/autauga-county/some-tract';
  assert.deepEqual(deriveCountyFromUrlSlug(url), { county: 'Autauga', state: 'alabama' });
});

test('deriveCountyFromUrlSlug: landflip/nationalland have no reliable per-listing URL county — returns null', () => {
  assert.equal(deriveCountyFromUrlSlug('https://www.landflip.com/listing/420517'), null);
  assert.equal(deriveCountyFromUrlSlug('https://www.nationalland.com/property/some-tract/12345'), null);
});

test('deriveCountyFromUrlSlug: an unparseable URL returns null rather than throwing', () => {
  assert.equal(deriveCountyFromUrlSlug('not a url'), null);
});

// --- normalizeCountyAgainstAirtable ---------------------------------------

test('normalizeCountyAgainstAirtable: resolves to the Airtable County table\'s own canonical spelling/abbreviation', (t) => {
  const original = airtable.listAllCounties;
  airtable.listAllCounties = () => [{ county: 'Ozark', state: 'MO' }, { county: 'Wayne', state: 'KY' }];
  t.after(() => { airtable.listAllCounties = original; });

  assert.deepEqual(normalizeCountyAgainstAirtable('ozark', 'missouri'), { county: 'Ozark', state: 'MO' });
});

test('normalizeCountyAgainstAirtable: DEFECT 3 — returns null (never a raw-guess fallback) when there is no Airtable match, so an unmatched slug guess is never promoted to trusted "url" provenance', (t) => {
  const original = airtable.listAllCounties;
  airtable.listAllCounties = () => [{ county: 'Ozark', state: 'MO' }];
  t.after(() => { airtable.listAllCounties = original; });

  assert.equal(normalizeCountyAgainstAirtable('Nowhere', 'texas'), null);
});

test('normalizeCountyAgainstAirtable + deriveCountyFromUrlSlug: DEFECT 3 — a MossyOak URL slug that misreads as county "Tract" never resolves against Airtable', (t) => {
  const original = airtable.listAllCounties;
  // A real target county exists, just not "Tract" — the point is that
  // deriveCountyFromUrlSlug's best-effort slug guess must never be
  // promoted just because ANY counties are configured.
  airtable.listAllCounties = () => [{ county: 'Winston', state: 'AL' }];
  t.after(() => { airtable.listAllCounties = original; });

  const derived = deriveCountyFromUrlSlug('https://www.mossyoakproperties.com/property/timber-tract-alabama/12345/');
  assert.deepEqual(derived, { county: 'Tract', state: 'alabama' });
  assert.equal(normalizeCountyAgainstAirtable(derived.county, derived.state), null);
});

test('normalizeCountyAgainstAirtable: returns null for an empty county', () => {
  assert.equal(normalizeCountyAgainstAirtable(null, 'texas'), null);
});

test('normalizeCountyAgainstAirtable: handles a hyphenated two-word state (as deriveCountyFromUrlSlug produces) against Airtable', (t) => {
  const original = airtable.listAllCounties;
  airtable.listAllCounties = () => [{ county: 'Darlington', state: 'SC' }];
  t.after(() => { airtable.listAllCounties = original; });

  assert.deepEqual(normalizeCountyAgainstAirtable('Darlington', 'south-carolina'), { county: 'Darlington', state: 'SC' });
});

// --- slugify / defaultOutDir ----------------------------------------------

test('slugify: lowercases, replaces non-alphanumerics with hyphens, trims edge hyphens', () => {
  assert.equal(slugify('New Lead'), 'new-lead');
  assert.equal(slugify('Emma Review!!'), 'emma-review');
});

test('defaultOutDir: builds a data/audit/<date>-<slug> path', () => {
  const dir = defaultOutDir('New Lead');
  assert.match(dir, /^data[/\\]audit[/\\]\d{4}-\d{2}-\d{2}-new-lead$/);
});

// --- parseArgs (via a real process, since invalid input calls process.exit) -

test('CLI: --limit 0 is rejected (never silently audits everything) and exits non-zero', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--limit', '0', '--out', '/tmp/should-not-be-created'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--limit must be a positive integer/);
});

test('CLI: a non-numeric --limit is rejected the same way', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--limit', 'abc', '--out', '/tmp/should-not-be-created'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--limit must be a positive integer/);
});

test('CLI: an unknown flag is rejected with a usage message', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--bogus-flag'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument: --bogus-flag/);
});

// --- write-path guard -------------------------------------------------
// This is a READ-ONLY audit tool. Neither the runner nor the pure verdict
// logic it depends on may ever import or call an Airtable-mutating helper —
// a static grep is cheap insurance that stays red the instant one sneaks in
// through a careless refactor, independent of any runtime test coverage.

test('write-path guard: scripts/audit-new-leads.js and lib/lead-audit.js source contains no Airtable-mutating call', () => {
  const forbidden = /writeListings|updateRecord|createLeadRecord|updateIntakeRecord|getLeadsTable|listingToFields|processIntakeQueue/;
  for (const file of [SCRIPT_PATH, LIB_LEAD_AUDIT_PATH]) {
    const source = fs.readFileSync(file, 'utf8');
    const match = forbidden.exec(source);
    assert.equal(match, null, `${file} contains a write-path reference: "${match && match[0]}"`);
  }
});

// --- --replay ---------------------------------------------------------
// No network, no Airtable — these hit loadReplayMeta/loadReplaySnapshot/
// extractFromHtml directly against a tiny fake directory on disk.

function makeReplayDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-replay-test-'));
  fs.mkdirSync(path.join(dir, 'html'));
  return dir;
}

test('--replay: loadReplaySnapshot reads a saved HTML file straight off disk, with fetch metadata from audit.json, no network involved', () => {
  const dir = makeReplayDir();
  const html = '<html><body><h1>40 Acres in Ozark County MO</h1><p>$150,000</p></body></html>';
  fs.writeFileSync(path.join(dir, 'html', 'recFAKE123.html'), html);
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify([
    { id: 'recFAKE123', httpStatus: null, fetchError: null, fetchMs: 812 },
    { id: 'recOTHER', httpStatus: 404, fetchError: 'HTTP 404 for https://example.com/x', fetchMs: 55 },
  ]));

  const meta = loadReplayMeta(dir);
  const snapshot = loadReplaySnapshot(dir, 'recFAKE123', meta);
  assert.equal(snapshot.html, html);
  assert.equal(snapshot.httpStatus, null);
  assert.equal(snapshot.fetchMs, 812);
  assert.equal(snapshot.fetchError, null);
});

test('--replay: loadReplaySnapshot preserves a recorded fetchError (e.g. an original 404) for a record with no saved HTML', () => {
  const dir = makeReplayDir();
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify([
    { id: 'recGONE', httpStatus: 404, fetchError: 'HTTP 404 for https://example.com/listing/1', fetchMs: 300 },
  ]));

  const meta = loadReplayMeta(dir);
  const snapshot = loadReplaySnapshot(dir, 'recGONE', meta);
  assert.equal(snapshot.html, null);
  assert.equal(snapshot.httpStatus, 404);
  assert.equal(snapshot.fetchError, 'HTTP 404 for https://example.com/listing/1');
});

test('--replay: a record with no saved HTML and no recorded fetchError is marked with the fixed "no saved page in replay dir" reason', () => {
  const dir = makeReplayDir();
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify([])); // no row at all for this id

  const meta = loadReplayMeta(dir);
  const snapshot = loadReplaySnapshot(dir, 'recMISSING', meta);
  assert.equal(snapshot.html, null);
  assert.equal(snapshot.fetchError, 'no saved page in replay dir');
});

test('--replay: loadReplayMeta returns an empty Map (never throws) when the replay dir has no audit.json at all', () => {
  const dir = makeReplayDir();
  const meta = loadReplayMeta(dir);
  assert.equal(meta.size, 0);
  const snapshot = loadReplaySnapshot(dir, 'recAny', meta);
  assert.equal(snapshot.html, null);
  assert.equal(snapshot.fetchError, 'no saved page in replay dir');
});

test('extractFromHtml: recomputes extraction from raw HTML with no network — the same pipeline --replay drives', () => {
  const html = `<html><head><meta property="og:title" content="182 Acres in Ozark County MO"></head>
    <body><h1>182 Acres</h1><div class="price">$450,000</div><p>Great hunting property.</p></body></html>`;
  const fetcher = new BaseParser('LeadAuditTest');
  const result = extractFromHtml(html, 'https://example.com/listing/1', fetcher);
  assert.equal(result.extracted.acres, 182);
  assert.equal(result.extracted.price, 450000);
  assert.deepEqual(result.scopedFlags, []);
});
