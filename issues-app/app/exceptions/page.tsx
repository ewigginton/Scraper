/**
 * app/exceptions/page.tsx — §13 alerts/exception-reporting/data-quality
 * queue: "A dedicated exception dashboard should show ownership, age,
 * reason, and next action — not simply red flags." Server-rendered; every
 * count comes from a bounded aggregate query in
 * lib/repositories/exceptions-repo.ts (never a full unbounded read scanned
 * here), and every row links to its case.
 */

import { getCurrentUser } from '../../lib/auth/current-user.ts';
import { tryGetDb } from '../_lib/db.ts';
import { withActor } from '../../lib/db/actor-context.ts';
import { humanize } from '../_lib/pills.ts';
import { DatabaseUnavailable } from '../_components/EmptyState.tsx';
import {
  missingOrShortSummaryQueue,
  noActionableTaskQueue,
  readyToReleaseBlockedQueue,
  staleCasesQueue,
  tasksOpenOverDaysQueue,
  type ExceptionQueueResult,
  type IssueExceptionRow,
  type TaskExceptionRow,
} from '../../lib/repositories/exceptions-repo.ts';
import styles from './exceptions.module.css';

export const metadata = { title: 'Exceptions — CCL Hub Issues' };

const ROW_LIMIT = 25;

export default async function ExceptionsPage() {
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1 className={styles.title}>Exceptions</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();

  const data = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const [noAction, shortSummary, readyBlocked, stale, tasksOpen] = await Promise.all([
      noActionableTaskQueue(tx, { limit: ROW_LIMIT }),
      missingOrShortSummaryQueue(tx, { limit: ROW_LIMIT }),
      readyToReleaseBlockedQueue(tx, { limit: ROW_LIMIT }),
      staleCasesQueue(tx, { limit: ROW_LIMIT }),
      tasksOpenOverDaysQueue(tx, { limit: ROW_LIMIT }),
    ]);
    return { noAction, shortSummary, readyBlocked, stale, tasksOpen };
  });

  return (
    <>
      <h1 className={styles.title}>Exceptions</h1>
      <p className="muted">
        Data-quality and process exceptions across all open cases — ownership, age, and the next action, not just a
        red flag.
      </p>

      <IssueQueueSection
        id="no-actionable-task"
        title="Active issues with no open task or no future due date"
        intro="Active cases where every open task is overdue/undated, or no task is open at all."
        result={data.noAction}
        nextAction={() => 'Open (or reschedule) a task with a future due date.'}
      />

      <IssueQueueSection
        id="short-summary"
        title="Missing or unclear summary"
        intro="Open cases whose summary is under 15 characters — too short to hand off or search on."
        result={data.shortSummary}
        nextAction={() => 'Write a clear one-line summary of the case.'}
      />

      <IssueQueueSection
        id="ready-to-release-blocked"
        title="Ready to relist, but blocked"
        intro="Cases in a pre-release phase whose property still carries an active hold older than 14 days."
        result={data.readyBlocked}
        nextAction={() => 'Review the blocking hold(s) for release-readiness or resolve/release them.'}
      />

      <IssueQueueSection
        id="stale-cases"
        title="Stale cases (no activity in 14+ days)"
        intro="Open, non-passive cases with no recorded change in at least 14 days."
        result={data.stale}
        nextAction={() => 'Check in on the case and record an update, or move it to passive wait with a wake reason.'}
      />

      <TaskQueueSection result={data.tasksOpen} />
    </>
  );
}

function ownerLabel(coordinatorId: string | null, queue: string | null): string {
  if (coordinatorId) return coordinatorId;
  if (queue) return humanize(queue);
  return 'Unassigned';
}

function IssueQueueSection({
  id,
  title,
  intro,
  result,
  nextAction,
}: {
  id: string;
  title: string;
  intro: string;
  result: ExceptionQueueResult<IssueExceptionRow>;
  nextAction: (row: IssueExceptionRow) => string;
}) {
  return (
    <section className="queue-section" aria-labelledby={`section-${id}`}>
      <h2 id={`section-${id}`} className="flex items-center gap-sm">
        {title} <span className="count-badge">{result.count}</span>
      </h2>
      <p className={`muted ${styles.sectionIntro}`}>{intro}</p>
      {result.rows.length === 0 ? (
        <p className="muted empty-queue">Nothing here.</p>
      ) : (
        <div className="table-scroll">
          <table className="n-table">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Property / State</th>
                <th scope="col">Owner</th>
                <th scope="col">Age</th>
                <th scope="col">Next action</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.issue.id}>
                  <td>
                    <a href={`/issues/${row.issue.id}`}>{row.issue.summary || '(no summary)'}</a>
                  </td>
                  <td>
                    {row.property.displayName ?? '—'}
                    {row.property.state ? `, ${row.property.state}` : ''}
                  </td>
                  <td>{ownerLabel(row.issue.coordinatorId, row.issue.queue)}</td>
                  <td className={styles.age}>
                    {row.ageDays} day{row.ageDays === 1 ? '' : 's'}
                  </td>
                  <td className="summary-cell">{nextAction(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.count > result.rows.length && (
        <p className="muted" style={{ marginTop: 'var(--space-sm)' }}>
          Showing {result.rows.length} of {result.count}.
        </p>
      )}
    </section>
  );
}

function TaskQueueSection({ result }: { result: ExceptionQueueResult<TaskExceptionRow> }) {
  return (
    <section className="queue-section" aria-labelledby="section-tasks-open">
      <h2 id="section-tasks-open" className="flex items-center gap-sm">
        Tasks open more than 30 days <span className="count-badge">{result.count}</span>
      </h2>
      <p className={`muted ${styles.sectionIntro}`}>Open or in-progress tasks that have not been closed in over a month.</p>
      {result.rows.length === 0 ? (
        <p className="muted empty-queue">Nothing here.</p>
      ) : (
        <div className="table-scroll">
          <table className="n-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Owner</th>
                <th scope="col">Age</th>
                <th scope="col">Next action</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.task.id}>
                  <td>
                    <a href={`/issues/${row.issueId}`}>{row.task.title}</a>
                  </td>
                  <td>{ownerLabel(row.task.assigneeId, row.task.queue)}</td>
                  <td className={styles.age}>
                    {row.ageDays} day{row.ageDays === 1 ? '' : 's'}
                  </td>
                  <td className="summary-cell">Close the task, or reassign/reschedule it if it is still valid.</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.count > result.rows.length && (
        <p className="muted" style={{ marginTop: 'var(--space-sm)' }}>
          Showing {result.rows.length} of {result.count}.
        </p>
      )}
    </section>
  );
}
