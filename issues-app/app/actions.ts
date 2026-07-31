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
import * as eligibilityService from '../lib/services/eligibility-service.ts';
import * as transitionEngine from '../lib/services/transition-engine.ts';
import { setActorContext } from '../lib/db/actor-context.ts';
import { issues, type IssuePersonRole, type IssueType, type Priority } from '../lib/db/schema.ts';

const MIN_SUMMARY_LENGTH = 20;
const PERSON_ROW_COUNT = 4;

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

// =====================================================================
// Personal work screen — Complete / Reschedule (spec §8.1)
// =====================================================================

export async function completeTaskAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const taskId = str(formData, 'taskId');
  const returnTo = str(formData, 'returnTo') || '/';

  await db.transaction(async (tx) => {
    await setActorContext(tx, { actorId: user.id, roles: user.roles });
    return taskService.completeTask(tx, {
      taskId,
      actorExternalId: user.id,
      actorRole: user.roles[0] ?? null,
      correlationId: null,
    });
  });

  revalidatePath('/');
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function rescheduleTaskAction(formData: FormData): Promise<void> {
  const db = requireDb();
  const user = await getCurrentUser();
  const taskId = str(formData, 'taskId');
  const newDueDate = str(formData, 'newDueDate');
  const returnTo = str(formData, 'returnTo') || '/';

  if (!newDueDate) {
    redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}workError=${encodeURIComponent('A new due date is required to reschedule.')}`);
  }

  await db.transaction(async (tx) => {
    await setActorContext(tx, { actorId: user.id, roles: user.roles });
    return taskService.rescheduleTask(tx, {
      taskId,
      newDueDate,
      actorExternalId: user.id,
      actorRole: user.roles[0] ?? null,
      correlationId: null,
    });
  });

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

async function buildBlockerList(db: ReturnType<typeof requireDb>, propertyRefId: string, err: transitionEngine.TransitionError): Promise<RenderableBlocker[]> {
  if (err.code === 'prerequisites_not_met') {
    const blockers: RenderableBlocker[] = [];
    for (const detail of err.reasons) {
      if (detail.startsWith('no_blocking_holds')) {
        const elig = await eligibilityService.checkReleaseEligibility(db, propertyRefId);
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

  const [issueRow] = await db.select().from(issues).where(eq(issues.id, issueId));
  if (!issueRow) {
    redirect(`/issues/${issueId}?transitionError=${encodeURIComponent(JSON.stringify([{ reason: 'Issue not found.', owner: 'Property Operations', nextAction: 'Reload the case.' }]))}`);
  }

  try {
    // Best-effort actor context on `db` too, for the denial-audit write
    // below (5th arg auditDb) — NOTE: on a pooled production driver this
    // only reliably reaches the audit insert if that insert lands on the
    // same pooled connection this set_config ran on, which postgres-js
    // does not guarantee across two separate top-level `db` calls. Solving
    // connection affinity for a non-transactional audit write is out of
    // this fix's scope; documented here rather than silently assumed to
    // work. It is reliable in tests (PGlite is a single connection).
    await setActorContext(db, { actorId: user.id, roles: user.roles });
    await db.transaction(async (tx) => {
      await setActorContext(tx, { actorId: user.id, roles: user.roles });
      // `db` (NOT `tx`) is passed as the 5th arg (auditDb) so a denial
      // audit row (forbidden/prerequisites_not_met/not_eligible) survives
      // even though this transaction is about to roll back on the thrown
      // TransitionError (adversarial-review finding).
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
      const blockers = await buildBlockerList(db, issueRow.propertyRefId, err);
      redirect(`/issues/${issueId}?transitionError=${encodeURIComponent(JSON.stringify(blockers))}`);
    }
    throw err;
  }

  revalidatePath(`/issues/${issueId}`);
  redirect(`/issues/${issueId}`);
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
