/**
 * eligibility-service.ts — THE chokepoint for release/contract eligibility
 * (DESIGN.md §3 hard rule #1, spec §21, §28.3, §30.4 OPS-MV-002). Every
 * command that would release a property or activate a new contract must
 * call checkReleaseEligibility / checkContractEligibility immediately
 * before committing, and must re-run it against CURRENT database state at
 * that moment (not a cached/earlier read) — see transition-engine.ts's
 * `no_blocking_holds` / `vacancy_verified` prerequisite checkers, which
 * delegate here.
 *
 * Per DESIGN.md hard rule #1 and spec §28.3 ("The failed command shall
 * identify all blocking reasons..."), these functions NEVER throw for a
 * business blocker — they always return every blocking reason found, with
 * an owning module and a next action, so the caller (or the UI) can show
 * the whole picture at once rather than one error at a time.
 */

import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import type { DbHandle } from '../repositories/db-handle.ts';
import * as holdsRepo from '../repositories/holds-repo.ts';
import {
  approvals,
  issues,
  possessionRecords,
  vendorJobs,
  type HoldType,
} from '../db/schema.ts';

export interface EligibilityBlocker {
  /** Stable machine-readable code, e.g. 'active_hold_legal', 'possession_unresolved'. */
  code: string;
  /** Human-readable reason, safe to show directly in the UI. */
  reason: string;
  /** The module/team responsible for clearing this blocker. */
  ownerModule: string;
  /** What should happen next to clear it. */
  nextAction: string;
}

export interface EligibilityResult {
  eligible: boolean;
  blockers: EligibilityBlocker[];
}

/** Property-operations-relevant issue types that can gate release/contract. */
const RELEASE_GATING_ISSUE_TYPES = ['default_recovery', 'market_readiness', 'property_legal'] as const;

const HOLD_OWNER_MODULE: Record<HoldType, string> = {
  legal: 'Legal',
  safety: 'Property Operations',
  occupancy: 'Property Operations',
  cleanup: 'Property Operations',
  foreclosure: 'Sales/Transactions',
  title: 'Legal',
  covenant: 'Property Operations',
  stop_work: 'Management/Legal Review',
  existing_contract_active: 'Loan Services',
  other: 'Property Operations',
};

/** Possession statuses that satisfy the "vacancy/possession resolved" prerequisite. */
const POSSESSION_RESOLVED_STATUSES = new Set(['vacancy_verified', 'cleared']);

/**
 * ROUND-3 ADVERSARIAL-REVIEW FIX (P0 safety-core hole, round 2 fix was
 * incomplete): the round-2 fix enumerated only 4 of the 9 non-resolved
 * possession statuses the DB check constraint allows (schema.ts's
 * possessionStatusCheck / migration 20260731090000 line 507) as an explicit
 * "negative evidence" allowlist — `unknown`, `removal_authorized`, `stored`,
 * `transferred`, and `disposed` fell through into the old
 * `possessionRequired` issue-type short-circuit below and came back with NO
 * blocker for a property_legal-only property, even though e.g.
 * `removal_authorized` is authorization to remove personal property, not
 * removal itself (spec §29.6 line 802 lists Removal Authorized/Stored as
 * distinct from Cleared).
 *
 * Rather than enumerate a second, still-incomplete negative list, this is
 * now the exact logical inverse of POSSESSION_RESOLVED_STATUSES: ANY latest
 * possession record whose status is not vacancy_verified/cleared blocks
 * release unconditionally, regardless of which issue type(s) happen to be
 * open on the property. That makes this closed-by-construction against any
 * status added later to the check constraint — there is no third list to
 * fall out of sync. `possessionRequired`'s issue-type scoping is preserved
 * for the ONE case it was ever justified for: no possession record exists
 * at all (see that function's doc comment).
 */

async function activeHoldBlockers(tx: DbHandle, propertyRefId: string): Promise<EligibilityBlocker[]> {
  const active = await holdsRepo.activeForProperty(tx, propertyRefId);
  return active.map((hold) => ({
    code: `active_hold_${hold.holdType}`,
    reason: `Active ${hold.holdType.replace(/_/g, ' ')} hold: ${hold.reason}`,
    ownerModule: HOLD_OWNER_MODULE[hold.holdType] ?? 'Property Operations',
    nextAction:
      hold.releaseCriteria ??
      `Release the ${hold.holdType.replace(/_/g, ' ')} hold following its documented release authority.`,
  }));
}

/**
 * ADVERSARIAL-REVIEW FIX: this used to run unconditionally for EVERY
 * release-gating property, including property_legal — but property_legal's
 * own seeded transition (resolution -> released) names no
 * vacancy/possession-related prerequisite at all (its release is a legal
 * matter resolution, not a vacancy/cleanup disposition).
 *
 * FOLLOW-UP FIX (this round): the first version of this scoping fix
 * required an OPEN default_recovery/market_readiness issue to exist before
 * treating possession as required — which flipped a fail-SAFE default into
 * a fail-OPEN one: a property with NO open issue at all (e.g. queried in
 * the abstract, or between cases) came back possession-NOT-required, i.e.
 * eligible, which contradicts DESIGN.md's safety core ("no property may
 * pass release while ... unresolved possession ... exists" is a
 * property-level statement, not conditioned on an issue happening to be
 * open) and broke test/eligibility.test.ts's
 * "blocks release when possession is unresolved (no possession record at
 * all)" regression test. Correct rule: possession is required UNLESS we
 * have positive, narrow evidence it doesn't apply — i.e. every open issue
 * on the property (if any exist at all) is property_legal. No open issues
 * at all is NOT such evidence (fail closed/safe), so it still requires
 * possession.
 */
async function possessionRequired(tx: DbHandle, propertyRefId: string): Promise<boolean> {
  const openIssues = await tx
    .select({ id: issues.id, issueType: issues.issueType })
    .from(issues)
    .where(and(eq(issues.propertyRefId, propertyRefId), ne(issues.lifecycleStatus, 'closed')));
  if (openIssues.length === 0) return true;
  return !openIssues.every((issue) => issue.issueType === 'property_legal');
}

async function possessionBlocker(tx: DbHandle, propertyRefId: string): Promise<EligibilityBlocker | null> {
  const [latest] = await tx
    .select()
    .from(possessionRecords)
    .where(eq(possessionRecords.propertyRefId, propertyRefId))
    // Tiebreak on created_at/id: observed_at alone is not deterministic
    // when two records share a timestamp (adversarial-review finding).
    .orderBy(desc(possessionRecords.observedAt), desc(possessionRecords.createdAt), desc(possessionRecords.id))
    .limit(1);

  // ROUND-3 FIX: ANY positive record of a non-resolved possession status
  // ALWAYS blocks release, regardless of possessionRequired's issue-type
  // scoping below — that scoping is only a defensible skip for "no evidence
  // either way" (see possessionRequired's doc comment), never for an
  // explicit non-resolved observation, whatever its exact status string.
  // This must run BEFORE the possessionRequired short-circuit, not after.
  if (latest && !POSSESSION_RESOLVED_STATUSES.has(latest.possessionStatus)) {
    return {
      code: 'possession_unresolved',
      reason: `Possession status is "${latest.possessionStatus.replace(/_/g, ' ')}", not vacancy-verified or cleared.`,
      ownerModule: 'Property Operations',
      nextAction: 'Verify vacancy/possession and record a possession_records entry of vacancy_verified or cleared.',
    };
  }

  if (!(await possessionRequired(tx, propertyRefId))) {
    return null;
  }

  // Only reachable here when `!latest` (no possession record exists at
  // all) — any resolved or non-resolved status was already returned above.
  if (!latest) {
    return {
      code: 'possession_unresolved',
      reason: 'Possession status has never been recorded for this property.',
      ownerModule: 'Property Operations',
      nextAction: 'Verify vacancy/possession and record a possession_records entry of vacancy_verified or cleared.',
    };
  }
  return null;
}

async function cleanupNotVerifiedBlockers(tx: DbHandle, propertyRefId: string): Promise<EligibilityBlocker[]> {
  const propertyIssues = await tx.select({ id: issues.id }).from(issues).where(eq(issues.propertyRefId, propertyRefId));
  if (propertyIssues.length === 0) return [];

  const issueIds = propertyIssues.map((i) => i.id);
  const jobs = await tx.select().from(vendorJobs).where(inArray(vendorJobs.issueId, issueIds));

  // §28.3 blocks release when cleanup is "required, scheduled, underway, or
  // completed but not verified". Only 'verified' and 'cancelled' clear this
  // blocker; 'scheduled'/'in_progress'/'completed'/'disputed' all still
  // block, each with a status-specific reason (adversarial-review finding:
  // this used to filter status === 'completed' ONLY, so scheduled/
  // in_progress/disputed jobs were invisible to release eligibility).
  const BLOCKING_STATUS_REASONS: Record<string, string> = {
    scheduled: 'is scheduled but has not started',
    in_progress: 'is in progress',
    completed: 'is marked completed but has not been verified',
    disputed: 'is disputed',
  };

  return jobs
    .filter((job) => job.status in BLOCKING_STATUS_REASONS)
    .map((job) => ({
      code: 'cleanup_complete_not_verified',
      reason: `Vendor job ${job.id} ${BLOCKING_STATUS_REASONS[job.status]}.`,
      ownerModule: 'Property Operations',
      nextAction: 'Record final photo/video and a documented verification decision on the vendor job.',
    }));
}

/**
 * §10 development-price-review enforcement.
 *
 * ADVERSARIAL-REVIEW FOLLOW-UP FIX (this round): this function USED to be
 * called unconditionally from `evaluate()` for every gates_release check on
 * a property, regardless of which specific transition triggered it. That
 * made the release-track workflow structurally unreachable for
 * default_recovery: `cleanup -> relisting` and `buyer_cleanup -> relisting`
 * are both `gates_release: true` (per 20260731090600) but do NOT name
 * `price_review_complete` as a prerequisite — only `relisting -> released`
 * does, per that same migration's own comment ("price_review_complete ...
 * stays on the ONE transition that already named it"). Because this
 * function did not know which prerequisites the in-flight transition
 * actually names, it blocked `cleanup -> relisting` on a price review that
 * transition never claims to require, making it impossible to ever reach
 * `relisting` (and thus `released`) at all — reproduced by
 * test/release-gate-facts.test.ts's "same-call ctx.priceReviewedAt
 * satisfies that same call's price_review_complete prerequisite" test,
 * which failed at the FIRST gates_release hop (`cleanup -> relisting`)
 * even though that hop names no price-review prerequisite.
 *
 * Enforcement now lives SOLELY in transition-engine.ts's
 * `price_review_complete` named-prerequisite checker, which already runs
 * against current DB state before any gates_release transition commits —
 * exactly on the transition(s) that name it, and nowhere else. This
 * function is intentionally not reinstated as a second, broader copy of
 * that same check.
 */
async function openIssuePhaseBlockers(tx: DbHandle, propertyRefId: string, excludeIssueId?: string): Promise<EligibilityBlocker[]> {
  // DECISION: spec §21/§28.3 name "open blocking issue phases" without
  // defining exactly which phases block. Simplest defensible reading:
  // any release-gating issue type on this property that has not reached
  // lifecycle_status 'closed' is still "open" and blocks release/contract
  // — a narrower phase-by-phase allowlist would require encoding business
  // knowledge not present in the config-as-data (transitions has no
  // "blocks_release" flag). Documented as a known simplification.
  //
  // excludeIssueId omits the issue that is ITSELF the subject of the
  // in-flight release/contract command: its own lifecycle_status can't be
  // 'closed' yet mid-transition (that happens later, via its own
  // released -> closed step), so counting itself here would make release
  // structurally unreachable even in the fully legitimate case
  // (adversarial-review finding: eligibility was "structurally incapable
  // of returning eligible:true"). Callers checking eligibility for a
  // property in the abstract (not from inside that issue's own
  // transitionPhase call) omit excludeIssueId and get the original,
  // stricter behavior.
  const openIssues = await tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.propertyRefId, propertyRefId),
        inArray(issues.issueType, [...RELEASE_GATING_ISSUE_TYPES]),
        ne(issues.lifecycleStatus, 'closed'),
      ),
    );

  return openIssues.filter((issue) => issue.id !== excludeIssueId).map((issue) => ({
    code: 'open_issue_phase',
    reason: `Issue ${issue.id} (${issue.issueType}) is still open (lifecycle status "${issue.lifecycleStatus}").`,
    ownerModule: 'Property Operations',
    nextAction: 'Advance or close the issue through its workflow before release/contract.',
  }));
}

async function missingApprovalBlockers(tx: DbHandle, propertyRefId: string): Promise<EligibilityBlocker[]> {
  const propertyIssues = await tx.select({ id: issues.id }).from(issues).where(eq(issues.propertyRefId, propertyRefId));
  if (propertyIssues.length === 0) return [];
  const issueIds = propertyIssues.map((i) => i.id);

  // Blocks on 'pending' (awaiting a decision) AND 'rejected' (a decision
  // was made and it was NO — adversarial-review finding: the previous
  // version only checked 'pending', so a rejected release approval
  // produced zero blockers, inverting the rule). 'approved'/'withdrawn' do
  // not block.
  const unresolved = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.objectTable, 'issues'),
        inArray(approvals.objectId, issueIds),
        or(eq(approvals.decision, 'pending'), eq(approvals.decision, 'rejected')),
      ),
    );

  return unresolved.map((approval) => ({
    code: 'approval_missing',
    reason:
      approval.decision === 'rejected'
        ? `Approval was rejected: ${approval.requestedAction}${approval.decisionReason ? ` (${approval.decisionReason})` : ''}.`
        : `Pending approval required: ${approval.requestedAction}.`,
    ownerModule: 'Manager',
    nextAction:
      approval.decision === 'rejected'
        ? 'Resolve the rejection (address the reason and request approval again) before release/contract.'
        : 'Obtain the pending approval decision before release/contract.',
  }));
}

async function mapLinkBlocker(tx: DbHandle, propertyRefId: string): Promise<EligibilityBlocker | null> {
  // Property-Operations-owned fact (issues.map_link), not property_refs —
  // property_refs is a sync-owned read-through cache Property Operations
  // never writes (adversarial-review fix, 20260731090400 migration). NOT
  // excludeIssueId-filtered: the map link lives on the releasing issue
  // itself, so excluding it would defeat the check for the exact case it
  // exists to cover.
  const recoveryIssues = await tx
    .select({ id: issues.id, mapLink: issues.mapLink })
    .from(issues)
    .where(and(eq(issues.propertyRefId, propertyRefId), eq(issues.issueType, 'default_recovery'), ne(issues.lifecycleStatus, 'closed')));
  if (recoveryIssues.length === 0) return null;

  const missing = recoveryIssues.every((i) => !i.mapLink || i.mapLink.trim().length === 0);
  if (missing) {
    return {
      code: 'map_link_missing',
      reason: 'Property Recovery release requires a Google My Maps link and none is recorded.',
      ownerModule: 'Property Operations',
      nextAction: 'Paste the My Maps link on the property before release.',
    };
  }
  return null;
}

export interface CheckEligibilityOptions {
  /**
   * Omit the named issue from the "still-open gating issue" / "map link
   * missing" blockers — for use ONLY when checking eligibility from inside
   * that issue's own release transition, where its own lifecycle_status
   * necessarily isn't 'closed' yet (see openIssuePhaseBlockers doc
   * comment). External callers (e.g. a UI "can this property release"
   * check not tied to one issue's in-flight transition) should omit this.
   */
  excludeIssueId?: string;
}

async function evaluate(tx: DbHandle, propertyRefId: string, options: CheckEligibilityOptions = {}): Promise<EligibilityResult> {
  const blockers: EligibilityBlocker[] = [];

  blockers.push(...(await activeHoldBlockers(tx, propertyRefId)));
  const possession = await possessionBlocker(tx, propertyRefId);
  if (possession) blockers.push(possession);
  blockers.push(...(await cleanupNotVerifiedBlockers(tx, propertyRefId)));
  blockers.push(...(await openIssuePhaseBlockers(tx, propertyRefId, options.excludeIssueId)));
  blockers.push(...(await missingApprovalBlockers(tx, propertyRefId)));
  // price review is enforced solely by transition-engine.ts's
  // price_review_complete named prerequisite checker — see the doc comment
  // above openIssuePhaseBlockers's neighbor (formerly priceReviewBlockers)
  // for why it is not duplicated here.
  const mapLink = await mapLinkBlocker(tx, propertyRefId);
  if (mapLink) blockers.push(mapLink);

  return { eligible: blockers.length === 0, blockers };
}

/**
 * §28.3 "The failed command shall identify all blocking reasons" for
 * releasing a property (website/inventory availability, spec §10, §21,
 * §30.4). Called immediately before any release-approval command commits.
 */
export async function checkReleaseEligibility(tx: DbHandle, propertyRefId: string, options?: CheckEligibilityOptions): Promise<EligibilityResult> {
  return evaluate(tx, propertyRefId, options);
}

/**
 * §28.3 eligibility for a NEW Contract. Phase 1's schema has no Contract/
 * Voluntary-Surrender-lifecycle table (DESIGN.md §2 scope: those live in
 * Loan Services / are deferred here) — the "existing contract active" and
 * "VS not yet released" conditions are represented as the
 * `existing_contract_active` hold type and open default_recovery issue
 * phases respectively, both already covered by `evaluate`. Kept as a
 * distinct exported function (rather than an alias) so a future migration
 * that adds Contract/VS tables can extend this check independently of
 * checkReleaseEligibility without a breaking rename.
 */
export async function checkContractEligibility(tx: DbHandle, propertyRefId: string, options?: CheckEligibilityOptions): Promise<EligibilityResult> {
  return evaluate(tx, propertyRefId, options);
}
