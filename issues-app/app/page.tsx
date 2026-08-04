import { getCurrentUser } from '../lib/auth/current-user.ts';
import { tryGetDb } from './_lib/db.ts';
import { withActor } from '../lib/db/actor-context.ts';
import { buildWorkScreen, WORK_QUEUE_LABELS, type WorkQueueKey, type WorkRow } from './_lib/work-screen.ts';
import { classifyDueDate, formatDate, todayIso } from './_lib/dates.ts';
import { DatabaseUnavailable, EmptyQueue } from './_components/EmptyState.tsx';
import { completeTaskAction, rescheduleTaskAction } from './actions.ts';

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
  const totalCount = QUEUE_ORDER.reduce((sum, key) => sum + data.queues[key].length, 0);

  return (
    <>
      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--space-lg)' }}>
        <div>
          <h1>My Work</h1>
          <p className="muted">
            Signed in as {user.name} ({user.roles.join(', ')}) — {totalCount} item{totalCount === 1 ? '' : 's'} across all queues.
          </p>
        </div>
      </div>

      {workError && (
        <div className="card banner-error" role="alert" style={{ marginBottom: 'var(--space-lg)' }}>
          {workError}
        </div>
      )}

      {QUEUE_ORDER.map((key) => (
        <section key={key} className="queue-section" aria-labelledby={`queue-${key}`}>
          <h2 id={`queue-${key}`}>
            {WORK_QUEUE_LABELS[key]} <span className="count-badge">{data.queues[key].length}</span>
          </h2>
          {data.queues[key].length === 0 ? (
            <EmptyQueue label={WORK_QUEUE_LABELS[key]} />
          ) : (
            <div className="table-scroll">
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
    <table>
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
      <td>{row.issueType ?? '—'}</td>
      <td>{row.stage ?? '—'}</td>
      <td>{row.taskLabel}</td>
      <td>
        <span className={`badge ${urgency === 'none' ? '' : urgency}`}>{formatDate(row.dueDate)}</span>
      </td>
      <td>{row.priority ?? '—'}</td>
      <td>{row.assignee ?? '—'}</td>
      <td className="summary-cell">{row.summary ?? '—'}</td>
      <td>
        <div className="flex flex-col gap-sm row-actions">
          {row.canComplete && row.taskId && (
            <form action={completeTaskAction}>
              <input type="hidden" name="taskId" value={row.taskId} />
              <input type="hidden" name="returnTo" value="/" />
              <button type="submit" className="btn">
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
              <input id={`reschedule-${row.taskId}`} type="date" name="newDueDate" defaultValue={row.dueDate ?? ''} />
              <button type="submit" className="btn">
                Reschedule
              </button>
            </form>
          )}
          {row.issueId && (
            <a className="btn" href={`/issues/${row.issueId}`}>
              Open case
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}
