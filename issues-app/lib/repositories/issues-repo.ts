/**
 * issues-repo — all DB access for the `issues` table and its directly
 * joined case data (people, holds, tasks). No business rules live here —
 * lifecycle legality, hold-release prerequisites, etc. are enforced by
 * lib/services/*, not this module (DESIGN.md §6).
 */

import { asc, eq, inArray } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import {
  holds,
  issuePeople,
  issues,
  personRefs,
  tasks,
  type Hold,
  type Issue,
  type IssueCycle,
  type IssuePerson,
  type LifecycleStatus,
  type NewIssue,
  type Task,
  issueCycles,
} from '../db/schema.ts';

/** Bound on a batch id-lookup, so this can never become an unbounded read regardless of how many ids a caller passes. */
const MANY_BY_IDS_LIMIT = 1000;

export interface IssuePersonWithName extends IssuePerson {
  /** person_refs.display_name of the linked person; null if the ref row is gone. */
  personDisplayName: string | null;
}

export interface IssueWithCaseData extends Issue {
  people: IssuePersonWithName[];
  holds: Hold[];
  tasks: Task[];
}

/** Batch issues lookup by id, for display-field joins (e.g. the personal work screen). Bounded via MANY_BY_IDS_LIMIT, never an unbounded read. */
export async function getManyByIds(db: DbHandle, ids: string[]): Promise<Issue[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(issues)
    .where(inArray(issues.id, ids.slice(0, MANY_BY_IDS_LIMIT)))
    .orderBy(asc(issues.id));
}

/** Insert a new issue row and return it. */
export async function create(db: DbHandle, data: NewIssue): Promise<Issue> {
  const [row] = await db.insert(issues).values(data).returning();
  if (!row) {
    throw new Error('issues-repo.create: insert returned no row');
  }
  return row;
}

/**
 * Fetch a single issue by id along with its issue_people, holds, and tasks
 * (all directly linked by issue_id). Returns undefined if no issue with
 * that id exists.
 */
export async function getById(db: DbHandle, id: string): Promise<IssueWithCaseData | undefined> {
  const [issue] = await db.select().from(issues).where(eq(issues.id, id));
  if (!issue) {
    return undefined;
  }

  const [peopleRows, issueHolds, issueTasks] = await Promise.all([
    db
      .select({ link: issuePeople, personDisplayName: personRefs.displayName })
      .from(issuePeople)
      .leftJoin(personRefs, eq(issuePeople.personRefId, personRefs.id))
      .where(eq(issuePeople.issueId, id)),
    db.select().from(holds).where(eq(holds.issueId, id)),
    db.select().from(tasks).where(eq(tasks.issueId, id)),
  ]);
  const people = peopleRows.map((r) => ({ ...r.link, personDisplayName: r.personDisplayName }));

  return { ...issue, people, holds: issueHolds, tasks: issueTasks };
}

/**
 * Update an issue's lifecycle_status (and any other supplied columns in
 * the same patch). Returns the updated row, or undefined if no issue with
 * that id exists. Caller (lib/services/transition-engine.ts) is
 * responsible for validating the transition is legal before calling this.
 */
export async function updateLifecycle(
  db: DbHandle,
  id: string,
  lifecycleStatus: LifecycleStatus,
  patch: Partial<Omit<NewIssue, 'id' | 'lifecycleStatus'>> = {},
): Promise<Issue | undefined> {
  const [row] = await db
    .update(issues)
    .set({ ...patch, lifecycleStatus })
    .where(eq(issues.id, id))
    .returning();
  return row;
}

/**
 * Open a new issue_cycle for an issue. `cycleNumber` defaults to one past
 * the highest existing cycle_number for this issue (1 if none exist).
 * Caller decides whether opening a new cycle is appropriate (e.g.
 * reopen-as-new-cycle in lib/services/issue-service.ts).
 */
export async function openCycle(
  db: DbHandle,
  issueId: string,
  data: { cycleNumber?: number; reason?: string } = {},
): Promise<IssueCycle> {
  let cycleNumber = data.cycleNumber;
  if (cycleNumber === undefined) {
    const existing = await db
      .select({ cycleNumber: issueCycles.cycleNumber })
      .from(issueCycles)
      .where(eq(issueCycles.issueId, issueId));
    cycleNumber = existing.reduce((max, row) => Math.max(max, row.cycleNumber), 0) + 1;
  }

  const [row] = await db
    .insert(issueCycles)
    .values({ issueId, cycleNumber, reason: data.reason })
    .returning();
  if (!row) {
    throw new Error('issues-repo.openCycle: insert returned no row');
  }
  return row;
}
