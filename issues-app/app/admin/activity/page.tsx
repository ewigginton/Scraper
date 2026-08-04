/**
 * app/admin/activity/page.tsx — Admin activity metrics (roadmap "Admin
 * activity metrics (Emma, Aug 2026): admin-role-gated view showing the
 * number of activities by user ... filterable by date range and action
 * category, with drill-down into that user's feed", spec §8.2
 * coordinator-performance reporting / §14 baseline metrics).
 *
 * Admin gate is server-side: getCurrentUser().roles must include 'admin'.
 * lib/auth/current-user.ts's dev stub never grants 'admin' outside an
 * explicit demo opt-in (see that file's doc comment) — non-admins,
 * including every standalone/dev run by default, see the quiet
 * "requires admin" card below rather than the metrics.
 *
 * Data access goes through lib/repositories/audit-metrics-repo.ts
 * (activitiesByActor — the trust boundary for the date-range/category
 * filters). This page never touches drizzle directly.
 */

import { getCurrentUser } from '../../../lib/auth/current-user.ts';
import { tryGetDb } from '../../_lib/db.ts';
import { withActor } from '../../../lib/db/actor-context.ts';
import { DatabaseUnavailable } from '../../_components/EmptyState.tsx';
import { activitiesByActor } from '../../../lib/repositories/audit-metrics-repo.ts';
import {
  ACTIVITY_CATEGORIES,
  CATEGORY_OBJECT_TABLES,
  categoryLabel,
  buildAdminActivityHref,
  mergeActorCounts,
  parseAdminActivityParams,
  resolveAdminActivityRange,
  type SearchParams,
} from '../../_lib/activity-view.ts';
import styles from './activity-admin.module.css';

export const metadata = { title: 'Admin Activity — CCL Hub Issues' };

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function AdminActivityPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const user = await getCurrentUser();

  if (!user.roles.includes('admin')) {
    return (
      <div className="card" role="status">
        <h2>Admin activity metrics</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          This view requires the admin role.
        </p>
      </div>
    );
  }

  const view = parseAdminActivityParams(sp);
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1 className={styles.title}>Admin activity metrics</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const range = resolveAdminActivityRange(view);
  const objectTables = view.category ? CATEGORY_OBJECT_TABLES[view.category] : [null];

  const rows = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const sets = await Promise.all(
      objectTables.map((table) => activitiesByActor(tx, { from: range.from, to: range.to, category: table })),
    );
    return mergeActorCounts(sets);
  });

  const maxCount = rows.reduce((max, r) => Math.max(max, r.count), 0);

  return (
    <>
      <h1 className={styles.title}>Admin activity metrics</h1>

      <div className={`card ${styles.banner}`} role="note">
        Actor identities shown here are the dev-user stub until the Hub's shared staff identity is wired in at porting — this view ships now, the
        numbers become meaningful then.
      </div>

      <FilterBar sp={sp} view={view} />

      {rows.length === 0 ? (
        <div className="card" role="status">
          <p className="muted" style={{ marginBottom: 0 }}>
            No activity in this range.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Actor</th>
                <th scope="col">Count</th>
                <th scope="col">Share</th>
                <th scope="col" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pct = maxCount > 0 ? Math.round((row.count / maxCount) * 100) : 0;
                return (
                  <tr key={row.actor}>
                    <td>{row.actor}</td>
                    <td>{row.count}</td>
                    <td>
                      <div className={styles.shareBarTrack} aria-hidden="true">
                        <div className={styles.shareBarFill} style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                    <td>
                      <a href={`/activity?actor=${encodeURIComponent(row.actor)}`}>View feed &rarr;</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function FilterBar({ sp, view }: { sp: SearchParams; view: ReturnType<typeof parseAdminActivityParams> }) {
  return (
    <form method="get" action="/admin/activity" className={`card ${styles.filterBar}`}>
      <div className="form-group">
        <label htmlFor="admin-activity-range">Date range</label>
        <select id="admin-activity-range" name="range" defaultValue={view.preset}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="admin-activity-from">From (used when range is Custom)</label>
        <input id="admin-activity-from" type="date" name="from" defaultValue={view.from ?? ''} />
      </div>

      <div className="form-group">
        <label htmlFor="admin-activity-to">To (used when range is Custom)</label>
        <input id="admin-activity-to" type="date" name="to" defaultValue={view.to ?? ''} />
      </div>

      <div className="form-group">
        <label htmlFor="admin-activity-category">Category</label>
        <select id="admin-activity-category" name="category" defaultValue={view.category ?? ''}>
          <option value="">All categories</option>
          {ACTIVITY_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
      </div>

      <div className={`flex gap-sm items-center ${styles.filterActions}`}>
        <button type="submit" className="btn primary">
          Apply
        </button>
        <a className="btn" href={buildAdminActivityHref(sp, { range: null, from: null, to: null, category: null })}>
          Reset
        </a>
      </div>
    </form>
  );
}
