'use server';

/**
 * app/actions.ts — server actions backing the Phase-1 screens. Every
 * mutation goes through lib/services (never lib/repositories or the DB
 * directly), wrapped in a single db.transaction() per DESIGN.md §6 ("all
 * transitions run in one DB transaction") since the service functions take
 * a DbHandle and expect the caller to establish the transaction boundary.
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { requireDb } from './_lib/db.ts';
import { getCurrentUser } from '../lib/auth/current-user.ts';
import * as taskService from '../lib/services/task-service.ts';
import * as issueService from '../lib/services/issue-service.ts';
import * as holdService from '../lib/services/hold-service.ts';
import * as possessionService from '../lib/services/possession-service.ts';
import * as eligibilityService from '../lib/services/eligibility-service.ts';
import * as transitionEngine from '../lib/services/transition-engine.ts';
import * as savedViewService from '../lib/services/saved-view-service.ts';
import { IssueAuthorizationError } from '../lib/services/issue-authz.ts';
import { setActorContext, withActor } from '../lib/db/actor-context.ts';
import { issues, type IssuePersonRole, type IssueType, type PossessionStatus, type Priority } from '../lib/db/schema.ts';

const MIN_SUMMARY_LENGTH = 20;
const PERSON_ROW_COUNT = 4;

/**
 * ADVERSARIAL-REVIEW FIX (round 2, P1): recordPossessionAction used to cast
 * `str(formData, 'possessionStatus')` straight to `PossessionStatus` with no
 * runtime check at all — an arbitrary string from form data would sail
 * through the cast and be inserted into possession_records.possession_status
 * (a plain `text` column with a DB check constraint as the only backstop).
 * Mirrors lib/db/schema.ts's PossessionStatus type exactly; kept as a
 * runtime literal here (schema.ts's PossessionStatus is a type-only union,
 * not backed by a runtime array) so this validates before the cast rather
 * than after a DB round-trip.
 */
const KNOWN_POSSESSION_STATUSES = new Set<PossessionStatus>([
  'unknown',
  'occupied_or_suspected',
  'vacancy_unverified',
  'vacancy_verified',
  'personal_property_present',
  'removal_disposition_review',
  'removal_authorized',
  'stored',
  'transferred',
  'disposed',
  'cleared',
]);

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * ADVERSARIAL-REVIEW FIX (P2 open redirect): `returnTo` used to be read
 * straight off user-controlled form data with no validation and passed
 * unvalidated to redirect()/revalidatePath() — a hidden field an attacker
 * controls (or same-origin HTML injection) could set it to an absolute or
 * protocol-relative URL (`https://evil.example`, `//evil.example`) and this
 * server action would issue a redirect to it. The only legitimate values
 * are the hidden inputs this app itself renders (`/`, `/issues`,
 * `/issues/${id}`, and buildIssuesHref(sp)'s `/issues?...` filtered-view
 * URLs), so requiring a single leading slash (rejecting the
 * protocol-relative `//host` form, backslash variants, and absolute URLs)
 * loses nothing.
 *
 * FIX ROUND 2 (P2, still CONFIRMED bypassable): the previous version's
 * negative lookahead `(?!\/)` only inspected the ONE character immediately
 * after the leading slash, and `[^\\]*` excluded backslash but no other
 * control character — so `/\t//evil.example` (a literal ASCII TAB as the
 * second character) passed the regex outright. Node's HTTP header
 * validator permits raw U+0009 in a header value, so `Location:
 * /\t//evil.example` was emitted intact; the WHATWG URL parser then strips
 * ALL ASCII tab/newline characters before parsing, collapsing that back to
 * `///evil.example`, which resolves to a cross-origin redirect to
 * evil.example. `str()`'s `.trim()` does not strip an INTERIOR tab, only
 * leading/trailing whitespace, so the malicious character survives into
 * this check. Now excludes every C0 control character (\x00-\x1f, which
 * includes tab/CR/LF) anywhere in the string, and rejects a backslash
 * immediately after the leading slash too (not just later in the string).
 */
function safeReturnTo(formData: FormData, fallback = '/'): string {
  const v = str(formData, 'returnTo');
  // eslint-disable-next-line no-control-regex -- excluding C0 control chars is the point of this check.
  return /^\/(?![\\/])[^\\\x00-\x1f]*$/.test(v) ? v : fallback;
}

// =====================================================================
// Personal work screen — Complete / Reschedule (spec §8.1)
// =====================================================================

export async function completeTaskAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const taskId = str(formData, 'taskId');
  const returnTo = safeReturnTo(formData, '/');

  try {
    await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      // actorRoles/actorQueues come from the authenticated user's own
      // roles/queues, never from form data (requirements line 378: the
      // server independently rechecks permission) — see task-service.ts's
      // assertTaskAuthorized (IDOR fix). actorQueues is round-2's fix for
      // that same check having no production source for queue coverage —
      // see CurrentUser.queues's doc comment.
      return taskService.completeTask(tx, {
        taskId,
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
        actorRoles: user.roles,
        actorQueues: user.queues,
        correlationId: null,
      });
    });
  } catch (err) {
    if (err instanceof taskService.TaskServiceError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath('/');
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function rescheduleTaskAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const taskId = str(formData, 'taskId');
  const newDueDate = str(formData, 'newDueDate');
  const returnTo = safeReturnTo(formData, '/');

  if (!newDueDate) {
    redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent('A new due date is required to reschedule.')}`);
  }

  try {
    await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      return taskService.rescheduleTask(tx, {
        taskId,
        newDueDate,
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
        actorRoles: user.roles,
        actorQueues: user.queues,
        correlationId: null,
      });
    });
  } catch (err) {
    if (err instanceof taskService.TaskServiceError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath('/');
  revalidatePath(returnTo);
  redirect(returnTo);
}

// =====================================================================
// Case view — phase transitions (spec §21, §28.3)
// =====================================================================

export interface RenderableBlocker {
  reason: string;
  owner: string;
  nextAction: string;
}

async function buildBlockerList(
  db: ReturnType<typeof requireDb>,
  actor: { actorId: string; roles: string[] },
  propertyRefId: string,
  err: transitionEngine.TransitionError,
): Promise<RenderableBlocker[]> {
  if (err.code === 'prerequisites_not_met') {
    const blockers: RenderableBlocker[] = [];
    for (const detail of err.reasons) {
      if (detail.startsWith('no_blocking_holds')) {
        // ADVERSARIAL-REVIEW FIX (P2 reliability): this used to read on the
        // bare `db` handle with no actor context, so under a real
        // RLS-governed connection every row would be silently filtered out
        // (SELECT RLS hides rows rather than erroring) and this would report
        // "no blockers" for a genuinely blocked property. Read through
        // withActor like every other authenticated read.
        const elig = await withActor(db, actor, (tx) => eligibilityService.checkReleaseEligibility(tx, propertyRefId));
        blockers.push(...elig.blockers.map((b) => ({ reason: b.reason, owner: b.ownerModule, nextAction: b.nextAction })));
      } else {
        blockers.push({
          reason: `Unmet prerequisite: ${detail}`,
          owner: 'Property Operations',
          nextAction: `Resolve "${detail}" before retrying this transition.`,
        });
      }
    }
    return blockers.length > 0 ? blockers : [{ reason: err.message, owner: 'Property Operations', nextAction: 'Review and retry.' }];
  }

  if (err.code === 'disallowed_transition') {
    return [
      {
        reason: err.message,
        owner: 'Property Operations',
        nextAction: err.reasons.length > 0 ? `Choose one of: ${err.reasons.join(', ')}.` : 'No destination phase is configured from the current phase.',
      },
    ];
  }

  if (err.code === 'forbidden') {
    return [{ reason: err.message, owner: 'Property Operations', nextAction: 'Ask a coordinator/manager/admin to perform this transition.' }];
  }

  return [{ reason: err.message, owner: 'Property Operations', nextAction: 'Review and retry.' }];
}

export async function transitionPhaseAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const issueId = str(formData, 'issueId');
  const toPhase = str(formData, 'toPhase');
  const reason = str(formData, 'reason') || null;
  const actor = { actorId: user.id, roles: user.roles };

  // ADVERSARIAL-REVIEW FIX: this pre-flight read used to run on the bare
  // `db` handle with no actor context, so under a real RLS-governed
  // connection it always returned zero rows (issues_current_actor() is
  // null) and every transition attempt redirected with "Issue not found.",
  // regardless of whether the issue existed. Read through withActor like
  // every other authenticated read.
  const issueRow = await withActor(db, actor, async (tx) => {
    const [row] = await tx.select().from(issues).where(eq(issues.id, issueId));
    return row;
  });
  if (!issueRow) {
    redirect(`/issues/${issueId}?transitionError=${encodeURIComponent(JSON.stringify([{ reason: 'Issue not found.', owner: 'Property Operations', nextAction: 'Reload the case.' }]))}`);
  }

  try {
    await db.transaction(async (tx) => {
      await setActorContext(tx, actor);
      // `db` (NOT `tx`) is passed as the 5th arg (auditDb) so a denial
      // audit row (forbidden/prerequisites_not_met/not_eligible) survives
      // even though this transaction is about to roll back on the thrown
      // TransitionError (adversarial-review finding). recordDenial itself
      // now opens its own short-lived transaction and sets its own actor
      // context on `auditDb` before writing — it no longer depends on any
      // actor context previously (and uselessly) set on the bare `db`
      // handle outside a transaction (see transition-engine.ts's
      // recordDenial doc comment; a bare, non-transactional
      // setActorContext(db, ...) never survives past the statement that set
      // it, so the removed call here was a guaranteed no-op, not merely
      // "best-effort").
      return transitionEngine.transitionPhase(
        tx,
        issueId,
        toPhase,
        {
          roles: user.roles,
          actorExternalId: user.id,
          actorRole: user.roles[0] ?? null,
          reason,
        },
        db,
      );
    });
  } catch (err) {
    if (err instanceof transitionEngine.TransitionError) {
      const blockers = await buildBlockerList(db, actor, issueRow.propertyRefId, err);
      redirect(`/issues/${issueId}?transitionError=${encodeURIComponent(JSON.stringify(blockers))}`);
    }
    throw err;
  }

  revalidatePath(`/issues/${issueId}`);
  redirect(`/issues/${issueId}`);
}

// =====================================================================
// Release-gate facts — record price review / possession (spec §10, §28.3,
// §29.10). ADVERSARIAL-REVIEW FIX: prior to these two actions, nothing in
// app/actions.ts (or anywhere in the UI) could ever write issues.
// price_reviewed_at or possession_records — the two facts
// checkReleaseEligibility's gates_release check requires — making the
// release-track workflow structurally unreachable through the shipped UI
// for any real property. issue-service.recordPriceReview and
// possession-service.recordPossession already existed as command-layer
// fixes; this wires them into the case view the same way transitionPhase
// already is.
// =====================================================================

export async function recordPriceReviewAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const issueId = str(formData, 'issueId');
  const returnTo = safeReturnTo(formData, `/issues/${issueId}`);

  try {
    await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      // actorRoles comes from the authenticated user's own roles, never
      // from form data (requirements line 378: the server independently
      // rechecks permission) — see issue-authz.ts's assertIssueAuthorized
      // (round-2 IDOR fix).
      return issueService.recordPriceReview(tx, {
        issueId,
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
        actorRoles: user.roles,
      });
    });
  } catch (err) {
    if (err instanceof issueService.IssueValidationError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent(err.violations.join('; '))}`);
    }
    if (err instanceof IssueAuthorizationError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function recordPossessionAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const issueId = str(formData, 'issueId');
  const rawPossessionStatus = str(formData, 'possessionStatus');
  const notes = str(formData, 'notes') || null;
  const returnTo = safeReturnTo(formData, `/issues/${issueId}`);

  // ADVERSARIAL-REVIEW FIX (round 2, P1): validate against the known enum
  // BEFORE the cast — see KNOWN_POSSESSION_STATUSES's doc comment.
  if (!KNOWN_POSSESSION_STATUSES.has(rawPossessionStatus as PossessionStatus)) {
    redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent(`Unknown possession status: "${rawPossessionStatus}".`)}`);
  }
  const possessionStatus = rawPossessionStatus as PossessionStatus;

  try {
    await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      // actorRoles comes from the authenticated user's own roles, never
      // from form data — see issue-authz.ts's assertIssueAuthorized
      // (round-2 IDOR fix).
      return possessionService.recordPossession(tx, {
        issueId,
        possessionStatus,
        notes,
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
        actorRoles: user.roles,
      });
    });
  } catch (err) {
    if (err instanceof possessionService.PossessionServiceError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent(err.message)}`);
    }
    if (err instanceof IssueAuthorizationError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath(returnTo);
  redirect(returnTo);
}

// =====================================================================
// Saved views — /issues "Save view" / delete (spec §15)
// =====================================================================

export async function saveIssuesViewAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const name = str(formData, 'name');
  const rawParams = str(formData, 'params');
  const returnTo = safeReturnTo(formData, '/issues');

  let params: unknown;
  try {
    params = rawParams ? JSON.parse(rawParams) : {};
  } catch {
    redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}savedViewError=${encodeURIComponent('Could not read the current view to save.')}`);
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      return savedViewService.createSavedView(tx, {
        ownerExternalId: user.id,
        name,
        params,
        actorId: user.id,
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
      });
    });
  } catch (err) {
    if (err instanceof savedViewService.SavedViewServiceError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}savedViewError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  // 'layout' (not just the '/issues' page itself): the Sidebar's saved-views
  // list renders from the root layout on EVERY route, not just /issues.
  revalidatePath('/', 'layout');
  redirect(returnTo);
}

export async function deleteIssuesViewAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const id = str(formData, 'id');
  const returnTo = safeReturnTo(formData, '/issues');

  try {
    await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      // ownerExternalId comes from the authenticated user's own identity,
      // never from form data — deleteSavedView (and the owner-scoped RLS
      // policy behind it) already scope by owner, but the form never even
      // gets a chance to name a different owner's saved view.
      return savedViewService.deleteSavedView(tx, {
        ownerExternalId: user.id,
        id,
        actorId: user.id,
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
      });
    });
  } catch (err) {
    if (err instanceof savedViewService.SavedViewServiceError) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}savedViewError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath('/', 'layout');
  redirect(returnTo);
}

// =====================================================================
// Intake form — new issue (spec §5.2)
// =====================================================================

function collectPeople(formData: FormData): issueService.CreateIssuePersonInput[] {
  const people: issueService.CreateIssuePersonInput[] = [];
  for (let i = 0; i < PERSON_ROW_COUNT; i += 1) {
    const personRefId = str(formData, `personRefId_${i}`);
    const role = str(formData, `personRole_${i}`) as IssuePersonRole;
    if (personRefId) {
      people.push({ personRefId, role: role || 'other' });
    }
  }
  return people;
}

export async function createIssueAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();

  const issueType = str(formData, 'issueType') as IssueType;
  const propertyRefId = str(formData, 'propertyRefId');
  const summary = str(formData, 'summary');
  const priority = (str(formData, 'priority') || 'normal') as Priority;
  const mapLink = str(formData, 'mapLink');
  const offMarket = formData.get('offMarket') === 'on';
  const holdReason = str(formData, 'holdReason');
  const taskTitle = str(formData, 'taskTitle');
  const taskDueDate = str(formData, 'taskDueDate');
  const people = collectPeople(formData);

  const violations: string[] = [];
  if (summary.length > 0 && summary.length < MIN_SUMMARY_LENGTH) {
    violations.push(`Summary must be at least ${MIN_SUMMARY_LENGTH} characters.`);
  }
  if (issueType === 'default_recovery' && !mapLink) {
    violations.push('Map link is required for Default / Property Recovery issues.');
  }
  if (offMarket && !holdReason) {
    violations.push('A reason is required when placing the property off-market/on hold.');
  }
  if (violations.length > 0) {
    redirect(`/issues/new?error=${encodeURIComponent(violations.join('; '))}`);
  }

  let issueId: string;
  try {
    const result = await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      const created = await issueService.createIssue(tx, {
        issueType,
        propertyRefId,
        summary,
        priority,
        coordinatorId: user.id,
        people,
        mapLink: mapLink || undefined,
        initialTask: {
          title: taskTitle,
          dueDate: taskDueDate,
          assigneeId: user.id,
          priority,
        },
        actorExternalId: user.id,
        actorRole: user.roles[0] ?? null,
      });

      if (offMarket) {
        await holdService.applyHold(tx, {
          propertyRefId,
          issueId: created.issue.id,
          holdType: 'other',
          reason: holdReason,
          source: 'intake_form',
          ownerId: user.id,
          actorExternalId: user.id,
          actorRole: user.roles[0] ?? null,
        });
      }

      return created;
    });
    issueId = result.issue.id;
  } catch (err) {
    if (err instanceof issueService.IssueValidationError) {
      redirect(`/issues/new?error=${encodeURIComponent(err.violations.join('; '))}`);
    }
    throw err;
  }

  revalidatePath('/');
  redirect(`/issues/${issueId}`);
}
