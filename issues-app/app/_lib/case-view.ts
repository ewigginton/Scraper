/**
 * app/_lib/case-view.ts — read-side aggregation for the case view screen
 * (spec §7 handoff header, DESIGN.md §8 `/issues/[id]`). issues-repo.getById
 * already returns the issue + its directly-linked people/holds/tasks; this
 * module adds the joins/reads no repository currently exposes for this
 * screen (property, phase history, bids/vendor jobs/change orders,
 * cost/payment activity, evidence, notices, checklist items, and a combined
 * audit+phase history feed). Documented gap: several of these belong in
 * lib/repositories/ long-term; that directory is outside this lane's
 * assigned paths.
 */

import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import type { DbHandle } from '../../lib/repositories/db-handle.ts';
import * as auditRepo from '../../lib/repositories/audit-repo.ts';
import * as configRepo from '../../lib/repositories/config-repo.ts';
import * as paymentsRepo from '../../lib/repositories/payments-repo.ts';
import * as contractRefsRepo from '../../lib/repositories/contract-refs-repo.ts';
import { sanitizeUuidArray } from '../../lib/repositories/id-guard.ts';
import {
  auditEvents,
  bids,
  changeOrders,
  checklistItems,
  costEntries,
  evidenceFiles,
  notices,
  personRefs,
  phaseInstances,
  propertyRefs,
  vendorJobs,
  type AuditEvent,
  type Bid,
  type ChangeOrder,
  type ChecklistItem,
  type ContractRef,
  type CostEntry,
  type EvidenceFile,
  type Hold,
  type IssuePerson,
  type Issue,
  type Notice,
  type PaymentRequest,
  type PersonRef,
  type PhaseInstance,
  type PropertyRef,
  type Task,
  type VendorJob,
} from '../../lib/db/schema.ts';
import type { TransitionDefinition } from '../../lib/services/transition-engine.ts';
import * as issuesRepo from '../../lib/repositories/issues-repo.ts';

export interface CaseData {
  issue: Issue;
  property: PropertyRef | undefined;
  people: issuesRepo.IssuePersonWithName[];
  holds: Hold[];
  tasks: Task[];
  currentPhase: PhaseInstance | undefined;
  phaseHistory: PhaseInstance[];
  allowedNextPhases: TransitionDefinition[];
  bids: Bid[];
  vendorJobs: VendorJob[];
  changeOrders: ChangeOrder[];
  costEntries: CostEntry[];
  paymentRequests: PaymentRequest[];
  /** Only 'internal' evidence, plus every classification when the caller holds manager/admin — see loadCaseData's `roles` param. */
  evidenceFiles: EvidenceFile[];
  /** Count of restricted_legal/restricted_financial rows withheld from `evidenceFiles` for a non-manager/admin caller. 0 for a manager/admin (nothing withheld) and 0 whenever there is nothing restricted. */
  restrictedEvidenceCount: number;
  notices: Notice[];
  checklistItems: ChecklistItem[];
  history: HistoryEntry[];
  /** Full person_refs rows (contact_snapshot etc.) for every person linked to this case, keyed by id — for the People section's hover cards (spec §15). issuesRepo.getById's people join only selects display_name, not the whole row. */
  peopleRefsById: Map<string, PersonRef>;
  /** contract_refs rows for this case's property (roadmap Wave 2b "Case left-panel contract/transaction overview"). NOT canonical (§30.2) — read-model cache, empty when Sales/Transactions has no contract synced yet for this property. */
  contracts: ContractRef[];
}

/**
 * History merges audit_events from several source tables (issues, holds,
 * tasks, payment_requests) plus phase_instances, then sorts the combined
 * list in memory (occurredAt desc) because there is no single indexed
 * column to ORDER BY + LIMIT across those heterogeneous sources in one
 * query. HISTORY_FETCH_CAP bounds each source query so the read stays
 * defensively finite (docs/notion-redesign.md "no unbounded reads
 * anywhere ... paginate at 50 with Load more") even though it is not true
 * keyset pagination pushed down to SQL. The case page then paginates the
 * capped, sorted array for display. Documented gap: a case with more than
 * HISTORY_FETCH_CAP audit rows from a single source would silently lose its
 * oldest entries off the end of History — acceptable at Phase-1 volumes,
 * flagged here for the eventual keyset-per-object rework.
 */
const HISTORY_FETCH_CAP = 500;

const RESTRICTED_EVIDENCE_ROLES = new Set(['manager', 'admin']);
const RESTRICTED_CLASSIFICATIONS = new Set(['restricted_legal', 'restricted_financial']);

/**
 * ADVERSARIAL-REVIEW FIX (P0): apply access_classification filtering in
 * application code at this read chokepoint, not only in RLS — RLS never
 * actually governs this connection (see the actor-context findings), and
 * even when it does, evidence_files_select_classification_aware is the
 * ONLY enforcement anywhere; a second, connection-independent layer here is
 * required per requirements line 872 ("unauthorized users shall not receive
 * the content through timelines, summaries, search, exports, ..."). Returns
 * the visible subset PLUS a neutral count of what was withheld (line 872:
 * "the existence of a neutral restricted-record indicator may be shown
 * where approved") rather than silently shrinking the evidence count with
 * no explanation.
 */
function filterEvidenceForRoles(files: EvidenceFile[], roles: string[]): { visible: EvidenceFile[]; restrictedCount: number } {
  const canSeeRestricted = roles.some((r) => RESTRICTED_EVIDENCE_ROLES.has(r));
  if (canSeeRestricted) {
    return { visible: files, restrictedCount: 0 };
  }
  const visible = files.filter((f) => !RESTRICTED_CLASSIFICATIONS.has(f.accessClassification));
  return { visible, restrictedCount: files.length - visible.length };
}

export type HistoryCategory =
  | 'business_event'
  | 'workflow_transition'
  | 'tasks'
  | 'holds_releases'
  | 'vendor_cost'
  | 'field_edit';

export const HISTORY_CATEGORY_LABELS: Record<HistoryCategory, string> = {
  business_event: 'Business events',
  workflow_transition: 'Workflow transitions',
  tasks: 'Tasks',
  holds_releases: 'Holds / releases',
  vendor_cost: 'Vendor / cost activity',
  field_edit: 'Other / field edits',
};

export interface HistoryEntry {
  id: string;
  occurredAt: Date;
  category: HistoryCategory;
  action: string;
  actorRole: string | null;
  reason: string | null;
  detail: string;
}

const ACTION_CATEGORY: Record<string, HistoryCategory> = {
  issue_created: 'business_event',
  issue_reopened_new_cycle: 'business_event',
  stale_case_acknowledged: 'business_event',
  reinstatement_effective_applied: 'business_event',
  phase_transitioned: 'workflow_transition',
  task_completed: 'tasks',
  task_rescheduled: 'tasks',
  task_follow_up_created: 'tasks',
  hold_applied: 'holds_releases',
  hold_released: 'holds_releases',
  payment_request_submitted: 'vendor_cost',
  payment_request_approved: 'vendor_cost',
  payment_request_duplicate_blocked: 'vendor_cost',
};

function categorize(action: string): HistoryCategory {
  return ACTION_CATEGORY[action] ?? 'field_edit';
}

function auditToHistory(row: AuditEvent): HistoryEntry {
  return {
    id: `audit:${row.id}`,
    occurredAt: row.occurredAt,
    category: categorize(row.action),
    action: row.action,
    actorRole: row.actorRole,
    reason: row.reason,
    detail: `${row.objectTable} ${row.objectId.slice(0, 8)}`,
  };
}

function phaseToHistory(row: PhaseInstance): HistoryEntry {
  return {
    id: `phase:${row.id}`,
    occurredAt: row.startedAt ?? row.createdAt,
    category: 'workflow_transition',
    action: row.status === 'open' || row.status === 'in_progress' ? 'phase_opened' : `phase_${row.status}`,
    actorRole: row.ownerId,
    reason: row.entryReason ?? row.exitOutcome ?? null,
    detail: row.phaseKey,
  };
}

/**
 * Load everything the case view needs for one issue. Returns undefined if
 * the issue doesn't exist. `roles` (the CALLING actor's roles, never
 * user-suppliable) gates restricted-evidence visibility — see
 * filterEvidenceForRoles. Defaults to `[]` (i.e. no restricted access) so a
 * caller that forgets to pass roles fails closed rather than open.
 */
export async function loadCaseData(db: DbHandle, issueId: string, roles: string[] = []): Promise<CaseData | undefined> {
  const base = await issuesRepo.getById(db, issueId);
  if (!base) return undefined;

  const [property] = await db.select().from(propertyRefs).where(eq(propertyRefs.id, base.propertyRefId));

  const [phaseHistory, issueBids, issueVendorJobs, issueCostEntries, issuePaymentRequests, issueEvidence, issueNotices, auditRows] =
    await Promise.all([
      db.select().from(phaseInstances).where(eq(phaseInstances.issueId, issueId)).orderBy(asc(phaseInstances.startedAt)),
      db.select().from(bids).where(eq(bids.issueId, issueId)),
      db.select().from(vendorJobs).where(eq(vendorJobs.issueId, issueId)),
      db.select().from(costEntries).where(eq(costEntries.issueId, issueId)),
      paymentsRepo.listForIssue(db, issueId),
      db.select().from(evidenceFiles).where(eq(evidenceFiles.issueId, issueId)),
      db.select().from(notices).where(eq(notices.issueId, issueId)),
      auditRepo.listForObject(db, 'issues', issueId, { limit: HISTORY_FETCH_CAP }),
    ]);

  const personRefIds = sanitizeUuidArray(base.people.map((p) => p.personRefId));
  const [peopleRefRows, contracts] = await Promise.all([
    personRefIds.length > 0 ? db.select().from(personRefs).where(inArray(personRefs.id, personRefIds)) : Promise.resolve([]),
    contractRefsRepo.getForProperty(db, base.propertyRefId),
  ]);
  const peopleRefsById = new Map(peopleRefRows.map((p) => [p.id, p]));

  const vendorJobIds = issueVendorJobs.map((j) => j.id);
  const issueChangeOrders = vendorJobIds.length > 0 ? await db.select().from(changeOrders).where(inArray(changeOrders.vendorJobId, vendorJobIds)) : [];

  const phaseInstanceIds = phaseHistory.map((p) => p.id);
  const issueChecklistItems =
    phaseInstanceIds.length > 0 ? await db.select().from(checklistItems).where(inArray(checklistItems.phaseInstanceId, phaseInstanceIds)) : [];

  // Aggregate audit_events across every object this case touches (holds,
  // tasks, bids, vendor jobs, cost entries, payment requests) in addition to
  // the issue's own rows, so History is a real cross-object timeline
  // (spec §31.4), not just issues-table edits.
  const objectPairs: Array<[string, string]> = [
    ...base.holds.map((h): [string, string] => ['holds', h.id]),
    ...base.tasks.map((t): [string, string] => ['tasks', t.id]),
    ...issuePaymentRequests.map((p): [string, string] => ['payment_requests', p.id]),
  ];
  const extraAuditRows =
    objectPairs.length > 0
      ? await db
          .select()
          .from(auditEvents)
          .where(or(...objectPairs.map(([table, id]) => and(eq(auditEvents.objectTable, table), eq(auditEvents.objectId, id)))))
          .orderBy(desc(auditEvents.occurredAt))
          .limit(HISTORY_FETCH_CAP)
      : [];

  const allAudit = [...auditRows, ...extraAuditRows];
  const history: HistoryEntry[] = [...allAudit.map(auditToHistory), ...phaseHistory.map(phaseToHistory)].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );

  const currentPhase = base.currentPhaseInstanceId ? phaseHistory.find((p) => p.id === base.currentPhaseInstanceId) : undefined;
  const allowedNextPhases = currentPhase ? await computeAllowedNextPhases(db, base.issueType, currentPhase.phaseKey) : [];

  const { visible: visibleEvidence, restrictedCount } = filterEvidenceForRoles(issueEvidence, roles);

  return {
    issue: base,
    property,
    people: base.people,
    peopleRefsById,
    contracts,
    holds: base.holds,
    tasks: base.tasks,
    currentPhase,
    phaseHistory,
    allowedNextPhases,
    bids: issueBids,
    vendorJobs: issueVendorJobs,
    changeOrders: issueChangeOrders,
    costEntries: issueCostEntries,
    paymentRequests: issuePaymentRequests,
    evidenceFiles: visibleEvidence,
    restrictedEvidenceCount: restrictedCount,
    notices: issueNotices,
    checklistItems: issueChecklistItems,
    history,
  };
}

/**
 * Mirrors transition-engine.ts's internal `loadTransitionDefinitions` +
 * from-phase filter (those helpers aren't exported) using the same
 * config-repo source of truth, so the case view can render the same allowed
 * destinations transitionPhase() will actually accept.
 */
export async function computeAllowedNextPhases(db: DbHandle, issueType: string, currentPhaseKey: string): Promise<TransitionDefinition[]> {
  const allTransitions = await configRepo.get<Record<string, TransitionDefinition[]>>(db, 'phase_1_defaults', 'transitions');
  const defs = allTransitions?.[issueType] ?? [];
  return defs.filter((def) => def.from_phase === currentPhaseKey);
}
