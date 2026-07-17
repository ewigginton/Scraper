'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const settings = require('../config/settings.json');
const airtable = require('./airtable');
const { getCPATarget } = require('./filter');
const { extractPriceFromStructuredData } = require('./price-extractor');

/**
 * Price drop checker.
 *
 * Visits each "Watch For Price Drop" listing's URL, extracts the current price,
 * and takes action based on whether the price has changed.
 */
async function runPriceCheck(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const startTime = Date.now();
  const report = {
    checked: 0,
    priceDrops: 0,
    promoted: 0,
    expired: 0,
    removed: 0,
    unchanged: 0,
    errors: 0,
    details: [],
    dryRun,
  };

  console.log('[PriceCheck] Starting price drop check...');
  if (dryRun) {
    console.log('[PriceCheck] Dry run enabled: Airtable price-check updates will be skipped');
  }

  const { FIELDS, STAGES } = airtable;

  // Fetch all "Watch For Price Drop" records. Dry-run validation should still
  // be useful on machines without Airtable secrets.
  let watchRecords;
  try {
    watchRecords = await airtable.getRecordsByStage(STAGES.watch);
  } catch (err) {
    if (!dryRun) throw err;
    report.errors++;
    report.details.push({
      action: 'skipped',
      reason: `Airtable watch-list load failed during dry run: ${err.message}`,
    });
    console.warn(`[PriceCheck] Dry run skipped watch-list load: ${err.message}`);
    report.elapsedMinutes = parseFloat(((Date.now() - startTime) / 1000 / 60).toFixed(1));
    return report;
  }
  console.log(`[PriceCheck] Found ${watchRecords.length} watched listings`);

  for (const record of watchRecords) {
    try {
      await sleep(settings.priceCheck.delayBetweenChecksMs);

      const url = record.fields[FIELDS.url];
      const storedPrice = record.fields[FIELDS.price];
      const acres = record.fields[FIELDS.acres];
      // County is a linked-record field — resolve to text county/state
      const loc = airtable.resolveCountyFields(record.fields);
      const county = loc ? loc.county : null;
      const state = loc ? loc.state : null;

      if (!url || !storedPrice) {
        report.errors++;
        continue;
      }
      if (!acres || acres <= 0) {
        // Without acreage every downstream number (tolerance, $/A) is NaN
        report.errors++;
        report.details.push({ name: record.fields.Name, action: 'skipped', reason: 'Missing Acres — cannot compute $/A' });
        continue;
      }

      report.checked++;

      // Fetch the listing page
      let currentPrice;
      let listingRemoved = false;

      try {
        const html = await fetchWithRetry(url);
        currentPrice = extractPrice(html);

        if (currentPrice === null) {
          // Could not extract price — might be a changed page structure
          report.errors++;
          await appendPriceCheckLog(record.id, 'Could not extract price — manual check needed', dryRun);
          await updateRecordSafe(record.id, { Stage: STAGES.manualCheck }, true, dryRun);
          report.details.push({ name: record.fields.Name, action: 'manual_check', reason: 'Price extraction failed' });
          continue;
        }

        // Extraction sanity check: a price wildly different from the stored
        // one is almost always a mis-parse (a $/acre figure or a page
        // redesign), not a real reprice. Never overwrite LP with it.
        if (currentPrice < storedPrice * 0.2 || currentPrice > storedPrice * 5) {
          report.errors++;
          await appendPriceCheckLog(record.id, `Extracted price $${currentPrice.toLocaleString()} is implausible vs stored $${storedPrice.toLocaleString()} — manual check needed`, dryRun);
          await updateRecordSafe(record.id, { Stage: STAGES.manualCheck }, true, dryRun);
          report.details.push({ name: record.fields.Name, action: 'manual_check', reason: 'Implausible extracted price' });
          continue;
        }
      } catch (err) {
        // Only a genuine HTTP 404/410 means the listing is gone. Matching on
        // the message text would misfire on URLs that contain "404".
        if (err.status === 404 || err.status === 410) {
          listingRemoved = true;
        } else {
          report.errors++;
          await appendPriceCheckLog(record.id, `Error: ${err.message}`, dryRun);
          continue;
        }
      }

      // Check if listing was removed
      if (listingRemoved) {
        await updateRecordSafe(record.id, { Stage: STAGES.offMarket }, true, dryRun);
        await appendPriceCheckLog(record.id, 'Listing removed (404)', dryRun);
        report.removed++;
        report.details.push({ name: record.fields.Name, action: 'removed' });
        continue;
      }

      // Compare prices
      const priceDiff = storedPrice - currentPrice;
      const tolerance = settings.priceCheck.priceToleranceDollars * acres; // $5/acre * acres
      const priceChanged = Math.abs(priceDiff) >= tolerance;
      const dropped = priceChanged && currentPrice < storedPrice;

      const target = getCPATarget(county, state);
      const newCPA = currentPrice / acres;
      const overPercent = target ? ((newCPA - target) / target) : null;
      const promotable = dropped && overPercent !== null && overPercent <= settings.filtering.newLeadThreshold;

      // Expiration (90+ days) — checked AFTER the price comparison so a
      // listing that just dropped into buy range on day 90+ is promoted, not
      // discarded as "no actionable price drop".
      if (!promotable) {
        const createdDate = record.fields[FIELDS.created] ? new Date(record.fields[FIELDS.created]) : null;
        if (createdDate) {
          const daysSinceCreated = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceCreated >= settings.priceCheck.expirationDays) {
            await updateRecordSafe(record.id, { Stage: STAGES.notInterested }, true, dryRun);
            await appendPriceCheckLog(record.id, `Expired after ${Math.round(daysSinceCreated)} days with no actionable price drop`, dryRun);
            report.expired++;
            report.details.push({ name: record.fields.Name, action: 'expired', days: Math.round(daysSinceCreated) });
            continue;
          }
        }
      }

      if (!priceChanged) {
        report.unchanged++;
        continue;
      }

      if (dropped) {
        // Price dropped
        report.priceDrops++;

        const logEntry = `Price drop: $${storedPrice.toLocaleString()} → $${currentPrice.toLocaleString()} (-$${priceDiff.toLocaleString()})`;
        await appendPriceCheckLog(record.id, logEntry, dryRun);

        // Mirror the same message the email shows into the property's notes
        // so the price-cut story is visible right on the record
        const noteDetail = target
          ? (promotable
            ? `Now $${Math.round(newCPA).toLocaleString()}/ac vs $${target.toLocaleString()}/ac target — within buy range, promoted to Price Drop.`
            : `Now $${Math.round(newCPA).toLocaleString()}/ac, still ${Math.round(overPercent * 100)}% over $${target.toLocaleString()}/ac target.`)
          : `Now $${Math.round(newCPA).toLocaleString()}/ac (no CPA target on file).`;
        await appendPropertyNote(record.id, `${promotable ? '⬆️ PRICE DROP' : 'Price drop'}: ${logEntry.replace('Price drop: ', '')}. ${noteDetail}`, dryRun);

        // Update the stored price
        const updates = {
          [FIELDS.price]: currentPrice,
        };

        if (promotable) {
          // Per Emma: promotions arrive as 'Price Drop', NOT 'New Lead' —
          // they aren't truly new leads (she already saw them when they
          // were first scraped). Only fresh scrape/intake records enter as
          // 'New Lead'. The WAITING ON YOU email section lists Price Drop
          // records so they still can't be missed.
          updates.Stage = STAGES.priceDrop;
          report.promoted++;
          report.details.push({
            name: record.fields.Name,
            action: 'promoted',
            oldPrice: storedPrice,
            newPrice: currentPrice,
            newCPA: Math.round(newCPA),
            target,
          });
          console.log(`[PriceCheck] PROMOTED: ${record.fields.Name} — $${storedPrice.toLocaleString()} → $${currentPrice.toLocaleString()} (now ${Math.round(overPercent * 100)}% over target)`);
        } else {
          report.details.push({
            name: record.fields.Name,
            action: 'price_drop',
            oldPrice: storedPrice,
            newPrice: currentPrice,
            stillOver: overPercent !== null ? `${Math.round(overPercent * 100)}%` : 'unknown',
          });
        }

        await updateRecordSafe(record.id, updates, true, dryRun);
      } else {
        // Price increased — update the stored price (no stage change) so the
        // same increase isn't re-logged every night
        const logEntry = `Price increase: $${storedPrice.toLocaleString()} → $${currentPrice.toLocaleString()} (+$${(currentPrice - storedPrice).toLocaleString()})`;
        await appendPriceCheckLog(record.id, logEntry, dryRun);
        await updateRecordSafe(record.id, {
          [FIELDS.price]: currentPrice,
        }, true, dryRun);
        report.unchanged++; // count increases as unchanged for reporting
      }

    } catch (err) {
      report.errors++;
      console.error(`[PriceCheck] Error checking ${record.fields.Name}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`[PriceCheck] Done in ${elapsed} minutes: ${report.checked} checked, ${report.priceDrops} drops, ${report.promoted} promoted, ${report.expired} expired, ${report.removed} removed`);

  report.elapsedMinutes = parseFloat(elapsed);
  return report;
}

/**
 * Extract price from a listing detail page.
 * Tries multiple common patterns across CoStar sites.
 */
function extractPrice(html) {
  const $ = cheerio.load(html);

  // Try structured data first (JSON-LD)
  const jsonLdScripts = $('script[type="application/ld+json"]').toArray();
  for (const script of jsonLdScripts) {
    const jsonLd = $(script).text();
    if (!jsonLd) continue;
    try {
      const data = JSON.parse(jsonLd);
      const price = extractPriceFromStructuredData(data);
      if (price !== null) return price;
    } catch (_) {}
  }

  // Try common price selectors
  const selectors = [
    '.property-price', '.listing-price', '.price',
    '[data-testid="price"]', '.detail-price', 'h1 + .price',
    '[itemprop="price"]',
  ];

  for (const sel of selectors) {
    const text = $(sel).first().text();
    const num = parsePriceText(text);
    if (num !== null) return num;
  }

  return null;
}

/**
 * Parse a displayed price string into a total-price number.
 * Rejects per-acre figures ("$3,500/acre") and price ranges
 * ("$100,000 - $150,000") — stripping non-digits from those produces a
 * number that looks valid but is wrong.
 */
function parsePriceText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();

  // Per-acre price, not a total price
  if (/\/\s*(acre|ac)\b/i.test(trimmed) || /per\s+acre/i.test(trimmed)) return null;

  // Ranges: "$100,000 - $150,000", "$100,000–$150,000", "$100,000 to $150,000"
  const amounts = trimmed.match(/\$?\s*\d[\d,]*(?:\.\d+)?/g) || [];
  if (amounts.length > 1) return null;

  const cleaned = trimmed.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return num > 1000 ? num : null; // Sanity check — land prices > $1000
}

const AUTO_ANALYSIS_MARKER = '--- AUTO ANALYSIS ---';

/**
 * Mirror a price-cut message into the record's Scraper Notes so the story
 * is visible on the property itself, not just in the email. The entry is
 * inserted ABOVE the AUTO ANALYSIS marker — the nightly review rewrites
 * everything below the marker, so notes placed after it would be wiped.
 */
async function appendPropertyNote(recordId, message, dryRun = false) {
  try {
    if (dryRun) {
      console.log(`[PriceCheck] DRY RUN note for ${recordId}: ${message}`);
      return;
    }
    const timestamp = new Date().toISOString().split('T')[0];
    const record = await airtable.getRecordById(recordId);
    const existing = record?.fields?.[airtable.FIELDS.notes] || '';
    const updated = mergeNoteEntry(existing, `[${timestamp}] ${message}`);
    await airtable.updateRecord(recordId, { [airtable.FIELDS.notes]: updated }, false);
  } catch (err) {
    console.error(`[PriceCheck] Failed to update note for ${recordId}: ${err.message}`);
  }
}

function mergeNoteEntry(existing, entry) {
  if (existing.includes(AUTO_ANALYSIS_MARKER)) {
    const [above, ...rest] = existing.split(AUTO_ANALYSIS_MARKER);
    return `${above.trim()}\n${entry}\n\n${AUTO_ANALYSIS_MARKER}${rest.join(AUTO_ANALYSIS_MARKER)}`.trim();
  }
  return `${existing.trim()}\n${entry}`.trim();
}

async function appendPriceCheckLog(recordId, message, dryRun = false) {
  try {
    if (dryRun) {
      console.log(`[PriceCheck] DRY RUN log for ${recordId}: ${message}`);
      return;
    }
    const timestamp = new Date().toISOString().split('T')[0];
    const record = await airtable.getRecordById(recordId);
    const existingLog = record?.fields?.[airtable.FIELDS.priceCheckLog] || '';
    const newLog = `${existingLog}\n[${timestamp}] ${message}`.trim();

    await airtable.updateRecord(recordId, { [airtable.FIELDS.priceCheckLog]: newLog }, false);
  } catch (err) {
    console.error(`[PriceCheck] Failed to update log for ${recordId}: ${err.message}`);
  }
}

async function updateRecordSafe(recordId, fields, protectStage, dryRun) {
  if (dryRun) {
    console.log(`[PriceCheck] DRY RUN update for ${recordId}: ${JSON.stringify(fields)}`);
    return { updated: false, reason: 'dry-run' };
  }
  return airtable.updateRecord(recordId, fields, protectStage);
}

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const httpErr = new Error(`HTTP ${response.status} for ${url}`);
        httpErr.status = response.status;
        throw httpErr;
      }
      return await response.text();
    } catch (err) {
      // 404/410 (listing gone) and other client errors won't change on retry
      if (typeof err.status === 'number' && err.status < 500 && err.status !== 429) throw err;
      if (attempt === 2) throw err;
      await sleep(2000 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { runPriceCheck, extractPrice, parsePriceText, mergeNoteEntry };
