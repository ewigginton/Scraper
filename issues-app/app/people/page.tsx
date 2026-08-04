/**
 * app/people/page.tsx — the people index (Wave 2 roadmap "Person timeline
 * page"; spec §9.1 CRM communications and people). Server-rendered, URL-
 * driven search + pagination, same idiom as app/issues/page.tsx: a plain GET
 * form for `q`, a plain `<a>` for "Load more" carrying the opaque cursor —
 * no client JS required.
 *
 * Data access goes through lib/repositories/people-repo.ts's searchPeople
 * (ILIKE search + one aggregated linked-issue-count query for the page).
 */

import { getCurrentUser } from '../../lib/auth/current-user.ts';
import { tryGetDb } from '../_lib/db.ts';
import { withActor } from '../../lib/db/actor-context.ts';
import { Pill } from '../_components/Pill.tsx';
import { DatabaseUnavailable } from '../_components/EmptyState.tsx';
import { searchPeople, type PersonListRow } from '../../lib/repositories/people-repo.ts';

export const metadata = { title: 'People — CCL Hub Issues' };

interface PageProps {
  searchParams: Promise<{ q?: string | string[]; after?: string | string[] }>;
}

function firstString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function contactSummary(row: PersonListRow['person']): string {
  const snapshot = row.contactSnapshot as Record<string, unknown> | null | undefined;
  const phone = typeof snapshot?.phone === 'string' ? snapshot.phone : null;
  const email = typeof snapshot?.email === 'string' ? snapshot.email : null;
  const parts = [phone, email].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function peopleHref(q: string | undefined, after: string | null): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (after) params.set('after', after);
  const qs = params.toString();
  return qs ? `/people?${qs}` : '/people';
}

export default async function PeoplePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const q = firstString(sp.q);
  const after = firstString(sp.after) ?? null;
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>People</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();
  const result = await withActor(db, { actorId: user.id, roles: user.roles }, (tx) => searchPeople(tx, { q, cursor: after, limit: 50 }));

  return (
    <>
      <div className="n-toolbar">
        <div>
          <h1 className="n-page-title">People</h1>
          <span className="muted">CRM stand-in — every person_ref known to Issues, standing in for the Hub&apos;s Prospects/CRM person view.</span>
        </div>
      </div>

      <form method="get" action="/people" className="n-filter-bar" style={{ marginTop: 'var(--space-md)' }}>
        <input
          type="search"
          name="q"
          className="n-input"
          style={{ minWidth: '16rem' }}
          placeholder="Search by name..."
          defaultValue={q ?? ''}
          aria-label="Search people"
        />
        <button type="submit" className="n-btn n-btn-primary">
          Search
        </button>
        {q && (
          <a className="n-btn n-btn-quiet" href="/people">
            Clear
          </a>
        )}
      </form>

      {result.rows.length === 0 ? (
        <div className="n-card" role="status">
          <p className="muted" style={{ marginBottom: 0 }}>
            {q ? `No people match "${q}".` : 'No people recorded yet.'}
          </p>
        </div>
      ) : (
        <>
          <div className="n-table-wrap">
            <table className="n-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Linked issues</th>
                  <th scope="col" aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.person.id}>
                    <td>
                      <a className="n-row-link" href={`/people/${row.person.id}`} aria-label={`Open person ${row.person.displayName}`} />
                      {row.person.displayName}
                    </td>
                    <td>
                      <Pill color={row.person.kind === 'org' ? 'purple' : 'blue'}>{row.person.kind === 'org' ? 'Organization' : 'Person'}</Pill>
                    </td>
                    <td>{contactSummary(row.person)}</td>
                    <td>{row.linkedIssueCount}</td>
                    <td>
                      <div className="n-row-actions">
                        <a className="n-btn n-btn-quiet" href={`/people/${row.person.id}`}>
                          Open &rarr;
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.nextCursor && (
            <a className="n-load-more" href={peopleHref(q, result.nextCursor)}>
              Load next 50 &darr;
            </a>
          )}
        </>
      )}
    </>
  );
}
