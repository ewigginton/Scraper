'use strict';

const settings = require('../config/settings.json');
const airtable = require('./airtable');
const { getCPATarget } = require('./filter');

// --- Keyword lists for listing analysis ---

const DEALBREAKERS = [
  'conservation easement', 'deed restriction', 'landlocked', 'no access',
  'no road', 'no utilities', 'condemned', 'superfund', 'contaminated',
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
 * to the Property Notes field.
 */
async function runReview() {
  const startTime = Date.now();
  const report = {
    reviewed: 0,
    standouts: [],
    flagged: [],
    autoRejected: [],
    errors: 0,
  };

  console.log('[Review] Starting lead review...');

  const newLeads = await airtable.getRecordsByStage('New Lead');
  const priceDrop = await airtable.getRecordsByStage('Price Drop');
  const allToReview = [...newLeads, ...priceDrop];

  console.log(`[Review] Reviewing ${allToReview.length} leads (${newLeads.length} new, ${priceDrop.length} price drops)`);

  for (const record of allToReview) {
    try {
      const analysis = analyzeLead(record);
      report.reviewed++;

      // Build the analysis text
      const analysisText = formatAnalysis(analysis);

      // Write analysis to Property Notes (below auto-generated marker)
      const existingNotes = record.fields['Property Notes'] || '';
      const marker = '--- AUTO ANALYSIS ---';
      const notesAboveMarker = existingNotes.includes(marker)
        ? existingNotes.split(marker)[0].trim()
        : existingNotes.trim();

      const updatedNotes = `${notesAboveMarker}\n\n${marker}\n${analysisText}`.trim();

      const updates = { 'Property Notes': updatedNotes };

      // Flag likely dealbreakers for human review instead of rejecting automatically.
      if (analysis.dealbreakers.length > 0) {
        updates.Stage = 'Manual Check';
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
          county: record.fields.County,
          state: record.fields.State,
          price: record.fields.LP,
          acres: record.fields.Acres,
          cpa: record.fields['$/A'],
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
 * Analyze a single lead record.
 */
function analyzeLead(record) {
  const fields = record.fields;
  const description = (fields['Property Notes'] || '').toLowerCase();
  const name = (fields.Name || '').toLowerCase();
  const text = `${name} ${description}`;

  const acres = fields.Acres || 0;
  const cpa = fields['$/A'] || 0;
  const county = fields.County;
  const state = fields.State;
  const dom = fields['Days On The Market'] || 0;

  const target = getCPATarget(county, state);
  const overPercent = target ? ((cpa - target) / target) : null;

  // Scan for keywords
  const dealbreakers = DEALBREAKERS.filter(kw => text.includes(kw));
  const yellowFlags = YELLOW_FLAGS.filter(kw => text.includes(kw));
  const positives = POSITIVE_SIGNALS.filter(kw => text.includes(kw));

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
  };
}

/**
 * Format analysis into human-readable text for Property Notes.
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

module.exports = { runReview, analyzeLead };
