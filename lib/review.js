'use strict';

const settings = require('../config/settings.json');
const airtable = require('./airtable');
const { getCPATarget } = require('./filter');
const { getFloodZone, parseCoordinateString, isHighRiskZone } = require('./flood');

// --- Keyword lists for listing analysis ---

const DEALBREAKERS = [
  'conservation easement', 'deed restriction', 'landlocked', 'no access',
  'no road access', 'no road frontage', 'no legal access',
  'no utilities', 'condemned', 'superfund', 'contaminated',
  'right of way only', 'mineral rights excluded', 'leased mineral',
  'cemetery', 'pipeline easement', 'high-voltage transmission',
  'eminent domain', 'landfill', 'industrial waste',
];

const YELLOW_FLAGS = [
  'flood zone', 'flood plain', 'fema flood', 'mobile home', 'manufactured home',
  'wetland', 'wetlands', 'swamp', 'marsh', 'creek bottom', 'bottom land',
  'timber lease', 'hunting lease', 'oil lease', 'gas lease',
  'seasonal road', 'unmaintained road', 'gravel road',
  'steep', 'rough terrain', 'rocky', 'mostly wooded',
  'hoa', 'homeowners association', 'deed restriction',
  'well needed', 'no well', 'no water', 'no electric', 'no power',
];

const POSITIVE_SIGNALS = [
  'paved road', 'paved frontage', 'highway frontage', 'road frontage',
  'flat', 'level', 'gently rolling', 'open pasture', 'cleared',
  'multiple frontages', 'two road frontage', 'corner lot',
  'creek', 'pond', 'lake', 'spring', 'water feature',
  'well on property', 'existing well', 'city water available',
  'electric available', 'power on property',
  'barn', 'fenced', 'cross-fenced',
  'motivated seller', 'price reduced', 'must sell',
  'timber value', 'merchantable timber',
  'recreational', 'hunting', 'deer', 'turkey', 'wildlife',
];

/**
 * Run the review analysis on all "New Lead" records.
 * Scans descriptions, flags issues, scores pricing, and writes analysis
 * to the Scraper Notes field.
 */
async function runReview() {
  const startTime = Date.now();
  const report = {
    reviewed: 0,
    standouts: [],
    flagged: [],
    autoRejected: [],
    awaiting: [],
    errors: 0,
    floodChecked: 0,
    floodHighRisk: 0,
  };

  console.log('[Review] Starting lead review...');

  const { FIELDS, STAGES } = airtable;
  const newLeads = await airtable.getRecordsByStage(STAGES.newLead);
  const priceDrop = await airtable.getRecordsByStage(STAGES.priceDrop);
  const emmaReview = await airtable.getRecordsByStage(STAGES.emmaReview);
  const allToReview = [...newLeads, ...priceDrop];

  // Everything parked in New Lead or Emma Review is waiting on a human
  // decision. Listing these with their age makes "1 new" traceable to an
  // actual Airtable record instead of looking like a phantom lead.
  report.awaiting = buildAwaitingList([...newLeads, ...emmaReview]);

  console.log(`[Review] Reviewing ${allToReview.length} leads (${newLeads.length} new, ${priceDrop.length} price drops)`);

  for (const record of allToReview) {
    try {
      const flood = await lookupFloodInfo(record, report);
      // County is a linked-record field on the Land table — resolve it to
      // text county/state once and hand it to the analyzer
      const loc = airtable.resolveCountyFields(record.fields);
      const analysis = analyzeLead(record, { flood, county: loc?.county, state: loc?.state });

      // Build the analysis text
      const analysisText = formatAnalysis(analysis);

      // Write analysis to Scraper Notes (below auto-generated marker)
      const existingNotes = record.fields[FIELDS.notes] || '';
      const marker = '--- AUTO ANALYSIS ---';
      const notesAboveMarker = existingNotes.includes(marker)
        ? existingNotes.split(marker)[0].trim()
        : existingNotes.trim();

      const updatedNotes = `${notesAboveMarker}\n\n${marker}\n${analysisText}`.trim();

      const updates = { [FIELDS.notes]: updatedNotes };

      // Flag likely dealbreakers for human review instead of rejecting automatically.
      if (analysis.dealbreakers.length > 0) {
        updates.Stage = STAGES.emmaReview;
        report.flagged.push({
          name: record.fields.Name,
          flags: analysis.dealbreakers,
        });
        console.log(`[Review] MANUAL CHECK: ${record.fields.Name} — ${analysis.dealbreakers[0]}`);
      }
      // Track standouts
      else if (analysis.score >= 3 && analysis.yellowFlags.length === 0) {
        report.standouts.push({
          name: record.fields.Name,
          county: loc?.county,
          state: loc?.state,
          price: record.fields[FIELDS.price],
          acres: record.fields[FIELDS.acres],
          cpa: airtable.parseCurrencyNumber(record.fields[FIELDS.cpaFormula]),
          positives: analysis.positives,
        });
      }
      // Track flagged
      else if (analysis.yellowFlags.length > 0) {
        report.flagged.push({
          name: record.fields.Name,
          flags: analysis.yellowFlags,
        });
      }

      await airtable.updateRecord(record.id, updates, true);
      report.reviewed++;
    } catch (err) {
      report.errors++;
      console.error(`[Review] Error reviewing ${record.fields?.Name}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`[Review] Done in ${elapsed} minutes: ${report.reviewed} reviewed, ${report.standouts.length} standouts, ${report.autoRejected.length} auto-rejected`);

  report.elapsedMinutes = parseFloat(elapsed);
  return report;
}

/**
 * Records waiting on a human decision, oldest first, with their age in days.
 * Dealbreaker records reviewed tonight move from New Lead to Emma Review —
 * dedupe by record id so they appear once.
 */
function buildAwaitingList(records) {
  const { FIELDS } = airtable;
  const seen = new Set();
  const awaiting = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const loc = airtable.resolveCountyFields(record.fields);
    const createdRaw = record.fields[FIELDS.created];
    const createdMs = createdRaw ? Date.parse(createdRaw) : NaN;
    awaiting.push({
      name: record.fields.Name || record.fields[FIELDS.propertyName] || record.id,
      county: loc?.county,
      state: loc?.state,
      price: record.fields[FIELDS.price],
      acres: record.fields[FIELDS.acres],
      stage: record.fields[FIELDS.stage],
      ageDays: Number.isFinite(createdMs) ? Math.floor((Date.now() - createdMs) / 86400000) : null,
    });
  }
  awaiting.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  return awaiting;
}

/**
 * FEMA flood-zone lookup for a lead, free via the NFHL API.
 * Only possible when the record has coordinates. Results are cached in the
 * record's own notes (the previous run's analysis line) so a lead reviewed
 * nightly doesn't re-query FEMA every night.
 */
async function lookupFloodInfo(record, report) {
  const coords = parseCoordinateString(record.fields[airtable.FIELDS.coordinates]);
  if (!coords) return null;

  // Reuse the zone from a previous run's analysis if present
  const existingNotes = record.fields[airtable.FIELDS.notes] || '';
  const cached = existingNotes.match(/FEMA Flood: Zone ([A-Z0-9]+)/);
  if (cached) {
    const zone = cached[1];
    return { zone, subtype: null, isHighRisk: isHighRiskZone(zone), mapped: zone !== 'NONE', cached: true };
  }

  await new Promise(resolve => setTimeout(resolve, 400)); // be polite to FEMA
  const flood = await getFloodZone(coords.lat, coords.lng);
  if (flood && report) {
    report.floodChecked++;
    if (flood.isHighRisk) report.floodHighRisk++;
  }
  return flood;
}

const keywordRegexCache = new Map();

/**
 * Whole-word keyword match. Plain substring matching produced false alarms
 * like "Shoal Creek" tripping the "hoa" flag.
 */
function matchesKeyword(text, keyword) {
  let regex = keywordRegexCache.get(keyword);
  if (!regex) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`\\b${escaped}\\b`, 'i');
    keywordRegexCache.set(keyword, regex);
  }
  return regex.test(text);
}

/**
 * Analyze a single lead record.
 * enrichment.flood (optional) is a lib/flood.js result — a high-risk zone
 * counts as a yellow flag and shows in the analysis text.
 */
function analyzeLead(record, enrichment = {}) {
  const fields = record.fields;

  // Keyword-scan only the text ABOVE the auto-analysis marker plus the
  // human Note field. The analysis section itself contains flag labels
  // ("fema flood", "flood zone"), so scanning full notes would re-trigger
  // flags from our own previous output every night.
  const marker = '--- AUTO ANALYSIS ---';
  const rawNotes = fields[airtable.FIELDS.notes] || '';
  const scrapedText = rawNotes.split(marker)[0];
  const humanNote = fields[airtable.FIELDS.humanNote] || '';
  const description = `${scrapedText} ${humanNote}`.toLowerCase();
  const name = (fields.Name || '').toLowerCase();
  const text = `${name} ${description}`;

  const acres = fields[airtable.FIELDS.acres] || 0;
  // $/A is a formula that renders text like "$2900" — parse it to a number
  const cpaParsed = airtable.parseCurrencyNumber(fields[airtable.FIELDS.cpaFormula]);
  const cpa = Number.isFinite(cpaParsed) ? cpaParsed : 0;
  // County on the Land table is a linked record; callers resolve it and
  // pass text county/state via enrichment
  const county = enrichment.county !== undefined ? enrichment.county : fields.County;
  const state = enrichment.state !== undefined ? enrichment.state : fields.State;
  const dom = fields[airtable.FIELDS.domFormula] || 0;

  const target = getCPATarget(county, state);
  // A missing/zero $/A must read as "unknown", not as a 100%-below-target
  // bargain that scores +2 and lands on the standout list
  const overPercent = (target && cpa > 0) ? ((cpa - target) / target) : null;

  // Scan for keywords
  const dealbreakers = DEALBREAKERS.filter(kw => matchesKeyword(text, kw));
  const yellowFlags = YELLOW_FLAGS.filter(kw => matchesKeyword(text, kw));
  const positives = POSITIVE_SIGNALS.filter(kw => matchesKeyword(text, kw));

  // FEMA flood data beats keyword guessing — a high-risk zone is a yellow
  // flag even when the listing description never mentions water
  const flood = enrichment.flood || null;
  if (flood && flood.isHighRisk && !yellowFlags.some(f => f.startsWith('fema flood zone'))) {
    yellowFlags.push(`fema flood zone ${String(flood.zone).toLowerCase()} (high risk)`);
  }

  // Score the listing (0-5)
  let score = 0;

  // Pricing score
  if (overPercent !== null) {
    if (overPercent <= -0.10) score += 2;      // 10%+ below target — excellent
    else if (overPercent <= 0) score += 1.5;    // At or below target
    else if (overPercent <= 0.10) score += 1;   // Up to 10% over
    else if (overPercent <= 0.20) score += 0.5; // 10-20% over
  }

  // Size score
  const { preferredAcresMin, preferredAcresMax, smallAcresMax } = settings.review;
  if (acres >= preferredAcresMin && acres <= preferredAcresMax) score += 1; // Sweet spot
  else if (acres >= smallAcresMax) score += 0.5;

  // Positive signals
  if (positives.length >= 3) score += 1;
  else if (positives.length >= 1) score += 0.5;

  // Yellow flag penalty
  score -= yellowFlags.length * 0.25;

  // DOM opportunity
  const domOpportunity = dom >= settings.review.domNegotiationDays && overPercent > 0;

  // Size classification
  let sizeClass;
  if (acres < smallAcresMax) sizeClass = 'small';
  else if (acres >= preferredAcresMin && acres <= preferredAcresMax) sizeClass = 'preferred';
  else if (acres > preferredAcresMax) sizeClass = 'large';
  else sizeClass = 'acceptable';

  // Price classification
  let priceClass;
  if (overPercent === null) priceClass = 'unknown';
  else if (overPercent <= -0.10) priceClass = 'excellent';
  else if (overPercent <= 0) priceClass = 'good';
  else if (overPercent <= 0.10) priceClass = 'acceptable';
  else if (overPercent <= 0.20) priceClass = 'needs_negotiation';
  else priceClass = 'over_threshold';

  return {
    score: Math.max(0, Math.min(5, score)),
    priceClass,
    sizeClass,
    overPercent,
    target,
    dealbreakers,
    yellowFlags,
    positives,
    domOpportunity,
    dom,
    flood,
  };
}

/**
 * Format analysis into human-readable text for Scraper Notes.
 */
function formatAnalysis(analysis) {
  const lines = [];
  const date = new Date().toISOString().split('T')[0];
  lines.push(`Reviewed: ${date}`);

  // Score
  const stars = '★'.repeat(Math.round(analysis.score)) + '☆'.repeat(5 - Math.round(analysis.score));
  lines.push(`Score: ${stars} (${analysis.score.toFixed(1)}/5)`);

  // Pricing
  const priceLabels = {
    excellent: '💰 EXCELLENT PRICE',
    good: '✅ Good price — at/below target',
    acceptable: '👍 Acceptable — slight negotiation room',
    needs_negotiation: '📊 Needs negotiation',
    over_threshold: '⚠️ Over threshold',
    unknown: '❓ No target data',
  };
  lines.push(`Price: ${priceLabels[analysis.priceClass]}`);
  if (analysis.overPercent !== null) {
    lines.push(`  Target: $${analysis.target}/ac | Actual: ${Math.round(analysis.overPercent * 100)}% ${analysis.overPercent <= 0 ? 'below' : 'over'}`);
  }

  // Size
  const sizeLabels = {
    preferred: '✅ Preferred range (150-400ac)',
    acceptable: 'Acceptable size',
    small: '⚠️ Small tract (<100ac)',
    large: '📏 Large tract (>400ac)',
  };
  lines.push(`Size: ${sizeLabels[analysis.sizeClass]}`);

  // DOM opportunity
  if (analysis.domOpportunity) {
    lines.push(`📅 DOM Opportunity: ${analysis.dom} days on market — seller may negotiate`);
  }

  // FEMA flood zone (line format is also the cache key for later runs —
  // keep "FEMA Flood: Zone <X>" stable)
  if (analysis.flood) {
    if (analysis.flood.isHighRisk) {
      lines.push(`🌊 FEMA Flood: Zone ${analysis.flood.zone} — HIGH RISK (1%-annual-chance floodplain)`);
    } else if (analysis.flood.mapped) {
      lines.push(`FEMA Flood: Zone ${analysis.flood.zone} — moderate/minimal hazard`);
    } else {
      lines.push(`FEMA Flood: Zone NONE — not in a mapped flood hazard zone`);
    }
  }

  // Dealbreakers
  if (analysis.dealbreakers.length > 0) {
    lines.push(`\n🚫 DEALBREAKERS:`);
    for (const db of analysis.dealbreakers) lines.push(`  - ${db}`);
  }

  // Yellow flags
  if (analysis.yellowFlags.length > 0) {
    lines.push(`\n⚠️ Yellow Flags:`);
    for (const flag of analysis.yellowFlags) lines.push(`  - ${flag}`);
  }

  // Positives
  if (analysis.positives.length > 0) {
    lines.push(`\n✅ Positives:`);
    for (const pos of analysis.positives) lines.push(`  + ${pos}`);
  }

  return lines.join('\n');
}

module.exports = { runReview, analyzeLead, matchesKeyword };
