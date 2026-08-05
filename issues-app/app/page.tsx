import { getCurrentUser } from '../lib/auth/current-user.ts';
import { tryGetDb } from './_lib/db.ts';
import { withActor } from '../lib/db/actor-context.ts';
import { buildWorkScreen, WORK_QUEUE_LABELS, type WorkQueueKey, type WorkRow } from './_lib/work-screen.ts';
import { classifyDueDate, formatDate, todayIso } from './_lib/dates.ts';
import { priorityPillColor, humanize } from './_lib/pills.ts';
import { buildIssuesHref, type IssuesHrefOverrides } from './_lib/issues-view.ts';
import { Pill } from './_components/Pill.tsx';
import { DatabaseUnavailable, EmptyQueue } from './_components/EmptyState.tsx';
import { completeTaskAction, rescheduleTaskAction } from './actions.ts';

/**
 * Maps each My Work queue to its best-available /issues filter params
 * (docs/notion-redesign.md "My Work at volume": "a 'View all N' link into
 * /issues pre-filtered to that queue's params"). issues-query-repo's filter
 * allowlist is issue-level (type/status/state/priority/owner/overdue/q) —
 * it has no notion of a task's action_date, a notice's cure_deadline, or an
 * approval at all, so `actionDateFollowups`/`noticesDue`/`upcoming`/
 * `approvals` have no exact equivalent and fall back to "this coordinator's
 * own issues" (documented gap, not a silently invented filter). The other
 * three queues DO have an exact issue-level equivalent and use it.
 */
function issuesHrefForQueue(key: WorkQueueKey, userId: string): string {
  const overrides: IssuesHrefOverrides = (() => {
    switch (key) {
      case 'newUnreviewed':
        return { owner: userId, status: ['intake'] };
      case 'overdue':
        return { owner: userId, overdue: '1' };
      case 'waitingBlocked':
        return { owner: userId, status: ['waiting', 'blocked'] };
      case 'actionDateFollowups':
      case 'noticesDue':
      case 'upcoming':
      case 'approvals':
        return { owner: userId };
    }
  })();
  return buildIssuesHref({}, overrides);
}

export const metadata = { title: 'My Work — CCL Hub Issues' };

const QUEUE_ORDER: WorkQueueKey[] = [
  'newUnreviewed',
  'actionDateFollowups',
  'noticesDue',
  'upcoming',
  'overdue',
  'waitingBlocked',
  'approvals',
];

interface PageProps {
  searchParams: Promise<{ workError?: string }>;
}

export default async function Home({ searchParams }: PageProps) {
  const { workError } = await searchParams;
  const user = await getCurrentUser();
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>My Work</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  // ADVERSARIAL-REVIEW FIX: read through withActor — see
  // lib/db/actor-context.ts's doc comment and app/issues/[id]/page.tsx's
  // matching fix. The bare `db` handle used previously returns zero rows
  // under a real RLS-governed connection (issues_current_actor() is null).
  //
  // ROUND-2 ADVERSARIAL-REVIEW FIX: `queues: user.queues` — this used to
  // omit queues entirely, so tasks-repo.ts's ownerFilter (assigneeId OR
  // queues) only ever matched on direct assignment. Queue-only tasks
  // (openFromLoanDefault's 'new_unreviewed', handleReinstatementEffective's
  // 'waiting_blocked') were invisible on every work screen even though
  // task-service.ts's assertTaskAuthorized would have let this same user
  // complete them — see CurrentUser.queues's doc comment.
  const data = await withActor(db, { actorId: user.id, roles: user.roles }, (tx) =>
    buildWorkScreen(tx, { assigneeId: user.id, queues: user.queues, upcomingWithinDays: 14, today: todayIso() }),
  );
  // Real per-queue totals (data.counts), not data.queues[key].length — each
  // queue's rows are capped at 25 (docs/notion-redesign.md "My Work at
  // volume"), so the row count alone would understate a queue past 25.
  const totalCount = QUEUE_ORDER.reduce((sum, key) => sum + data.counts[key], 0);

  return (
    <>
      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--space-lg)' }}>
        <div>
          <h1 className="n-page-title">My Work</h1>
          <p className="n-page-subtitle" style={{ marginBottom: 0 }}>
            Signed in as {user.name} ({user.roles.join(', ')}) — {totalCount} item{totalCount === 1 ? '' : 's'} across all queues.
          </p>
        </div>
      </div>

      {workError && (
        <div className="n-card n-blocker-card" role="alert" style={{ marginBottom: 'var(--space-lg)' }}>
          <div className="n-blocker-reason">{workError}</div>
        </div>
      )}

      {QUEUE_ORDER.map((key) => (
        <section key={key} className="queue-section" aria-labelledby={`queue-${key}`}>
          <h2 id={`queue-${key}`} className="flex items-center gap-sm">
            {WORK_QUEUE_LABELS[key]} <span className="n-count-chip">{data.counts[key]}</span>
            {data.counts[key] > 0 && (
              <a className="n-load-more" href={issuesHrefForQueue(key, user.id)} style={{ marginTop: 0, fontSize: 12 }}>
                View all {data.counts[key]} &rarr;
              </a>
            )}
          </h2>
          {data.queues[key].length === 0 ? (
            <EmptyQueue label={WORK_QUEUE_LABELS[key]} />
          ) : (
            <div className="n-table-wrap">
              <WorkTable rows={data.queues[key]} />
            </div>
          )}
        </section>
      ))}
    </>
  );
}

function WorkTable({ rows }: { rows: WorkRow[] }) {
  return (
    <table className="n-table">
      <thead>
        <tr>
          <th scope="col">Property / State</th>
          <th scope="col">Issue type</th>
          <th scope="col">Stage</th>
          <th scope="col">Task</th>
          <th scope="col">Due date</th>
          <th scope="col">Priority</th>
          <th scope="col">Assignee</th>
          <th scope="col">Summary</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <WorkTableRow key={row.key} row={row} />
        ))}
      </tbody>
    </table>
  );
}

function WorkTableRow({ row }: { row: WorkRow }) {
  const urgency = classifyDueDate(row.dueDate);
  return (
    <tr>
      <td>
        {row.propertyLabel}
        {row.state ? `, ${row.state}` : ''}
      </td>
      <td>{row.issueType ? humanize(row.issueType) : '—'}</td>
      <td>{row.stage ? humanize(row.stage) : '—'}</td>
      <td>{row.taskLabel}</td>
      <td>
        <span className={`badge ${urgency === 'none' ? '' : urgency}`}>{formatDate(row.dueDate)}</span>
      </td>
      <td>{row.priority ? <Pill color={priorityPillColor(row.priority)}>{humanize(row.priority)}</Pill> : '—'}</td>
      <td>{row.assignee ?? (row.assigneeQueue ? humanize(row.assigneeQueue) : '—')}</td>
      <td className="summary-cell">{row.summary ?? '—'}</td>
      <td>
        <div className="flex flex-col gap-sm row-actions">
          {row.canComplete && row.taskId && (
            <form action={completeTaskAction}>
              <input type="hidden" name="taskId" value={row.taskId} />
              <input type="hidden" name="returnTo" value="/" />
              <button type="submit" className="n-btn">
                Complete
              </button>
            </form>
          )}
          {row.canReschedule && row.taskId && (
            <form action={rescheduleTaskAction} className="flex gap-sm items-center">
              <input type="hidden" name="taskId" value={row.taskId} />
              <input type="hidden" name="returnTo" value="/" />
              <label htmlFor={`reschedule-${row.taskId}`} className="visually-hidden">
                New due date for {row.taskLabel}
              </label>
              <input id={`reschedule-${row.taskId}`} type="date" name="newDueDate" className="n-input" defaultValue={row.dueDate ?? ''} />
              <button type="submit" className="n-btn">
                Reschedule
              </button>
            </form>
          )}
          {row.issueId && (
            <a className="n-btn" href={`/issues/${row.issueId}`}>
              Open case
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}
