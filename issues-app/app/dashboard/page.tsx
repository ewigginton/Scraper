/**
 * app/dashboard/page.tsx — General Issues dashboard (spec §8.2: "open
 * issues by type/stage/state/coordinator, open/past-due tasks by
 * coordinator, aging, bottlenecks, off-market properties"). Server-rendered,
 * CSS-only bars (no chart library — see dashboard.module.css's .barFill).
 *
 * Every aggregate comes from lib/repositories/dashboard-repo.ts's bounded
 * single-pass GROUP BY queries — this page does no counting/grouping of
 * its own. Each bar/stat links into /issues (or, where no equivalent
 * /issues filter exists, is left unlinked — see the "Off-market by hold
 * type" section below) using the SAME URL contract app/_lib/issues-view.ts's
 * buildIssuesHref already establishes for /issues: type, status, state,
 * priority, owner, overdue.
 */

import { getCurrentUser } from '../../lib/auth/current-user.ts';
import { tryGetDb } from '../_lib/db.ts';
import { withActor } from '../../lib/db/actor-context.ts';
import { humanize } from '../_lib/pills.ts';
import { buildIssuesHref } from '../_lib/issues-view.ts';
import { DatabaseUnavailable } from '../_components/EmptyState.tsx';
import {
  activeHoldPropertyCount,
  activeHoldPropertyCountsByType,
  agingBucketsOfOpenIssues,
  AGING_BUCKETS,
  issuesByLifecycleStatus,
  openIssuesByCoordinatorOrQueue,
  openIssuesByState,
  openIssuesByType,
  overdueTaskCountsByCoordinator,
  type AgingBucketKey,
  type CountRow,
} from '../../lib/repositories/dashboard-repo.ts';
import styles from './dashboard.module.css';

export const metadata = { title: 'Dashboard — CCL Hub Issues' };

/** Aging bucket -> the /issues sort override that best approximates "show me these issues" — the /issues URL contract (type/status/state/priority/owner/overdue) has no created-date-range filter, so this links via sort=created_at instead of an exact bucket filter (documented gap, not a silently invented param). */
const AGING_BUCKET_SORT: Record<AgingBucketKey, { sort: string; dir: string }> = {
  '0-7': { sort: 'created_at', dir: 'desc' },
  '8-30': { sort: 'created_at', dir: 'desc' },
  '31-90': { sort: 'created_at', dir: 'asc' },
  '90+': { sort: 'created_at', dir: 'asc' },
};

const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  '0-7': '0–7 days',
  '8-30': '8–30 days',
  '31-90': '31–90 days',
  '90+': '90+ days',
};

export default async function DashboardPage() {
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1 className={styles.title}>Dashboard</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();

  const data = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const [byType, byLifecycle, byState, byOwner, overdueByOwner, aging, holdCounts, holdTotal] = await Promise.all([
      openIssuesByType(tx),
      issuesByLifecycleStatus(tx),
      openIssuesByState(tx),
      openIssuesByCoordinatorOrQueue(tx),
      overdueTaskCountsByCoordinator(tx),
      agingBucketsOfOpenIssues(tx),
      activeHoldPropertyCountsByType(tx),
      activeHoldPropertyCount(tx),
    ]);
    return { byType, byLifecycle, byState, byOwner, overdueByOwner, aging, holdCounts, holdTotal };
  });

  const agingRows: CountRow[] = AGING_BUCKETS.map((key) => ({ key, count: data.aging[key] }));
  const maxAging = Math.max(1, ...agingRows.map((r) => r.count));

  return (
    <>
      <h1 className={styles.title}>Dashboard</h1>
      <p className="muted">Open issues, tasks, and off-market properties across the whole board.</p>

      <div className={styles.grid}>
        <BarPanel
          title="Open issues by type"
          rows={data.byType}
          labelFor={humanize}
          hrefFor={(key) => buildIssuesHref({}, { type: key })}
        />
        <BarPanel
          title="Issues by lifecycle status"
          rows={data.byLifecycle}
          labelFor={humanize}
          hrefFor={(key) => buildIssuesHref({}, { status: key })}
        />
        <BarPanel
          title="Open issues by state"
          rows={data.byState}
          labelFor={(k) => k}
          hrefFor={(key) => (key === 'Unknown' ? null : buildIssuesHref({}, { state: key }))}
        />
        <BarPanel
          title="Open issues by coordinator / queue"
          rows={data.byOwner}
          labelFor={humanize}
          hrefFor={(key) => (key === 'Unassigned' ? null : buildIssuesHref({}, { owner: key }))}
        />
        <BarPanel
          title="Overdue tasks by coordinator / queue"
          rows={data.overdueByOwner}
          labelFor={humanize}
          hrefFor={(key) => (key === 'Unassigned' ? null : buildIssuesHref({}, { owner: key, overdue: '1' }))}
          emptyMessage="No overdue tasks."
          tone="danger"
        />

        <section className={styles.panel} aria-labelledby="aging-title">
          <h2 id="aging-title" className={styles.panelTitle}>
            Aging of open issues (days since created)
          </h2>
          <ul className={styles.barList}>
            {agingRows.map((row) => (
              <BarRow
                key={row.key}
                label={AGING_BUCKET_LABELS[row.key as AgingBucketKey]}
                count={row.count}
                max={maxAging}
                href={buildIssuesHref({}, { sort: AGING_BUCKET_SORT[row.key as AgingBucketKey].sort, dir: AGING_BUCKET_SORT[row.key as AgingBucketKey].dir })}
                tone={row.key === '90+' ? 'danger' : row.key === '31-90' ? 'warn' : undefined}
              />
            ))}
          </ul>
        </section>

        <section className={styles.panel} aria-labelledby="offmarket-title">
          <h2 id="offmarket-title" className={styles.panelTitle}>
            Off-market: active holds by type
          </h2>
          <div className={styles.headline}>
            <span className={styles.headlineNumber}>{data.holdTotal}</span>
            <span className="muted">propert{data.holdTotal === 1 ? 'y' : 'ies'} with at least one active hold</span>
          </div>
          {data.holdCounts.length === 0 ? (
            <p className={`muted ${styles.emptyPanel}`}>No active holds.</p>
          ) : (
            <ul className={styles.barList}>
              {data.holdCounts.map((row) => {
                const max = Math.max(1, ...data.holdCounts.map((r) => r.count));
                return <BarRow key={row.key} label={humanize(row.key)} count={row.count} max={max} href={null} />;
              })}
            </ul>
          )}
          <p className="muted" style={{ marginBottom: 0, fontSize: 'var(--font-size-sm)' }}>
            Property count by hold type; a property with two active hold types counts under each. No /issues filter
            corresponds to hold type today, so these rows are not clickable.
          </p>
        </section>
      </div>
    </>
  );
}

function BarPanel({
  title,
  rows,
  labelFor,
  hrefFor,
  emptyMessage = 'Nothing here.',
  tone,
}: {
  title: string;
  rows: CountRow[];
  labelFor: (key: string) => string;
  hrefFor: (key: string) => string | null;
  emptyMessage?: string;
  tone?: 'warn' | 'danger';
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className={styles.panel} aria-label={title}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {rows.length === 0 ? (
        <p className={`muted ${styles.emptyPanel}`}>{emptyMessage}</p>
      ) : (
        <ul className={styles.barList}>
          {rows.map((row) => (
            <BarRow key={row.key} label={labelFor(row.key)} count={row.count} max={max} href={hrefFor(row.key)} tone={tone} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BarRow({
  label,
  count,
  max,
  href,
  tone,
}: {
  label: string;
  count: number;
  max: number;
  href: string | null;
  tone?: 'warn' | 'danger';
}) {
  const pct = Math.max(2, Math.round((count / max) * 100));
  const body = (
    <>
      <div className={styles.barHead}>
        <span className={styles.barLabel}>{label}</span>
        <span className={styles.barCount}>{count}</span>
      </div>
      <div className={styles.barTrack}>
        <div className={`${styles.barFill} ${tone ? styles[tone] : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </>
  );
  return (
    <li>
      {href ? (
        <a className={styles.barRow} href={href}>
          {body}
        </a>
      ) : (
        <div className={styles.barRow}>{body}</div>
      )}
    </li>
  );
}
