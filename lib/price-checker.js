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

  // Fetch all "Watch For Price Drop" records
  const watchRecords = await airtable.getRecordsByStage('Watch For Price Drop');
  console.log(`[PriceCheck] Found ${watchRecords.length} watched listings`);

  for (const record of watchRecords) {
    try {
      await sleep(settings.priceCheck.delayBetweenChecksMs);

      const url = record.fields['Listing URL'];
      const storedPrice = record.fields['LP'];
      const acres = record.fields['Acres'];
      const county = record.fields['County'];
      const state = record.fields['State'];

      if (!url || !storedPrice) {
        report.errors++;
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
          await updateRecordSafe(record.id, { Stage: 'Manual Check' }, true, dryRun);
          report.details.push({ name: record.fields.Name, action: 'manual_check', reason: 'Price extraction failed' });
          continue;
        }
      } catch (err) {
        if (err.message.includes('404') || err.message.includes('410')) {
          listingRemoved = true;
        } else {
          report.errors++;
          await appendPriceCheckLog(record.id, `Error: ${err.message}`, dryRun);
          continue;
        }
      }

      // Check if listing was removed
      if (listingRemoved) {
        await updateRecordSafe(record.id, { Stage: 'Not Interested' }, true, dryRun);
        await appendPriceCheckLog(record.id, 'Listing removed (404)', dryRun);
        report.removed++;
        report.details.push({ name: record.fields.Name, action: 'removed' });
        continue;
      }

      // Check for expiration (90+ days with no change)
      const createdDate = record.fields['Created'] ? new Date(record.fields['Created']) : null;
      if (createdDate) {
        const daysSinceCreated = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreated >= settings.priceCheck.expirationDays) {
          await updateRecordSafe(record.id, { Stage: 'Not Interested' }, true, dryRun);
          await appendPriceCheckLog(record.id, `Expired after ${Math.round(daysSinceCreated)} days with no actionable price drop`, dryRun);
          report.expired++;
          report.details.push({ name: record.fields.Name, action: 'expired', days: Math.round(daysSinceCreated) });
          continue;
        }
      }

      // Compare prices
      const priceDiff = storedPrice - currentPrice;
      const tolerance = settings.priceCheck.priceToleranceDollars * acres; // $5/acre * acres

      if (Math.abs(priceDiff) < tolerance) {
        report.unchanged++;
        continue;
      }

      if (currentPrice < storedPrice) {
        // Price dropped
        report.priceDrops++;
        const newCPA = currentPrice / acres;
        const target = getCPATarget(county, state);
        const overPercent = target ? ((newCPA - target) / target) : null;

        const logEntry = `Price drop: $${storedPrice.toLocaleString()} → $${currentPrice.toLocaleString()} (-$${priceDiff.toLocaleString()})`;
        await appendPriceCheckLog(record.id, logEntry, dryRun);

        // Update the stored price
        const updates = {
          'LP': currentPrice,
          '$/A': Math.round(newCPA * 100) / 100,
        };

        // Check if it's now within the "New Lead" threshold
        if (overPercent !== null && overPercent <= settings.filtering.newLeadThreshold) {
          updates.Stage = 'Price Drop';
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
        // Price increased — log but don't change stage
        const logEntry = `Price increase: $${storedPrice.toLocaleString()} → $${currentPrice.toLocaleString()} (+$${(currentPrice - storedPrice).toLocaleString()})`;
        await appendPriceCheckLog(record.id, logEntry, dryRun);
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
    if (text) {
      const cleaned = text.replace(/[^0-9.]/g, '');
      const num = parseFloat(cleaned);
      if (num > 1000) return num; // Sanity check — land prices > $1000
    }
  }

  return null;
}

async function appendPriceCheckLog(recordId, message, dryRun = false) {
  try {
    if (dryRun) {
      console.log(`[PriceCheck] DRY RUN log for ${recordId}: ${message}`);
      return;
    }
    const timestamp = new Date().toISOString().split('T')[0];
    const record = await airtable.getRecordById(recordId);
    const existingLog = record?.fields?.['Price Check Log'] || '';
    const newLog = `${existingLog}\n[${timestamp}] ${message}`.trim();

    await airtable.updateRecord(recordId, { 'Price Check Log': newLog }, false);
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
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 404 || response.status === 410) {
        throw new Error(`${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('410')) throw err;
      if (attempt === 2) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { runPriceCheck, extractPrice };
