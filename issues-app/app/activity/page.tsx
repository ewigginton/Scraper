/**
 * app/activity/page.tsx — Global Activity feed (roadmap "Global Activity
 * feed": "recent changes across all records, filterable by case / person /
 * action category, bounded queries"). Server-rendered, fully URL-driven GET
 * form (same no-client-JS-required pattern as app/issues/page.tsx's filter
 * bar), keyset-paginated 50 rows at a time.
 *
 * Data access goes through lib/repositories/audit-metrics-repo.ts
 * (recentActivity — the trust boundary for filters/cursor) plus
 * lib/repositories/activity-issue-link-repo.ts (best-effort issue-link
 * resolution for the page's own rows only, never a separate unbounded
 * read). This page never touches drizzle directly.
 */

import { getCurrentUser } from '../../lib/auth/current-user.ts';
import { tryGetDb } from '../_lib/db.ts';
import { withActor } from '../../lib/db/actor-context.ts';
import { formatDateTime } from '../_lib/dates.ts';
import { humanize } from '../_lib/pills.ts';
import { DatabaseUnavailable } from '../_components/EmptyState.tsx';
import { recentActivity } from '../../lib/repositories/audit-metrics-repo.ts';
import { resolveIssueLinks } from '../../lib/repositories/activity-issue-link-repo.ts';
import {
  ACTIVITY_CATEGORIES,
  CATEGORY_OBJECT_TABLES,
  categoryLabel,
  buildActivityHref,
  parseActivityFeedParams,
  type SearchParams,
} from '../_lib/activity-view.ts';
import styles from './activity.module.css';

export const metadata = { title: 'Activity — CCL Hub Issues' };

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function ActivityPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const view = parseActivityFeedParams(sp);
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1 className={styles.title}>Activity</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();
  const objectTables = view.category ? CATEGORY_OBJECT_TABLES[view.category] : undefined;

  const result = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const feed = await recentActivity(tx, {
      filters: { objectTables, actor: view.actor, from: view.from, to: view.to },
      cursor: view.cursor,
    });
    const links = await resolveIssueLinks(tx, feed.rows);
    return { feed, links };
  });

  return (
    <>
      <h1 className={styles.title}>Activity</h1>
      <p className="muted">Recent changes across all records.</p>

      <FilterBar sp={sp} view={view} />

      {result.feed.rows.length === 0 ? (
        <div className="card" role="status">
          <p className="muted" style={{ marginBottom: 0 }}>
            No activity matches these filters.
          </p>
        </div>
      ) : (
        <ul className={styles.feed}>
          {result.feed.rows.map((row) => {
            const link = result.links.get(row.id);
            const actor = row.actorExternalId ?? row.actorId ?? 'unattributed';
            return (
              <li key={row.id} className={styles.feedRow}>
                <div className={styles.feedLine}>
                  <span className="badge">{humanize(row.objectTable)}</span>
                  <span>
                    <strong>{humanize(row.action)}</strong> on {humanize(row.objectTable)} &mdash; {actor}, {formatDateTime(row.occurredAt)}
                  </span>
                </div>
                {row.reason && <div className={`muted ${styles.reason}`}>Reason: {row.reason}</div>}
                {link && (
                  <div className={styles.linkRow}>
                    <a href={`/issues/${link.issueId}`}>View case{link.issueSummary ? `: ${link.issueSummary}` : ''} &rarr;</a>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {result.feed.nextCursor && (
        <a className="btn" href={buildActivityHref(sp, { after: result.feed.nextCursor })}>
          Load next 50 &darr;
        </a>
      )}
    </>
  );
}

function FilterBar({ sp, view }: { sp: SearchParams; view: ReturnType<typeof parseActivityFeedParams> }) {
  return (
    <form method="get" action="/activity" className={`card ${styles.filterBar}`}>
      <div className="form-group">
        <label htmlFor="activity-category">Action category</label>
        <select id="activity-category" name="category" defaultValue={view.category ?? ''}>
          <option value="">All categories</option>
          {ACTIVITY_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="activity-actor">Actor</label>
        <input id="activity-actor" type="text" name="actor" defaultValue={view.actor ?? ''} placeholder="Actor identity" />
      </div>

      <div className="form-group">
        <label htmlFor="activity-from">From</label>
        <input id="activity-from" type="datetime-local" name="from" defaultValue={view.from ?? ''} />
      </div>

      <div className="form-group">
        <label htmlFor="activity-to">To</label>
        <input id="activity-to" type="datetime-local" name="to" defaultValue={view.to ?? ''} />
      </div>

      <div className={`flex gap-sm items-center ${styles.filterActions}`}>
        <button type="submit" className="btn primary">
          Apply
        </button>
        <a className="btn" href={buildActivityHref(sp, { category: null, actor: null, from: null, to: null, after: null })}>
          Clear filters
        </a>
      </div>
    </form>
  );
}
