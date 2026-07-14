'use strict';

const cheerio = require('cheerio');
const airtable = require('./airtable');
const BaseParser = require('./parsers/base-parser');
const browserFetch = require('./browser-fetch');
const { extractPrice } = require('./price-checker');
const { generateFingerprint } = require('./fingerprint');
const { stateFullName } = require('./states');

/**
 * Listing Intake processor.
 *
 * Team members submit listing URLs through the Airtable "Listing Intake"
 * form; this imports each one into the Land table as a NEW LEAD. Runs as
 * part of the nightly job, so results (and failures) land in the single
 * consolidated email.
 *
 * Fetches go through the same bot-block handling as the scraper: plain
 * fetch first, real-browser fallback on HTTP 403s and challenge pages
 * (Zillow/LandWatch/Land.com/Realtor all block plain clients).
 *
 * Status flow:
 *   New/empty → Added | Duplicate | Retry (first failure — reprocessed on
 *   the NEXT nightly run, i.e. a day later)
 *   Retry     → Added | Duplicate | Failed (second failure — a human sets
 *   Status back to 'New' to force another attempt)
 */
async function processIntakeQueue(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const report = {
    processed: 0,
    created: 0,
    duplicates: 0,
    retryQueued: 0,
    failedFinal: 0,
    failures: [],
    added: [],
    dryRun,
  };

  let queue;
  try {
    queue = await airtable.getIntakeQueue();
  } catch (err) {
    // No intake table (or no access) must never break the nightly run
    console.warn(`[Intake] Could not load intake queue: ${err.message}`);
    report.loadError = err.message;
    return report;
  }
  if (queue.length === 0) {
    console.log('[Intake] No pending intake submissions.');
    return report;
  }

  console.log(`[Intake] Processing ${queue.length} intake submission(s)...`);
  if (dryRun) {
    report.wouldProcess = queue.length;
    console.log(`[Intake] Dry run — ${queue.length} submission(s) left untouched.`);
    return report;
  }

  // One dedup index load for the whole queue
  let dedupIndex;
  try {
    dedupIndex = await airtable.loadDedupIndex();
  } catch (err) {
    console.warn(`[Intake] Could not load dedup index, skipping intake this run: ${err.message}`);
    report.loadError = `Dedup index load failed: ${err.message}`;
    return report;
  }

  const fetcher = new BaseParser('Intake');
  const { INTAKE_FIELDS: F, INTAKE_STATUS: S } = airtable;

  for (const record of queue) {
    const url = String(record.fields[F.url] || '').trim();
    const submitter = selectName(record.fields[F.submittedBy]) || 'team';
    const isRetry = selectName(record.fields[F.status]) === S.retry;
    report.processed++;

    try {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`Not a valid listing URL: "${url || '(empty)'}"`);
      }

      // Politeness gap between fetches — these are one-off detail pages
      await fetcher.sleep(2000 + Math.floor(Math.random() * 1000));

      let html = await fetcher.fetchPageSmart(url);
      if (fetcher.isBlockedPage(html) && browserFetch.isEnabled()) {
        // Challenge page served with HTTP 200 — one browser attempt
        html = await fetcher.browserFetch(url);
      }
      if (fetcher.isBlockedPage(html)) {
        throw new Error('Site served a bot-challenge page (even to the browser)');
      }

      const extracted = extractListingDetails(html, url);
      const listing = {
        name: extracted.name || `Intake submission (${hostnameOf(url)})`,
        price: extracted.price,
        acres: extracted.acres,
        county: extracted.county,
        state: extracted.state,
        url,
        source: `Intake: ${hostnameOf(url)} (${submitter})`,
        stage: airtable.STAGES.newLead,
        description: buildNotes(extracted, record.fields[F.note], submitter),
      };

      // Dedup against the Land table (includes Not Interested records)
      const dupCheck = airtable.checkDuplicate(listing, dedupIndex);
      if (dupCheck.isDuplicate) {
        report.duplicates++;
        await airtable.updateIntakeRecord(record.id, {
          [F.status]: S.duplicate,
          [F.result]: `Already in the Land table — ${dupCheck.reason}`,
          [F.processedAt]: new Date().toISOString(),
        });
        console.log(`[Intake] Duplicate: ${url}`);
        continue;
      }
      listing.fingerprint = generateFingerprint(listing);

      const landRecordId = await airtable.createLeadRecord(listing);
      if (listing.url) dedupIndex.urlSet.add(listing.url);
      if (listing.fingerprint) dedupIndex.fingerprintSet.add(listing.fingerprint);

      const summary = describeCreated(extracted);
      await airtable.updateIntakeRecord(record.id, {
        [F.status]: S.added,
        [F.result]: summary,
        [F.landRecord]: [landRecordId],
        [F.processedAt]: new Date().toISOString(),
      });
      report.created++;
      report.added.push({ url, submitter, summary });
      console.log(`[Intake] Added: ${url} → ${landRecordId}`);

    } catch (err) {
      const reason = err.message;
      const final = isRetry;
      console.error(`[Intake] ${final ? 'FAILED (final)' : 'Failed (will retry tomorrow)'}: ${url} — ${reason}`);
      report.failures.push({ url, submitter, error: reason, final });
      if (final) report.failedFinal++;
      else report.retryQueued++;

      try {
        await airtable.updateIntakeRecord(record.id, {
          [F.status]: final ? S.failed : S.retry,
          [F.result]: final
            ? `Attempt 2 failed: ${reason}. Set Status to 'New' to try again.`
            : `Attempt 1 failed: ${reason} — will retry automatically on tomorrow night's run.`,
          [F.processedAt]: new Date().toISOString(),
        });
      } catch (updateErr) {
        console.error(`[Intake] Could not record failure on ${record.id}: ${updateErr.message}`);
      }
    }
  }

  console.log(`[Intake] Done: ${report.created} added, ${report.duplicates} duplicates, ${report.retryQueued} queued for retry, ${report.failedFinal} failed permanently`);
  return report;
}

/**
 * Best-effort extraction from an arbitrary listing detail page:
 * title, price, acreage, description, and county/state.
 */
function extractListingDetails(html, url) {
  const $ = cheerio.load(html);

  const name = cleanTitle(
    $('meta[property="og:title"]').attr('content')
    || $('h1').first().text()
    || $('title').text()
  );
  const description = ($('meta[property="og:description"]').attr('content')
    || $('meta[name="description"]').attr('content')
    || '').trim().slice(0, 500);

  const price = extractPrice(html);
  const bodyText = $('body').text();
  const acres = extractAcres(`${name || ''} ${description} ${bodyText}`);
  const { county, state } = extractCountyState(url, `${name || ''} ${description} ${bodyText}`);

  return { name, description, price, acres, county, state };
}

function cleanTitle(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s+/g, ' ').trim().split(/\s+[|–—-]\s+(?=[A-Z])/)[0].trim();
  return cleaned.slice(0, 120) || null;
}

/**
 * Acreage from free text: "160 acres", "155± Acres", "30 +/- acres",
 * "1,118-acre ranch", "Lot size: 42.5 Acres".
 */
function extractAcres(text) {
  if (!text) return null;
  const candidates = [];
  const re = /([\d,]+(?:\.\d+)?)\s*(?:±|\+\/-|\+-)?\s*[- ]?acres?\b/gi;
  let match;
  while ((match = re.exec(text)) !== null && candidates.length < 25) {
    const value = parseFloat(match[1].replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0 && value < 100000) candidates.push(value);
  }
  if (candidates.length === 0) return null;
  // Detail pages usually repeat the property's own acreage most often —
  // take the most frequent value, largest on ties (nearby-listings widgets
  // contribute stray smaller figures)
  const counts = new Map();
  for (const value of candidates) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))[0][0];
}

/**
 * County/state from the URL slug ("pittsburg-county-oklahoma", "/TN/") and
 * page text ("Pittsburg County, OK"), matched against the Airtable County
 * table (populated by loadCountyTargets earlier in the run). Best effort —
 * unmatched counties are noted for Emma to fill in.
 */
function extractCountyState(url, text) {
  const counties = airtable.listAllCounties();
  if (counties.length === 0) return { county: null, state: null };

  const urlSlug = decodeURIComponent(url).toLowerCase().replace(/[_-]+/g, ' ');
  const haystackText = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `;

  let textMatch = null;
  for (const { county, state } of counties) {
    const countyLower = county.toLowerCase();
    // URL slugs are the strongest signal: "pittsburg county oklahoma"
    if (urlSlug.includes(`${countyLower} county`)) {
      return { county, state };
    }
    if (!textMatch && haystackText.includes(`${countyLower} county`)) {
      const stateOk = haystackText.includes(` ${state.toLowerCase()} `)
        || haystackText.includes(stateFullName(state).toLowerCase());
      if (stateOk) textMatch = { county, state };
    }
  }
  return textMatch || { county: null, state: null };
}


function buildNotes(extracted, submitterNote, submitter) {
  const lines = ['Submitted via Listing Intake form.'];
  if (submitterNote) lines.push(`${submitter}'s note: ${String(submitterNote).trim()}`);
  if (extracted.description) lines.push('', extracted.description);

  const gaps = [];
  if (!extracted.price) gaps.push('price');
  if (!extracted.acres) gaps.push('acres');
  if (!extracted.county) gaps.push('county');
  if (gaps.length > 0) {
    lines.push('', `⚠️ Could not extract from the page: ${gaps.join(', ')} — please fill in manually.`);
  }
  return lines.join('\n');
}

function describeCreated(extracted) {
  const parts = [];
  parts.push(extracted.price ? `$${extracted.price.toLocaleString()}` : 'price unknown');
  parts.push(extracted.acres ? `${extracted.acres} acres` : 'acres unknown');
  if (extracted.county) parts.push(`${extracted.county} County, ${extracted.state}`);
  return `Created New Lead from submitted URL: ${parts.join(', ')}.`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return 'unknown site';
  }
}

/** Airtable singleSelect values arrive as strings via the SDK; be tolerant of objects. */
function selectName(value) {
  if (value && typeof value === 'object') return value.name;
  return value;
}

module.exports = { processIntakeQueue, extractListingDetails, extractAcres, extractCountyState, cleanTitle };
