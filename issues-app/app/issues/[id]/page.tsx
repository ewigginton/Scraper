import { getCurrentUser } from '../../../lib/auth/current-user.ts';
import { tryGetDb } from '../../_lib/db.ts';
import { withActor } from '../../../lib/db/actor-context.ts';
import { loadCaseData, HISTORY_CATEGORY_LABELS, type HistoryCategory } from '../../_lib/case-view.ts';
import { propertyLabel } from '../../_lib/reference-data.ts';
import { classifyDueDate, formatDate, formatDateTime } from '../../_lib/dates.ts';
import { issueTypePillColor, lifecyclePillColor, priorityPillColor, holdTypePillColor, humanize } from '../../_lib/pills.ts';
import { Pill } from '../../_components/Pill.tsx';
import { DatabaseUnavailable } from '../../_components/EmptyState.tsx';
import { PinIcon, TagIcon, FlowIcon, PersonIcon, FlagIcon, ShieldIcon, CheckSquareIcon, ActivityIcon, WarningIcon, ChevronRightIcon } from '../../_components/icons.tsx';
import {
  completeTaskAction,
  rescheduleTaskAction,
  transitionPhaseAction,
  recordPriceReviewAction,
  recordPossessionAction,
  type RenderableBlocker,
} from '../../actions.ts';
import type { Task } from '../../../lib/db/schema.ts';

export const metadata = { title: 'Case — CCL Hub Issues' };

const HISTORY_PAGE_SIZE = 50;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ transitionError?: string; historyCategory?: string; historyOffset?: string }>;
}

function centsToUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function nextTaskOf(tasks: Task[]): Task | undefined {
  const open = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
  return [...open].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  })[0];
}

/** Parses a non-negative page offset from a URL query param; anything else (missing, negative, non-numeric) falls back to 0 rather than reaching a query. */
function parseOffset(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export default async function CasePage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { transitionError, historyCategory, historyOffset } = await searchParams;
  const user = await getCurrentUser();
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>Case</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  // ADVERSARIAL-REVIEW FIX: read through withActor (an explicit transaction
  // with app.actor_id/app.roles set) rather than the bare `db` handle — see
  // lib/db/actor-context.ts's withActor doc comment. Under a real
  // RLS-governed connection the previous bare-`db` read returned zero rows
  // for every table (a silent lockout); under the connection this repo
  // actually runs on (RLS bypassed), user.roles is now ALSO the input to
  // loadCaseData's application-layer evidence-classification filter, which
  // is the control that actually matters regardless of which connection is
  // in effect.
  const caseData = await withActor(db, { actorId: user.id, roles: user.roles }, (tx) => loadCaseData(tx, id, user.roles));
  if (!caseData) {
    return (
      <>
        <h1>Case not found</h1>
        <p>No issue exists with id {id}.</p>
        <a className="n-btn" href="/">
          Back to My Work
        </a>
      </>
    );
  }

  const { issue, property, people, holds, tasks, currentPhase, allowedNextPhases, history } = caseData;
  const next = nextTaskOf(tasks);
  const missingHandoff = !next || !next.dueDate;
  const activeHolds = holds.filter((h) => !h.releasedAt);
  const blockers: RenderableBlocker[] = transitionError ? safeParseBlockers(transitionError) : [];

  const filterCategory = (historyCategory as HistoryCategory | undefined) ?? undefined;
  const filteredHistory = filterCategory ? history.filter((h) => h.category === filterCategory) : history;
  const offset = parseOffset(historyOffset);
  const pageEnd = offset + HISTORY_PAGE_SIZE;
  const pagedHistory = filteredHistory.slice(0, pageEnd);
  const hasMoreHistory = filteredHistory.length > pageEnd;
  const historyQuery = filterCategory ? `historyCategory=${encodeURIComponent(filterCategory)}&` : '';

  return (
    <>
      <a className="n-btn n-btn-quiet" href="/" style={{ marginBottom: 'var(--space-md)' }}>
        &larr; Back to My Work
      </a>

      <header className="n-card case-header">
        <div className="flex justify-between items-center">
          <h1 className="n-page-title">{propertyLabel(property)}</h1>
        </div>
        <p className="muted" style={{ marginBottom: 'var(--space-md)' }}>
          {issue.summary}
        </p>

        <dl className="n-properties">
          <div className="n-property-row">
            <span className="n-property-icon">
              <PinIcon size={15} />
            </span>
            <span className="n-property-label">Property</span>
            <span className="n-property-value">
              {propertyLabel(property)}
              {property?.state ? `, ${property.state}` : ''}
            </span>
          </div>

          <div className="n-property-row">
            <span className="n-property-icon">
              <TagIcon size={15} />
            </span>
            <span className="n-property-label">Type</span>
            <span className="n-property-value">
              <Pill color={issueTypePillColor(issue.issueType)}>{humanize(issue.issueType)}</Pill>
            </span>
          </div>

          <div className="n-property-row">
            <span className="n-property-icon">
              <FlowIcon size={15} />
            </span>
            <span className="n-property-label">Current phase</span>
            <span className="n-property-value">
              {currentPhase ? <Pill color="blue">{humanize(currentPhase.phaseKey)}</Pill> : '—'}
            </span>
          </div>

          <div className="n-property-row">
            <span className="n-property-icon">
              <PersonIcon size={15} />
            </span>
            <span className="n-property-label">Coordinator</span>
            <span className="n-property-value">
              {issue.coordinatorId ?? (issue.queue ? humanize(issue.queue) : '—')}
            </span>
          </div>

          <div className="n-property-row">
            <span className="n-property-icon">
              <FlagIcon size={15} />
            </span>
            <span className="n-property-label">Priority</span>
            <span className="n-property-value">
              <Pill color={priorityPillColor(issue.priority)}>{humanize(issue.priority)}</Pill>
            </span>
          </div>

          <div className="n-property-row">
            <span className="n-property-icon">
              <ShieldIcon size={15} />
            </span>
            <span className="n-property-label">Active restrictions</span>
            <span className="n-property-value">
              {activeHolds.length === 0 ? (
                '—'
              ) : (
                <span className="n-property-pills">
                  {activeHolds.map((h) => (
                    <Pill key={h.id} color={h.holdType === 'other' ? 'orange' : holdTypePillColor(h.holdType)}>
                      {humanize(h.holdType)}
                    </Pill>
                  ))}
                </span>
              )}
            </span>
          </div>

          <div className="n-property-row">
            <span className="n-property-icon">
              <CheckSquareIcon size={15} />
            </span>
            <span className="n-property-label">Next task</span>
            <span className="n-property-value">
              {next ? next.title : 'None scheduled'}{' '}
              {next?.dueDate ? (
                <span className={`badge ${classifyDueDate(next.dueDate)}`}>{formatDate(next.dueDate)}</span>
              ) : (
                <span className="badge overdue">No due date</span>
              )}
            </span>
          </div>

          <div className="n-property-row">
            <span className="n-property-icon">
              <ActivityIcon size={15} />
            </span>
            <span className="n-property-label">Lifecycle</span>
            <span className="n-property-value">
              <Pill color={lifecyclePillColor(issue.lifecycleStatus)}>{humanize(issue.lifecycleStatus)}</Pill>
            </span>
          </div>
        </dl>

        {missingHandoff && (
          <p className="banner-warning" role="alert">
            ⚠ Handoff incomplete: this case has no next task with a future due date (spec §7). Assign one before handing off.
          </p>
        )}
      </header>

      {blockers.length > 0 && (
        <div className="n-card n-blocker-card" role="alert" style={{ marginTop: 'var(--space-lg)' }}>
          <div className="n-card-title">
            <WarningIcon size={16} />
            Transition blocked
          </div>
          <ul className="n-blocker-list">
            {blockers.map((b, i) => (
              <li key={i} className="n-blocker-row">
                <div className="n-blocker-reason">{b.reason}</div>
                <div className="n-blocker-meta">
                  Owner: {b.owner} — Next action: {b.nextAction}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="n-card" style={{ marginTop: 'var(--space-lg)' }}>
        <h2 className="n-card-title">Transition phase</h2>
        {allowedNextPhases.length === 0 ? (
          <p className="muted">No configured transitions from phase &quot;{currentPhase?.phaseKey ?? 'unknown'}&quot;.</p>
        ) : (
          <div className="flex gap-md" style={{ flexWrap: 'wrap' }}>
            {allowedNextPhases.map((def) => (
              <form action={transitionPhaseAction} key={def.to_phase}>
                <input type="hidden" name="issueId" value={issue.id} />
                <input type="hidden" name="toPhase" value={def.to_phase} />
                <button type="submit" className="n-btn n-btn-primary" title={def.description ?? ''}>
                  {humanize(def.to_phase)}
                </button>
              </form>
            ))}
          </div>
        )}
      </section>

      <details className="n-section" style={{ marginTop: 'var(--space-md)' }}>
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          Release-gate facts
        </summary>
        <div className="n-section-body">
          <p className="muted">
            Recording these is what lets a release-track transition (relisting / releasing / released) actually clear
            eligibility — see spec §10 (price review) and §29.10/§28.3 (possession/vacancy).
          </p>
          <div className="flex gap-md" style={{ flexWrap: 'wrap' }}>
            <form action={recordPriceReviewAction}>
              <input type="hidden" name="issueId" value={issue.id} />
              <input type="hidden" name="returnTo" value={`/issues/${issue.id}`} />
              <button type="submit" className="n-btn">
                Record price review (today)
              </button>
              {issue.priceReviewedAt && <p className="muted">Last reviewed: {formatDateTime(issue.priceReviewedAt)}</p>}
            </form>
            <form action={recordPossessionAction} className="flex gap-sm items-end">
              <input type="hidden" name="issueId" value={issue.id} />
              <input type="hidden" name="returnTo" value={`/issues/${issue.id}`} />
              <div>
                <label htmlFor="possessionStatus">Possession status</label>
                <br />
                <select id="possessionStatus" name="possessionStatus" className="n-select" defaultValue="vacancy_verified">
                  <option value="occupied_or_suspected">Occupied or suspected occupied</option>
                  <option value="vacancy_unverified">Vacancy unverified</option>
                  <option value="vacancy_verified">Vacancy verified</option>
                  <option value="personal_property_present">Personal property present</option>
                  <option value="cleared">Cleared</option>
                </select>
              </div>
              <button type="submit" className="n-btn">
                Record possession observation
              </button>
            </form>
          </div>
        </div>
      </details>

      <details className="n-section" open>
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          People ({people.length})
        </summary>
        <div className="n-section-body">
          {people.length === 0 ? (
            <p className="muted">No people linked to this case.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Person</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id}>
                      <td>{humanize(p.role)}</td>
                      <td>{p.personDisplayName ?? p.personRefId}</td>
                      <td>{p.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section">
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          Tasks ({tasks.length})
        </summary>
        <div className="n-section-body">
          {tasks.length === 0 ? (
            <p className="muted">No tasks yet.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Status</th>
                    <th scope="col">Due date</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Assignee</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id}>
                      <td>{t.title}</td>
                      <td>{humanize(t.status)}</td>
                      <td>
                        <span className={`badge ${classifyDueDate(t.dueDate)}`}>{formatDate(t.dueDate)}</span>
                      </td>
                      <td>
                        <Pill color={priorityPillColor(t.priority)}>{humanize(t.priority)}</Pill>
                      </td>
                      <td>{t.assigneeId ?? t.queue ?? '—'}</td>
                      <td>
                        {(t.status === 'open' || t.status === 'in_progress') && (
                          <div className="flex gap-sm">
                            <form action={completeTaskAction}>
                              <input type="hidden" name="taskId" value={t.id} />
                              <input type="hidden" name="returnTo" value={`/issues/${issue.id}`} />
                              <button type="submit" className="n-btn">
                                Complete
                              </button>
                            </form>
                            <form action={rescheduleTaskAction} className="flex gap-sm items-center">
                              <input type="hidden" name="taskId" value={t.id} />
                              <input type="hidden" name="returnTo" value={`/issues/${issue.id}`} />
                              <label htmlFor={`resched-${t.id}`} className="visually-hidden">
                                New due date for {t.title}
                              </label>
                              <input id={`resched-${t.id}`} type="date" name="newDueDate" className="n-input" defaultValue={t.dueDate ?? ''} />
                              <button type="submit" className="n-btn">
                                Reschedule
                              </button>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section">
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          Holds ({holds.length})
        </summary>
        <div className="n-section-body">
          {holds.length === 0 ? (
            <p className="muted">No holds recorded.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Effective start</th>
                    <th scope="col">Released</th>
                  </tr>
                </thead>
                <tbody>
                  {holds.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <Pill color={holdTypePillColor(h.holdType)}>{humanize(h.holdType)}</Pill>
                      </td>
                      <td>{h.reason}</td>
                      <td>{formatDateTime(h.effectiveStart)}</td>
                      <td>{h.releasedAt ? `${formatDateTime(h.releasedAt)} by ${h.releasedBy} — ${h.releaseReason}` : 'Active'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section">
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          Legal / VS ({caseData.notices.length} notice{caseData.notices.length === 1 ? '' : 's'})
        </summary>
        <div className="n-section-body">
          <p className="muted">
            Voluntary-surrender and legal-stage tracking beyond notices is deferred per DESIGN.md §2; notices are the Phase-1 record.
          </p>
          {caseData.notices.length === 0 ? (
            <p className="muted">No notices recorded.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Template</th>
                    <th scope="col">Status</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Cure deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {caseData.notices.map((n) => (
                    <tr key={n.id}>
                      <td>{n.templateVersion}</td>
                      <td>{humanize(n.status)}</td>
                      <td>{formatDateTime(n.sentAt)}</td>
                      <td>{formatDate(n.cureDeadline)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section">
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          Bids &amp; Cleanup ({caseData.bids.length} bid{caseData.bids.length === 1 ? '' : 's'}, {caseData.vendorJobs.length} job
          {caseData.vendorJobs.length === 1 ? '' : 's'})
        </summary>
        <div className="n-section-body">
          <h3>Bids</h3>
          {caseData.bids.length === 0 ? (
            <p className="muted">No bids yet.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Vendor</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col">Est. completion</th>
                  </tr>
                </thead>
                <tbody>
                  {caseData.bids.map((b) => (
                    <tr key={b.id}>
                      <td>{b.vendorId}</td>
                      <td>{centsToUsd(b.amountCents)}</td>
                      <td>{humanize(b.status)}</td>
                      <td>{formatDate(b.estimatedCompletionDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 style={{ marginTop: 'var(--space-md)' }}>Vendor jobs</h3>
          {caseData.vendorJobs.length === 0 ? (
            <p className="muted">No vendor jobs yet.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Vendor</th>
                    <th scope="col">Status</th>
                    <th scope="col">Scheduled</th>
                    <th scope="col">Final cost</th>
                    <th scope="col">Change orders</th>
                  </tr>
                </thead>
                <tbody>
                  {caseData.vendorJobs.map((j) => (
                    <tr key={j.id}>
                      <td>{j.vendorId}</td>
                      <td>{humanize(j.status)}</td>
                      <td>{formatDate(j.scheduledCompletionDate)}</td>
                      <td>{centsToUsd(j.finalCostCents)}</td>
                      <td>{caseData.changeOrders.filter((c) => c.vendorJobId === j.id).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section">
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          Costs &amp; Payments ({caseData.costEntries.length} cost{caseData.costEntries.length === 1 ? '' : 's'}, {caseData.paymentRequests.length}{' '}
          payment{caseData.paymentRequests.length === 1 ? '' : 's'})
        </summary>
        <div className="n-section-body">
          <h3>Cost entries</h3>
          {caseData.costEntries.length === 0 ? (
            <p className="muted">No cost entries yet.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Classification</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Effective date</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {caseData.costEntries.map((c) => (
                    <tr key={c.id}>
                      <td>{humanize(c.classification)}</td>
                      <td>{centsToUsd(c.amountCents)}</td>
                      <td>{formatDate(c.effectiveDate)}</td>
                      <td>{c.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 style={{ marginTop: 'var(--space-md)' }}>Payment requests</h3>
          {caseData.paymentRequests.length === 0 ? (
            <p className="muted">No payment requests yet.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Vendor</th>
                    <th scope="col">Invoice #</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {caseData.paymentRequests.map((p) => (
                    <tr key={p.id}>
                      <td>{p.vendorId}</td>
                      <td>{p.invoiceNumber ?? '—'}</td>
                      <td>{centsToUsd(p.amountCents)}</td>
                      <td>{humanize(p.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section">
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          Evidence ({caseData.evidenceFiles.length})
        </summary>
        <div className="n-section-body">
          {caseData.restrictedEvidenceCount > 0 && (
            <p className="muted" role="note">
              {caseData.restrictedEvidenceCount} restricted record{caseData.restrictedEvidenceCount === 1 ? '' : 's'} (access required) not shown.
            </p>
          )}
          {caseData.evidenceFiles.length === 0 ? (
            <p className="muted">No evidence files recorded.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Type</th>
                    <th scope="col">Access</th>
                    <th scope="col">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {caseData.evidenceFiles.map((f) => (
                    <tr key={f.id}>
                      <td>{f.originalFilename ?? f.storageRef}</td>
                      <td>{f.fileType ?? '—'}</td>
                      <td>{humanize(f.accessClassification)}</td>
                      <td>{formatDateTime(f.uploadedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section" id="history" open>
        <summary>
          <span className="n-chevron">
            <ChevronRightIcon size={14} />
          </span>
          History (showing {pagedHistory.length} of {filteredHistory.length}
          {filteredHistory.length !== history.length ? `, ${history.length} total` : ''})
        </summary>
        <div className="n-section-body">
          <form method="get" className="flex gap-sm items-center" style={{ marginBottom: 'var(--space-md)' }}>
            <label htmlFor="historyCategory">Filter by category</label>
            <select id="historyCategory" name="historyCategory" className="n-select" defaultValue={filterCategory ?? ''}>
              <option value="">All categories</option>
              {Object.entries(HISTORY_CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button type="submit" className="n-btn">
              Apply
            </button>
          </form>
          {pagedHistory.length === 0 ? (
            <p className="muted">No history entries for this filter.</p>
          ) : (
            <>
              <div className="n-table-wrap">
                <table className="n-table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Category</th>
                      <th scope="col">Action</th>
                      <th scope="col">Detail</th>
                      <th scope="col">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedHistory.map((h) => (
                      <tr key={h.id}>
                        <td>{formatDateTime(h.occurredAt)}</td>
                        <td>{HISTORY_CATEGORY_LABELS[h.category]}</td>
                        <td>{humanize(h.action)}</td>
                        <td>{h.detail}</td>
                        <td>{h.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hasMoreHistory && (
                <a className="n-load-more" href={`/issues/${issue.id}?${historyQuery}historyOffset=${pageEnd}#history`}>
                  Load next {Math.min(HISTORY_PAGE_SIZE, filteredHistory.length - pageEnd)} &darr;
                </a>
              )}
            </>
          )}
        </div>
      </details>
    </>
  );
}

function safeParseBlockers(raw: string): RenderableBlocker[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as RenderableBlocker[];
    return [];
  } catch {
    return [{ reason: raw, owner: 'Property Operations', nextAction: 'Review and retry.' }];
  }
}
