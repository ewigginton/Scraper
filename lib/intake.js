'use strict';

const cheerio = require('cheerio');
const airtable = require('./airtable');
const BaseParser = require('./parsers/base-parser');
const browserFetch = require('./browser-fetch');
const { extractPrice } = require('./price-checker');
const { generateFingerprint, normalizeCounty } = require('./fingerprint');
const { stateFullName } = require('./states');
const { assertPublicUrl } = require('./url-guard');
// Single source of truth for availability-status phrases (under contract,
// sold, etc.) — lib/availability.js owns the list so intake, review, and the
// scraper's skip logic never drift apart. findAvailabilityMatches (not a
// manual AVAILABILITY_FLAGS filter) is what carries the anchored 'sold'
// detection, so it's the only entry point used below.
const { findAvailabilityMatches } = require('./availability');
// Subject-listing reader (per-site rules) plus the subject-scoped generic
// helpers it shares with the fallback path below.
const { readListingSubject, scopeHtmlToSubjectListing, extractAcres } = require('./listing-subject');
const { resolveMinAcres } = require('./scraper');

// Added to a created lead's notes and the intake Result when the subject
// listing was read but its status was not shown (statusKind null): unknown is
// never treated as "available", so a human confirms it.
const STATUS_UNKNOWN_NOTE = 'Listing status not shown on the page — confirm it is still available';
const { checkHardPlausibility, checkPricePerAcrePlausibility } = require('./plausibility');

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
    rejected: 0,
    retryQueued: 0,
    failedFinal: 0,
    reclaimed: 0,
    failures: [],
    added: [],
    rejections: [],
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

  // Rows marked 'Needs Review' with an HTTP-error Result were failed by the
  // LEGACY intake poller — it's still installed on the production Mac.
  // getIntakeQueue reclaims them so they retry here, but surface it loudly.
  report.reclaimed = queue.filter(r => selectName(r.fields[airtable.INTAKE_FIELDS.status]) === airtable.INTAKE_STATUS.needsReview).length;
  if (report.reclaimed > 0) {
    console.warn(`[Intake] ${report.reclaimed} submission(s) had been failed by the old intake importer — it appears to still be running; remove it with scripts/setup-production.sh`);
  }

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

      // These URLs are submitted by team members through an Airtable form, so
      // block SSRF to internal hosts before ANY fetch (plain or browser). A
      // rejection here throws into the same catch as a fetch failure, so the
      // item follows the normal Retry → Failed status flow. NOTE: node-fetch
      // follows redirects and we do NOT re-validate each redirect hop — see
      // lib/url-guard.js; per-hop re-validation is a deliberate non-goal.
      //
      // SCRAPER_ALLOW_LOOPBACK_FETCH=true bypasses the guard so integration
      // tests can serve fixtures from 127.0.0.1. Production never sets it.
      if (process.env.SCRAPER_ALLOW_LOOPBACK_FETCH !== 'true') {
        await assertPublicUrl(url);
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

      // Emma's rules apply to intake exactly like the scraper's own Step 4.6
      // safety net (lib/scraper.js): under-contract/sold/off-market listings
      // and anything below the 40-acre floor never become a lead. A missing
      // acres extraction is NOT "below the floor" — that's just data the
      // team member (or Emma) fills in by hand, so it still creates the lead
      // with a warning, same as before this check existed.
      const rejectReason = describeIntakeRejection(extracted, resolveMinAcres());
      if (rejectReason) {
        report.rejected++;
        report.rejections.push({ url, submitter, reason: rejectReason });
        // Deterministic reject, not a fetch/parse failure — goes straight to
        // a terminal, non-retry status (never S.retry: re-fetching tomorrow
        // won't change that this listing is under contract or too small).
        await airtable.updateIntakeRecord(record.id, {
          [F.status]: S.failed,
          [F.result]: `Not imported: ${rejectReason}`,
          [F.processedAt]: new Date().toISOString(),
        });
        console.log(`[Intake] Rejected (${rejectReason}): ${url}`);
        continue;
      }

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
      if (dupCheck.suspectedCrossSite) {
        // Layer-3 near-match: written anyway (sibling tracts of identical
        // size/price are common in rural land), but flagged. Propagated
        // identically to the scraper path so the 'Possible Dup Reason' field
        // is written and the record is marked 'Has Warnings'.
        listing.validationErrors = [...(listing.validationErrors || []), dupCheck.suspectedCrossSite];
        listing.possibleDuplicateReason = dupCheck.suspectedCrossSite;
      }
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
 * Extraction from a listing detail page: title, price, acreage, description,
 * county/state, and availability.
 *
 * Status, price, acreage and county come from the SUBJECT listing only
 * (lib/listing-subject.js readListingSubject — per-site rules verified on
 * 420 real pages), never from a "Nearby Properties" widget or a site's
 * search-filter menu elsewhere on the page. On a KNOWN site whose listing
 * block cannot be found (e.g. a LandWatch error shell) this throws, so the
 * submission goes through Retry -> Failed instead of becoming a lead with
 * guessed values. On an unknown site the older text extraction runs, on HTML
 * cut down to the subject listing (scopeHtmlToSubjectListing).
 */
function extractListingDetails(html, url) {
  const $ = cheerio.load(html);

  const rawTitle = (
    $('meta[property="og:title"]').attr('content')
    || $('h1').first().text()
    || $('title').text()
    || ''
  ).trim();
  const name = cleanTitle(rawTitle);
  const description = ($('meta[property="og:description"]').attr('content')
    || $('meta[name="description"]').attr('content')
    || '').trim().slice(0, 500);

  const { scopedHtml } = scopeHtmlToSubjectListing(html);
  const scopedBodyText = cheerio.load(scopedHtml)('body').text();
  const combinedText = `${name || ''} ${description} ${scopedBodyText}`;

  const subject = readListingSubject(html, url);
  if (subject.ok) {
    // The subject's own status word ("Under Contract", "Off Market",
    // "Pending Under Contract", "Sold") becomes the rejection phrase.
    const availabilityFlags = subject.unavailable && subject.status
      ? [subject.status.toLowerCase()]
      : [];
    const location = resolveSubjectCounty(subject, url, combinedText);
    return {
      name,
      description,
      price: subject.price,
      acres: subject.acres,
      county: location.county,
      state: location.state,
      countyNote: location.note || null,
      statusNote: subject.statusKind === null ? STATUS_UNKNOWN_NOTE : null,
      availabilityFlags,
      subject,
    };
  }

  // A known site whose listing block is missing (a LandWatch error shell: the
  // listing is gone or the page did not render) is NOT guessed from page
  // text — that produced wrong acreage and no price. It fails the attempt
  // instead (Retry tonight -> Failed), the same "could not read" verdict the
  // nightly lead recheck gives the page. No extra fetches.
  if (subject.source !== 'generic') {
    throw new Error(`Could not read the listing (${subject.note || 'listing details not found on the page'})`);
  }

  // Unknown site: the older text extraction, scoped to the subject listing.
  const price = extractPrice(scopedHtml);
  const acres = extractAcres(combinedText);
  const { county, state } = extractCountyState(url, combinedText);
  // Availability is scanned on the RAW title, not the cleaned display name:
  // cleanTitle's site-suffix splitter treats " - " before a capital as a
  // "<name> - <SiteName>" separator and eats the exact "SOLD - " prefix the
  // anchored sold detection keys on ("SOLD - Big Ranch" -> "SOLD"). The
  // cleaned name stays what Emma sees; detection sees what the page said.
  const availabilityFlags = findAvailabilityMatches(`${rawTitle} ${description} ${scopedBodyText}`);

  return { name, description, price, acres, county, state, availabilityFlags, subject };
}

/**
 * County/state for a subject reading. The page's own county wins when it is
 * in the Airtable County table (spelling-tolerant: "Le Flore" == "Leflore";
 * createLeadRecord then links the row with a CPA Target). When the
 * page names a county that is NOT in the table, no other county is guessed
 * from page text (a description's "near Taney County" is not the listing's
 * county); the lead is created without one and the note says why. When the
 * page gave no county, the URL-slug/page-text matcher runs as before.
 */
function resolveSubjectCounty(subject, url, text) {
  if (subject.county && subject.state) {
    const counties = airtable.listAllCounties();
    const key = countyKey(subject.county);
    const match = counties.find(c => String(c.state).toUpperCase() === subject.state && countyKey(c.county) === key);
    if (match) return { county: match.county, state: match.state };
    if (counties.length > 0) {
      return {
        county: null,
        state: null,
        note: `the page says ${subject.county} County, ${subject.state}, which is not in the County table`,
      };
    }
  }
  return extractCountyState(url, text);
}

/**
 * Emma's deterministic intake rejects, in plain English for the submitting
 * team member's Result field — or null when the listing should still be
 * created. Availability wins over acreage when both apply (a smaller reason
 * to reject doesn't matter once it's already off the table). The
 * plausibility check (lib/plausibility.js GUARD 1b) runs before the
 * acreage-floor check — a garbled price/acres extraction (e.g. a glued
 * number) makes the floor comparison meaningless anyway. A MISSING acres
 * value is not "implausible" (checkListingPlausibility only flags values
 * that ARE present) — it still creates the lead with a warning, as before.
 */
function describeIntakeRejection(extracted, minAcres) {
  if (extracted.availabilityFlags && extracted.availabilityFlags.length > 0) {
    return `listing is ${extracted.availabilityFlags[0]}`;
  }
  // Same order as lib/filter.js: hard-impossible values first, then the
  // acreage floor, then the $/acre range — so a real small lot is told it is
  // below the minimum rather than "implausible".
  const hard = checkHardPlausibility({ price: extracted.price, acres: extracted.acres });
  if (!hard.ok) {
    return `Implausible data: ${hard.problems.join('; ')}`;
  }
  if (extracted.acres != null && extracted.acres < minAcres) {
    return `${extracted.acres} acres is below the ${minAcres}-acre minimum`;
  }
  const perAcre = checkPricePerAcrePlausibility({ price: extracted.price, acres: extracted.acres });
  if (!perAcre.ok) {
    return `Implausible data: ${perAcre.problems.join('; ')}`;
  }
  return null;
}

function cleanTitle(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s+/g, ' ').trim().split(/\s+[|–—-]\s+(?=[A-Z])/)[0].trim();
  return cleaned.slice(0, 120) || null;
}

/**
 * County name compared the way airtable.getCountyRecordId does ("Le Flore" ==
 * "Leflore"), plus the Saint spellings ("St. Clair" == "Saint Clair",
 * "Ste. Genevieve" == "Sainte Genevieve").
 */
function countyKey(county) {
  return normalizeCounty(String(county || ''))
    .replace(/^ste\b/, 'sainte')
    .replace(/^st\b/, 'saint')
    .replace(/\s+/g, '');
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

  const decodedUrl = decodeURIComponent(url).toLowerCase();
  const urlSlug = decodedUrl.replace(/[_-]+/g, ' ');
  // Standalone tokens from the raw URL, for a SAFE 2-letter state check: only
  // a hyphen/slash/dot-delimited "mo" counts, never "mo" buried in a word.
  const urlTokens = new Set(decodedUrl.split(/[^a-z]+/).filter(Boolean));
  const haystackText = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `;

  // URL slug is the strongest signal ("pittsburg county oklahoma").
  const urlCandidates = counties.filter(
    ({ county }) => urlSlug.includes(`${county.toLowerCase()} county`)
  );
  const urlPick = pickCounty(urlCandidates, {
    fullStateMatch: state => urlSlug.includes(stateFullName(state).toLowerCase()),
    abbrevMatch: state => urlTokens.has(state.toLowerCase()),
  });
  if (urlPick) return urlPick;

  // Page-text fallback ("Wayne County, MO").
  const textCandidates = counties.filter(
    ({ county }) => haystackText.includes(`${county.toLowerCase()} county`)
  );
  const textPick = pickCounty(textCandidates, {
    fullStateMatch: state => haystackText.includes(stateFullName(state).toLowerCase()),
    // Comma-anchored only ("wayne county, mo") — never a bare padded " mo ".
    abbrevMatch: (state, county) =>
      haystackText.includes(`${county.toLowerCase()} county, ${state.toLowerCase()}`),
  });
  if (textPick) return textPick;

  return { county: null, state: null };
}

/**
 * Resolve a set of same-named county candidates to a single {county, state}.
 * One candidate wins outright. Multiple (e.g. Wayne|KY and Wayne|MO both in
 * the County table) must be disambiguated by an explicit state signal: full
 * state name first, then a safe abbreviation form. Still ambiguous → null, so
 * the caller leaves county unset and intake flags it for manual fill-in.
 */
function pickCounty(candidates, { fullStateMatch, abbrevMatch }) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { county: candidates[0].county, state: candidates[0].state };
  }
  const byFullName = candidates.filter(c => fullStateMatch(c.state));
  if (byFullName.length === 1) {
    return { county: byFullName[0].county, state: byFullName[0].state };
  }
  const byAbbrev = candidates.filter(c => abbrevMatch(c.state, c.county));
  if (byAbbrev.length === 1) {
    return { county: byAbbrev[0].county, state: byAbbrev[0].state };
  }
  return null;
}


function buildNotes(extracted, submitterNote, submitter) {
  const lines = ['Submitted via Listing Intake form.'];
  if (submitterNote) lines.push(`${submitter}'s note: ${String(submitterNote).trim()}`);
  if (extracted.description) lines.push('', extracted.description);

  // No availability-flag warning here: describeIntakeRejection already
  // rejects (never creates the lead) whenever extracted.availabilityFlags is
  // non-empty, so by the time buildNotes runs it's always empty.

  const gaps = [];
  if (!extracted.price) gaps.push('price');
  if (!extracted.acres) gaps.push('acres');
  if (!extracted.county) gaps.push('county');
  if (gaps.length > 0) {
    lines.push('', `⚠️ Could not extract from the page: ${gaps.join(', ')} — please fill in manually.`);
  }
  if (extracted.countyNote) {
    lines.push(`⚠️ County left blank: ${extracted.countyNote}.`);
  }
  if (extracted.statusNote) {
    lines.push(`⚠️ ${extracted.statusNote}.`);
  }
  return lines.join('\n');
}

function describeCreated(extracted) {
  const parts = [];
  parts.push(extracted.price ? `$${extracted.price.toLocaleString()}` : 'price unknown');
  parts.push(extracted.acres ? `${extracted.acres} acres` : 'acres unknown');
  if (extracted.county) parts.push(`${extracted.county} County, ${extracted.state}`);
  // No availability-flag warning here: describeIntakeRejection already
  // rejects (never creates the lead) whenever extracted.availabilityFlags is
  // non-empty, so by the time describeCreated runs it's always empty.
  const summary = `Created New Lead from submitted URL: ${parts.join(', ')}.`;
  return extracted.statusNote ? `${summary} ${extracted.statusNote}.` : summary;
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

module.exports = {
  processIntakeQueue,
  extractListingDetails,
  extractAcres,
  extractCountyState,
  cleanTitle,
  describeIntakeRejection,
  STATUS_UNKNOWN_NOTE,
};
