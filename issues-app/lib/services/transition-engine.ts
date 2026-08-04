/**
 * transition-engine.ts — the data-driven workflow engine (spec §21,
 * DESIGN.md §6). Transition definitions are config-as-data, loaded from
 * config_entries('phase_1_defaults','transitions') seeded by
 * supabase/migrations/20260731090300_issues_seed_config.sql.
 *
 * DECISION: the seeded transition definitions carry `from_phase`,
 * `to_phase`, `prerequisites`, and `description` only — DESIGN.md §6
 * describes a richer shape (required role, tasks created/closed, holds
 * added/released, approvals) but that shape is not what the already-landed
 * seed migration encodes, and adding those fields requires a new migration
 * (outside this lane's assigned paths: lib/services/ and test/ only). So:
 *   - Required role is enforced against a fixed default set
 *     (coordinator/manager/admin — the same set the RLS "case table" write
 *     policies use) unless a transition definition carries an optional
 *     `required_role`/`required_roles` field, which this engine honors if
 *     present (forward-compatible with a future migration adding it).
 *   - Tasks-to-close/create and holds-to-apply/release are supplied by the
 *     CALLER via `TransitionCtx` rather than read from config, since the
 *     config doesn't carry them. transitionPhase still executes them
 *     atomically in the same transaction as the phase change, audit, and
 *     event publish, which is the actual safety property DESIGN.md §6
 *     cares about.
 *
 * Prerequisite checkers: implemented as named functions in
 * PREREQUISITE_CHECKERS below. The four safety-critical ones named in this
 * lane's task brief (no_blocking_holds, map_link_present, vacancy_verified,
 * two_complete_bids_if_over_threshold) enforce real current DB state.
 * Several more directly-derivable-from-schema ones are also implemented
 * for real (summary_present, people_linked, owner_identified,
 * cleanup_verified). Prerequisite names that appear in the seeded config
 * but depend on business data NOT modeled in the Phase-1 schema (Voluntary
 * Surrender lifecycle, covenant notice/cure tracking, vendor/contract
 * approval flags — all explicitly deferred per DESIGN.md §2) are
 * registered as documented pass-through stubs so the full seeded workflow
 * is at least executable; a genuinely UNKNOWN prerequisite name (typo, or
 * a future config addition with no matching code) fails the transition
 * loudly rather than silently passing, per DESIGN.md hard rule that a
 * failed/unimplemented prerequisite is never silently bypassed.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbHandle } from '../repositories/db-handle.ts';
import * as holdsRepo from '../repositories/holds-repo.ts';
import * as configRepo from '../repositories/config-repo.ts';
import { checkReleaseEligibility } from './eligibility-service.ts';
import { setActorContext } from '../db/actor-context.ts';
import { writeAudit } from './audit.ts';
import { publishDomainEvent } from './events.ts';
import {
  bids,
  holds,
  issuePeople,
  issues,
  phaseInstances,
  possessionRecords,
  tasks,
  vendorJobs,
  type Hold,
  type Issue,
  type NewHold,
  type NewTask,
  type PhaseInstance,
  type Task,
} from '../db/schema.ts';

export class TransitionError extends Error {
  code: string;
  reasons: string[];
  constructor(code: string, message: string, reasons: string[] = []) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
    this.reasons = reasons;
  }
}

export interface TransitionDefinition {
  from_phase: string;
  to_phase: string;
  prerequisites?: string[];
  description?: string;
  required_role?: string;
  required_roles?: string[];
  /**
   * When true, transitionPhase calls checkReleaseEligibility (the single
   * chokepoint, DESIGN.md hard rule #1) against the SAME tx immediately
   * before committing this transition, and blocks it with
   * TransitionError('not_eligible', ...) if not eligible. Config-declared
   * (seeded in supabase/migrations/20260731090600_issues_config_v2_transitions.sql)
   * rather than hardcoded phase names in code, per the adversarial-review
   * fix for the release path never consulting eligibility-service at all.
   */
  gates_release?: boolean;
}

export interface TransitionCtx {
  /** Roles the acting user currently holds; rechecked server-side regardless of what the UI offered. */
  roles: string[];
  actorId?: string | null;
  /** Hub staff identity (lib/auth/current-user.ts CurrentUser.id) — recorded on audit_events.actor_external_id. */
  actorExternalId?: string | null;
  actorRole?: string | null;
  reason?: string | null;
  correlationId?: string | null;
  entryReason?: string | null;
  exitOutcome?: string | null;
  handoffSummary?: string | null;
  handoffNextTask?: string | null;
  handoffDueDate?: string | null;
  /** New owner/queue for the phase being entered; defaults to carrying forward the issue's current coordinator/queue. */
  phaseOwnerId?: string | null;
  phaseQueue?: string | null;
  /** If provided, overrides the issue's lifecycle_status after the transition. */
  newLifecycleStatus?: Issue['lifecycleStatus'];
  /** Task ids to close (status -> 'completed') as part of this transition. */
  tasksToCloseIds?: string[];
  /** New tasks to open as part of this transition (issueId/phaseInstanceId are filled in automatically). */
  tasksToCreate?: Array<Omit<NewTask, 'issueId' | 'phaseInstanceId'>>;
  /** New holds to apply as part of this transition (propertyRefId/issueId are filled in automatically). */
  holdsToApply?: Array<Omit<NewHold, 'propertyRefId' | 'issueId'>>;
  /** Hold ids to release as part of this transition. */
  holdsToReleaseIds?: string[];
  holdReleaseReason?: string;
  holdReleasedBy?: string;
  /**
   * Records issues.price_reviewed_at as part of this transition (spec §10).
   * Pass when the transition itself represents "we just reviewed the
   * development price" — the price_review_complete prerequisite/blocker
   * reads this column back against thresholds.price_review_window_months.
   */
  priceReviewedAt?: string | Date;
}

export interface TransitionResult {
  issue: Issue;
  previousPhase: PhaseInstance;
  newPhase: PhaseInstance;
  closedTasks: Task[];
  createdTasks: Task[];
  appliedHolds: Hold[];
  releasedHolds: Hold[];
}

const DEFAULT_TRANSITION_ROLES = ['coordinator', 'manager', 'admin'];

type PrerequisiteChecker = (
  tx: DbHandle,
  issue: Issue,
  ctx: TransitionCtx,
) => Promise<{ ok: boolean; detail?: string }>;

async function summaryPresent(_tx: DbHandle, issue: Issue): Promise<{ ok: boolean }> {
  return { ok: Boolean(issue.summary && issue.summary.trim().length > 0) };
}

async function peopleLinked(tx: DbHandle, issue: Issue): Promise<{ ok: boolean }> {
  const rows = await tx.select({ id: issuePeople.id }).from(issuePeople).where(eq(issuePeople.issueId, issue.id));
  return { ok: rows.length > 0 };
}

async function ownerIdentified(tx: DbHandle, issue: Issue): Promise<{ ok: boolean }> {
  const rows = await tx
    .select({ id: issuePeople.id })
    .from(issuePeople)
    .where(and(eq(issuePeople.issueId, issue.id), eq(issuePeople.role, 'owner')));
  return { ok: rows.length > 0 };
}

async function mapLinkPresent(_tx: DbHandle, issue: Issue): Promise<{ ok: boolean }> {
  // Property-Operations-owned fact (issues.map_link), not property_refs —
  // property_refs is a sync-owned read-through cache Property Operations
  // never writes (adversarial-review fix, 20260731090400 migration).
  return { ok: Boolean(issue.mapLink && issue.mapLink.trim().length > 0) };
}

async function noBlockingHolds(tx: DbHandle, issue: Issue): Promise<{ ok: boolean; detail?: string }> {
  const active = await holdsRepo.activeForProperty(tx, issue.propertyRefId);
  return { ok: active.length === 0, detail: active.length > 0 ? active.map((h) => h.holdType).join(', ') : undefined };
}

async function vacancyVerified(tx: DbHandle, issue: Issue): Promise<{ ok: boolean; detail?: string }> {
  // Tiebreak on created_at then id: observed_at alone is not deterministic
  // when two records land in the same statement/transaction and share a
  // timestamp (adversarial-review finding).
  const [latest] = await tx
    .select()
    .from(possessionRecords)
    .where(eq(possessionRecords.propertyRefId, issue.propertyRefId))
    .orderBy(desc(possessionRecords.observedAt), desc(possessionRecords.createdAt), desc(possessionRecords.id))
    .limit(1);
  const ok = latest !== undefined && (latest.possessionStatus === 'vacancy_verified' || latest.possessionStatus === 'cleared');
  return { ok, detail: latest ? latest.possessionStatus : 'no possession record' };
}

/**
 * §10: development price must be reviewed within thresholds.
 * price_review_window_months. Reads issues.price_reviewed_at (a
 * Property-Operations-owned fact — see 20260731090400 migration), set by
 * TransitionCtx.priceReviewedAt on whichever transition represents "we
 * just reviewed the price". Real checker replacing the previous
 * `price_review_complete` pass-through stub (adversarial-review finding).
 */
async function priceReviewComplete(tx: DbHandle, issue: Issue): Promise<{ ok: boolean; detail?: string }> {
  if (!issue.priceReviewedAt) {
    return { ok: false, detail: 'no price review has ever been recorded' };
  }
  const thresholds = await configRepo.get<Record<string, unknown>>(tx, 'phase_1_defaults', 'thresholds');
  const windowMonths = typeof thresholds?.price_review_window_months === 'number' ? thresholds.price_review_window_months : 6;
  const deadline = new Date(issue.priceReviewedAt);
  deadline.setUTCMonth(deadline.getUTCMonth() + windowMonths);
  const ok = deadline.getTime() >= Date.now();
  return {
    ok,
    detail: ok ? undefined : `last price review was ${issue.priceReviewedAt.toISOString()}, outside the ${windowMonths}-month window`,
  };
}

async function cleanupVerified(tx: DbHandle, issue: Issue): Promise<{ ok: boolean; detail?: string }> {
  const jobs = await tx.select().from(vendorJobs).where(eq(vendorJobs.issueId, issue.id));
  if (jobs.length === 0) {
    // No vendor job at all: not this engine's job to decide whether cleanup
    // was required in the first place (that is a case decision recorded
    // elsewhere); treat "nothing to verify" as satisfied.
    return { ok: true };
  }
  const ok = jobs.every((job) => job.status === 'verified' || job.status === 'cancelled');
  return { ok, detail: jobs.map((j) => `${j.id}:${j.status}`).join(', ') };
}

async function twoCompleteBidsIfOverThreshold(tx: DbHandle, issue: Issue): Promise<{ ok: boolean; detail?: string }> {
  const thresholds = await configRepo.get<Record<string, unknown>>(tx, 'phase_1_defaults', 'thresholds');
  const thresholdUsd = typeof thresholds?.second_bid_threshold_usd === 'number' ? thresholds.second_bid_threshold_usd : 1500;

  const issueBids = await tx.select().from(bids).where(eq(bids.issueId, issue.id));
  if (issueBids.length === 0) {
    return { ok: true };
  }

  const maxAmountCents = issueBids.reduce((max, bid) => Math.max(max, bid.amountCents), 0);
  const overThreshold = maxAmountCents >= thresholdUsd * 100;
  if (!overThreshold) {
    return { ok: true };
  }

  const completeOrBetter = issueBids.filter((bid) => bid.status === 'complete' || bid.status === 'accepted');
  return {
    ok: completeOrBetter.length >= 2,
    detail: `top bid $${(maxAmountCents / 100).toFixed(2)} is at/above the $${thresholdUsd} second-bid threshold; ${completeOrBetter.length} complete bid(s) on file`,
  };
}

/**
 * ADVERSARIAL-REVIEW FIX: this package used to register ~20 prerequisite
 * names (Voluntary Surrender lifecycle, legal-status tracking, covenant
 * notice/cure tracking, vendor contract/approval flags — all deferred per
 * DESIGN.md §2) as pass-through stubs returning `{ ok: true }` unconditionally,
 * so most seeded transitions enforced nothing while claiming to. There is
 * NO stub registration anymore: every prerequisite name below is a real,
 * schema-backed checker. A prerequisite name that has no checker here fails
 * the transition loudly via the 'unimplemented_prerequisite' error below
 * (transitionPhase) rather than silently passing — fail closed, per
 * DESIGN.md's hard rule that a failed/unimplemented prerequisite is never
 * silently bypassed. Seeded transitions that used to name an unmodeled
 * business flag have had that name stripped from config (see
 * supabase/migrations/20260731090600_issues_config_v2_transitions.sql) so
 * the seeded workflow does not throw on every attempt; that is a documented
 * simplification (role-gated only for those specific transitions), not an
 * invention of unmodeled business logic.
 */
const PREREQUISITE_CHECKERS: Record<string, PrerequisiteChecker> = {
  summary_present: summaryPresent,
  people_linked: peopleLinked,
  owner_identified: ownerIdentified,
  map_link_present: mapLinkPresent,
  no_blocking_holds: noBlockingHolds,
  vacancy_verified: vacancyVerified,
  cleanup_verified: cleanupVerified,
  two_complete_bids_if_over_threshold: twoCompleteBidsIfOverThreshold,
  price_review_complete: priceReviewComplete,
};

/**
 * Names transitionPhase can resolve to a real checker right now. Exported
 * ONLY so test-time config validation (test/transition.test.ts) can assert
 * every prerequisite name in every seeded config_versions row actually
 * resolves, catching a typo'd or newly-added prerequisite name in a future
 * migration before it fails closed at runtime on whichever transition first
 * exercises it (adversarial-review follow-up: nothing previously verified
 * seed-config/checker-registry agreement outside of exercising each
 * transition one at a time).
 */
export const IMPLEMENTED_PREREQUISITE_NAMES: ReadonlySet<string> = new Set(Object.keys(PREREQUISITE_CHECKERS));

/**
 * `no_blocking_holds` above already delegates to holds-repo directly (it
 * needs only the boolean), but exported here too so callers that want the
 * full blocker detail (e.g. an "explain why this is blocked" UI action) can
 * use the same chokepoint eligibility-service exposes, per DESIGN.md hard
 * rule #1 (one place evaluates release blocking).
 */
export async function explainBlockingHolds(tx: DbHandle, propertyRefId: string) {
  return checkReleaseEligibility(tx, propertyRefId);
}

async function loadTransitionDefinitions(tx: DbHandle, issueType: string): Promise<TransitionDefinition[]> {
  const allTransitions = await configRepo.get<Record<string, TransitionDefinition[]>>(tx, 'phase_1_defaults', 'transitions');
  return allTransitions?.[issueType] ?? [];
}

/**
 * Record a DENIAL audit row for a rejected transition attempt (spec §29.2 —
 * the denied attempt and its blockers are "exactly the legally interesting
 * event"). Called with `auditDb`, NOT `tx`, so the row survives even though
 * the caller is about to roll back the transaction that held `tx`.
 *
 * ADVERSARIAL-REVIEW FIX (P1 reliability): this used to write directly on
 * whatever handle `auditDb` was, with no actor context of its own. In
 * production, app/actions.ts's `db` (the top-level, non-transactional
 * handle it passes as auditDb) never carries actor context — a bare,
 * non-transactional `setActorContext(db, ...)` call is a guaranteed no-op
 * (set_config(..., is_local=true) is reverted the instant the statement
 * that set it completes; see lib/db/actor-context.ts). Under real RLS
 * (audit_events_insert_any_authenticated requires
 * issues_current_actor() is not null) that made every denial-audit INSERT
 * fail outright, turning a denied-but-safe transition into an unhandled
 * 500 instead of the intended blocker-list redirect (reproduced by
 * test/repro-denial-audit-rls.test.ts). Opening a dedicated, short-lived
 * transaction here — independent of both `tx` (about to roll back) and
 * whatever transaction (if any) `auditDb` itself came from — and
 * establishing actor context INSIDE it makes the denial audit
 * self-sufficient: it does not depend on the caller having already set
 * actor context on `auditDb`, and it commits on its own regardless of what
 * happens to `tx` afterward.
 */
async function recordDenial(
  auditDb: DbHandle,
  issue: Issue,
  fromPhase: string,
  toPhase: string,
  code: string,
  ctx: TransitionCtx,
  reasons: string[],
): Promise<void> {
  await auditDb.transaction(async (auditTx) => {
    await setActorContext(auditTx, {
      actorId: ctx.actorExternalId ?? ctx.actorId ?? 'system',
      roles: ctx.roles ?? [],
    });
    await writeAudit(auditTx, {
      actorId: ctx.actorId ?? null,
      actorExternalId: ctx.actorExternalId ?? null,
      actorRole: ctx.actorRole ?? null,
      action: 'phase_transition_denied',
      objectTable: 'issues',
      objectId: issue.id,
      before: { phaseKey: fromPhase },
      after: { attemptedPhaseKey: toPhase, denialCode: code, reasons },
      reason: ctx.reason ?? null,
      correlationId: ctx.correlationId ?? null,
      source: 'transition-engine.transitionPhase',
    });
  });
}

async function getCurrentPhase(tx: DbHandle, issue: Issue): Promise<PhaseInstance> {
  if (!issue.currentPhaseInstanceId) {
    throw new TransitionError('no_current_phase', `Issue ${issue.id} has no current phase instance to transition from.`);
  }
  const [phase] = await tx.select().from(phaseInstances).where(eq(phaseInstances.id, issue.currentPhaseInstanceId));
  if (!phase) {
    throw new TransitionError('no_current_phase', `Issue ${issue.id}'s current_phase_instance_id does not resolve to a row.`);
  }
  return phase;
}

/**
 * Attempt a phase transition. Validates the transition is legal for the
 * issue's type (config-driven), rechecks role permission and prerequisites
 * against CURRENT database state, then executes atomically: closes the
 * current phase_instance, opens the new one, updates issues, closes/creates
 * tasks and applies/releases holds per `ctx`, writes one audit_events row,
 * and publishes property_operations.phase_transitioned — all in `tx`.
 *
 * Throws TransitionError for any failure (unknown/disallowed transition,
 * forbidden role, unmet/unimplemented prerequisite, ineligible release) —
 * never partially applies a transition.
 *
 * `auditDb` (defaults to `tx`) is the handle used to record a DENIAL audit
 * row (forbidden / prerequisites_not_met / not_eligible) before throwing.
 * Callers that wrap this call in `db.transaction(...)` (e.g. app/actions.ts)
 * should pass the top-level `db` (NOT `tx`) here — a denial audit written
 * on `tx` would be rolled back along with the rest of the aborted
 * transaction and never persist, defeating the point of auditing a denied
 * attempt (adversarial-review finding; spec §29.2 wants the attempt and its
 * blockers recorded). Tests that call transitionPhase directly against a
 * non-transactional handle (`handle.db`) get the same handle for both by
 * default, so this is backward compatible.
 */
export async function transitionPhase(
  tx: DbHandle,
  issueId: string,
  toPhase: string,
  ctx: TransitionCtx,
  auditDb: DbHandle = tx,
): Promise<TransitionResult> {
  let [issue] = await tx.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) {
    throw new TransitionError('issue_not_found', `Issue ${issueId} not found.`);
  }

  // Per-property serialization lock (adversarial-review TOCTOU finding):
  // held for the rest of this transaction so a concurrent applyHold/
  // releaseHold/transitionPhase on the same property cannot commit a
  // conflicting change between this function's prerequisite reads and its
  // write block. hashtextextended gives a stable 64-bit lock key from the
  // property_ref_id text without a separate numeric-id scheme.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${issue.propertyRefId}::text, 0))`);

  const currentPhase = await getCurrentPhase(tx, issue);
  const definitions = await loadTransitionDefinitions(tx, issue.issueType);
  const definition = definitions.find((def) => def.from_phase === currentPhase.phaseKey && def.to_phase === toPhase);

  if (!definition) {
    const available = definitions.filter((def) => def.from_phase === currentPhase.phaseKey).map((def) => def.to_phase);
    throw new TransitionError(
      'disallowed_transition',
      `Issue ${issueId} (${issue.issueType}) cannot transition from "${currentPhase.phaseKey}" to "${toPhase}". Allowed destinations: ${
        available.length > 0 ? available.join(', ') : 'none'
      }.`,
      available,
    );
  }

  const allowedRoles = definition.required_roles ?? (definition.required_role ? [definition.required_role] : DEFAULT_TRANSITION_ROLES);
  const authorized = ctx.roles.some((role) => allowedRoles.includes(role));
  if (!authorized) {
    await recordDenial(auditDb, issue, currentPhase.phaseKey, toPhase, 'forbidden', ctx, [`requires role(s): ${allowedRoles.join(', ')}`]);
    throw new TransitionError(
      'forbidden',
      `Transitioning "${currentPhase.phaseKey}" -> "${toPhase}" requires role(s): ${allowedRoles.join(', ')}.`,
    );
  }

  // ADVERSARIAL-REVIEW FIX (release-track structurally unreachable): the
  // ONLY mechanism that can ever write issues.price_reviewed_at is
  // ctx.priceReviewedAt on THIS call, but `issue` above was fetched at
  // function entry, before this write — so a caller passing
  // ctx.priceReviewedAt to satisfy price_review_complete on this same
  // transition (e.g. relisting -> released, which both names the
  // prerequisite AND gates_release) could never actually satisfy it: the
  // prerequisite loop and the gates_release eligibility check below both
  // read/re-query current DB state, and current DB state hadn't been
  // updated yet. Applying the write here — after authorization, before any
  // prerequisite/eligibility check reads it — lets a transition legitimately
  // record "we just reviewed the price" as part of itself. Re-assigns the
  // local `issue` so the in-memory read in priceReviewComplete (which reads
  // issue.priceReviewedAt directly, not a fresh query) sees it too.
  if (ctx.priceReviewedAt) {
    const [reviewed] = await tx
      .update(issues)
      .set({ priceReviewedAt: new Date(ctx.priceReviewedAt) })
      .where(eq(issues.id, issue.id))
      .returning();
    if (reviewed) issue = reviewed;
  }

  const failedPrerequisites: string[] = [];
  for (const name of definition.prerequisites ?? []) {
    const checker = PREREQUISITE_CHECKERS[name];
    if (!checker) {
      throw new TransitionError(
        'unimplemented_prerequisite',
        `Transition "${currentPhase.phaseKey}" -> "${toPhase}" names prerequisite "${name}", which has no implemented checker.`,
      );
    }
    const result = await checker(tx, issue, ctx);
    if (!result.ok) {
      failedPrerequisites.push(result.detail ? `${name} (${result.detail})` : name);
    }
  }
  if (failedPrerequisites.length > 0) {
    await recordDenial(auditDb, issue, currentPhase.phaseKey, toPhase, 'prerequisites_not_met', ctx, failedPrerequisites);
    throw new TransitionError(
      'prerequisites_not_met',
      `Transition "${currentPhase.phaseKey}" -> "${toPhase}" blocked by unmet prerequisite(s): ${failedPrerequisites.join('; ')}.`,
      failedPrerequisites,
    );
  }

  // Release/contract eligibility gate (adversarial-review CRITICAL finding):
  // the release path used to never consult eligibility-service at all, so a
  // property could reach `released` with e.g. an unverified cleanup or an
  // active hold. Any transition config-flagged gates_release must re-check
  // checkReleaseEligibility — the single chokepoint (DESIGN.md hard rule
  // #1) — against CURRENT state on this same tx immediately before commit.
  // excludeIssueId omits THIS issue from the "still-open gating issue"
  // blocker: this issue's own lifecycle_status necessarily isn't 'closed'
  // yet mid-transition (it closes later, via its own released -> closed
  // step), so counting itself would make gates_release structurally
  // unsatisfiable even in the fully legitimate case.
  if (definition.gates_release) {
    const eligibility = await checkReleaseEligibility(tx, issue.propertyRefId, { excludeIssueId: issue.id });
    if (!eligibility.eligible) {
      const reasons = eligibility.blockers.map((b) => `${b.code} (${b.reason})`);
      await recordDenial(auditDb, issue, currentPhase.phaseKey, toPhase, 'not_eligible', ctx, reasons);
      throw new TransitionError(
        'not_eligible',
        `Transition "${currentPhase.phaseKey}" -> "${toPhase}" blocked: property is not release-eligible (${reasons.join('; ')}).`,
        reasons,
      );
    }
  }

  // ---- Execute atomically ----

  const [closedPhase] = await tx
    .update(phaseInstances)
    .set({
      status: 'completed',
      endedAt: new Date(),
      exitOutcome: ctx.exitOutcome ?? null,
      handoffSummary: ctx.handoffSummary ?? null,
      handoffNextTask: ctx.handoffNextTask ?? null,
      handoffDueDate: ctx.handoffDueDate ?? null,
    })
    .where(eq(phaseInstances.id, currentPhase.id))
    .returning();
  if (!closedPhase) {
    throw new Error('transition-engine: failed to close current phase_instance');
  }

  const [newPhase] = await tx
    .insert(phaseInstances)
    .values({
      issueId: issue.id,
      issueCycleId: currentPhase.issueCycleId,
      phaseKey: toPhase,
      ownerId: ctx.phaseOwnerId ?? issue.coordinatorId,
      queue: ctx.phaseQueue ?? issue.queue,
      status: 'open',
      startedAt: new Date(),
      entryReason: ctx.entryReason ?? null,
    })
    .returning();
  if (!newPhase) {
    throw new Error('transition-engine: failed to open new phase_instance');
  }

  const [updatedIssue] = await tx
    .update(issues)
    .set({
      currentPhaseInstanceId: newPhase.id,
      lifecycleStatus: ctx.newLifecycleStatus ?? issue.lifecycleStatus,
      // priceReviewedAt was already applied above (before the prerequisite/
      // gates_release checks ran) when ctx.priceReviewedAt was supplied;
      // `issue.priceReviewedAt` already reflects that write, so re-stating
      // it here is idempotent, not a second source of truth.
      priceReviewedAt: issue.priceReviewedAt,
    })
    .where(eq(issues.id, issue.id))
    .returning();
  if (!updatedIssue) {
    throw new Error('transition-engine: failed to update issue after transition');
  }

  const closedTasks: Task[] = [];
  for (const taskId of ctx.tasksToCloseIds ?? []) {
    const [closed] = await tx.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, taskId)).returning();
    if (closed) closedTasks.push(closed);
  }

  const createdTasks: Task[] = [];
  for (const taskInput of ctx.tasksToCreate ?? []) {
    const [created] = await tx
      .insert(tasks)
      .values({ ...taskInput, issueId: issue.id, phaseInstanceId: newPhase.id })
      .returning();
    if (created) createdTasks.push(created);
  }

  const appliedHolds: Hold[] = [];
  for (const holdInput of ctx.holdsToApply ?? []) {
    const [applied] = await tx
      .insert(holds)
      .values({ ...holdInput, propertyRefId: issue.propertyRefId, issueId: issue.id })
      .returning();
    if (applied) appliedHolds.push(applied);
  }

  const releasedHolds: Hold[] = [];
  for (const holdId of ctx.holdsToReleaseIds ?? []) {
    const released = await holdsRepo.release(tx, holdId, ctx.holdReleasedBy ?? ctx.actorId ?? 'system', ctx.holdReleaseReason ?? `Released by transition to ${toPhase}`);
    if (released) releasedHolds.push(released);
  }

  const correlationId = ctx.correlationId ?? randomUUID();

  await writeAudit(tx, {
    actorId: ctx.actorId ?? null,
    actorExternalId: ctx.actorExternalId ?? null,
    actorRole: ctx.actorRole ?? null,
    action: 'phase_transitioned',
    objectTable: 'issues',
    objectId: issue.id,
    before: { phaseKey: currentPhase.phaseKey, phaseInstanceId: currentPhase.id, lifecycleStatus: issue.lifecycleStatus },
    after: { phaseKey: newPhase.phaseKey, phaseInstanceId: newPhase.id, lifecycleStatus: updatedIssue.lifecycleStatus },
    reason: ctx.reason ?? null,
    correlationId,
    source: 'transition-engine.transitionPhase',
  });

  await publishDomainEvent(tx, {
    eventType: 'property_operations.phase_transitioned',
    payload: { issueId: issue.id, fromPhase: currentPhase.phaseKey, toPhase: newPhase.phaseKey },
    issueId: issue.id,
    propertyRefId: issue.propertyRefId,
    actor: ctx.actorId ?? null,
    correlationId,
    idempotencyKey: `phase_transitioned:${newPhase.id}`,
  });

  return {
    issue: updatedIssue,
    previousPhase: closedPhase,
    newPhase,
    closedTasks,
    createdTasks,
    appliedHolds,
    releasedHolds,
  };
}
