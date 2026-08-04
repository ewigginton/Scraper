/**
 * app/people/[id]/page.tsx — the CRM stand-in person page (Wave 2 roadmap
 * "Person timeline page"; spec §9.1, §28.6, §29.11). Explicitly a stand-in
 * for the Hub's future Prospects/CRM person view — same canonical tables
 * (person_refs, issue_people, communication_events/communication_links via
 * lib/repositories/timeline-repo.ts's personTimeline), no duplicate store.
 *
 * Header (name/kind/contact/aliases) + linked issues (role + issue summary,
 * link to /issues/[id]) + the chronological TIMELINE: communications render
 * as message rows (icon by type, direction arrow, participants, snippet,
 * time); audit/issue-link entries render as plain activity rows. Filters
 * (entry kind, direction, date range) are a GET form — no client JS
 * required, same URL-driven idiom as app/issues/page.tsx. Paginated via a
 * "Load more" cursor link (lib/repositories/people-repo.ts's
 * personTimelinePage, which composes timeline-repo.personTimeline).
 */

import { getCurrentUser } from '../../../lib/auth/current-user.ts';
import { tryGetDb } from '../../_lib/db.ts';
import { withActor } from '../../../lib/db/actor-context.ts';
import { formatDateTime } from '../../_lib/dates.ts';
import { humanize } from '../../_lib/pills.ts';
import { displayableContactEntries, propertyLabel } from '../../_lib/reference-data.ts';
import { Pill } from '../../_components/Pill.tsx';
import { AuditDiffLine } from '../../_components/ChangeLogFeed.tsx';
import { DatabaseUnavailable } from '../../_components/EmptyState.tsx';
import { ActivityIcon, PersonIcon, FlowIcon } from '../../_components/icons.tsx';
import { commIconFor } from '../_lib/comm-icons.tsx';
import * as commsRepo from '../../../lib/repositories/comms-repo.ts';
import {
  getPerson,
  getPersonIssues,
  personTimelinePage,
  enrichCommunicationEntries,
  type TimelineEntry,
  type CommEnrichment,
} from '../../../lib/repositories/people-repo.ts';
import styles from './timeline.module.css';

export const metadata = { title: 'Person — CCL Hub Issues' };

const TIMELINE_LIMIT = 50;
const PERSON_KINDS = ['communication', 'audit', 'issue_link'] as const;
const KIND_LABEL: Record<(typeof PERSON_KINDS)[number], string> = {
  communication: 'Communications',
  audit: 'Changes',
  issue_link: 'Case links',
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    kind?: string | string[];
    direction?: string;
    from?: string;
    to?: string;
    after?: string;
  }>;
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function buildTimelineHref(id: string, sp: Awaited<PageProps['searchParams']>, overrides: Partial<Record<'kind' | 'direction' | 'from' | 'to' | 'after', string[] | string | null>> = {}): string {
  const params = new URLSearchParams();
  const merge = (key: 'kind' | 'direction' | 'from' | 'to' | 'after', current: string | string[] | undefined) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
    const value = override !== undefined ? override : current;
    if (value === null || value === undefined) return;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v) params.append(key, v);
    }
  };
  merge('kind', sp.kind);
  merge('direction', sp.direction);
  merge('from', sp.from);
  merge('to', sp.to);
  merge('after', sp.after);
  const qs = params.toString();
  return qs ? `/people/${id}?${qs}` : `/people/${id}`;
}

function aliasCount(aliases: unknown): number {
  if (Array.isArray(aliases)) return aliases.length;
  if (typeof aliases === 'object' && aliases !== null) return Object.keys(aliases).length;
  return 0;
}

export default async function PersonPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>Person</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();
  const kindFilter = toArray(sp.kind).filter((k): k is (typeof PERSON_KINDS)[number] => (PERSON_KINDS as readonly string[]).includes(k));
  const direction = sp.direction === 'inbound' || sp.direction === 'outbound' ? sp.direction : null;

  const data = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const person = await getPerson(tx, id);
    if (!person) return null;
    const [issueRows, timeline, commsCheck] = await Promise.all([
      getPersonIssues(tx, id),
      personTimelinePage(tx, {
        personRefId: id,
        filters: { kinds: kindFilter.length > 0 ? kindFilter : undefined, direction },
        fromDate: sp.from ?? null,
        toDate: sp.to ?? null,
        limit: TIMELINE_LIMIT,
        cursor: sp.after ?? null,
      }),
      commsRepo.listForPerson(tx, { personRefId: id, limit: 1 }),
    ]);
    const enrichment = await enrichCommunicationEntries(tx, timeline.entries);
    return { person, issueRows, timeline, enrichment, hasAnyComms: commsCheck.rows.length > 0 };
  });

  if (!data) {
    return (
      <>
        <h1>Person not found</h1>
        <p>No person exists with id {id}.</p>
        <a className="n-btn" href="/people">
          Back to People
        </a>
      </>
    );
  }

  const { person, issueRows, timeline, enrichment, hasAnyComms } = data;
  const contacts = displayableContactEntries(person.contactSnapshot);
  const aliases = aliasCount(person.aliases);

  return (
    <>
      <a className="n-btn n-btn-quiet" href="/people" style={{ marginBottom: 'var(--space-md)' }}>
        &larr; Back to People
      </a>

      <header className="n-card">
        <div className="flex justify-between items-center">
          <h1 className="n-page-title">{person.displayName}</h1>
          <Pill color={person.kind === 'org' ? 'purple' : 'blue'}>{person.kind === 'org' ? 'Organization' : 'Person'}</Pill>
        </div>
        <p className="muted" style={{ marginBottom: 'var(--space-md)' }}>
          CRM stand-in profile — stands in for the Hub&apos;s Prospects/CRM person view until it ships (spec §9.1/§29.11).
        </p>

        <dl className="n-properties">
          <div className="n-property-row">
            <span className="n-property-icon">
              <PersonIcon size={15} />
            </span>
            <span className="n-property-label">Contact</span>
            <span className="n-property-value">
              {contacts.length === 0 ? '—' : contacts.map(([k, v]) => `${humanize(k)}: ${v}`).join(' · ')}
            </span>
          </div>
          <div className="n-property-row">
            <span className="n-property-icon">
              <FlowIcon size={15} />
            </span>
            <span className="n-property-label">Aliases</span>
            <span className="n-property-value">{aliases}</span>
          </div>
          <div className="n-property-row">
            <span className="n-property-icon">
              <ActivityIcon size={15} />
            </span>
            <span className="n-property-label">Source</span>
            <span className="n-property-value">
              {person.sourceSystem}
              {person.externalId ? ` (${person.externalId})` : ''}
            </span>
          </div>
        </dl>
      </header>

      <details className="n-section" open>
        <summary>Linked issues ({issueRows.length})</summary>
        <div className="n-section-body">
          {issueRows.length === 0 ? (
            <p className="muted">No issues linked to this person.</p>
          ) : (
            <div className="n-table-wrap">
              <table className="n-table">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Issue</th>
                    <th scope="col">Property</th>
                    <th scope="col">Linked since</th>
                    <th scope="col" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {issueRows.map((row) => (
                    <tr key={row.link.id}>
                      <td>{humanize(row.link.role)}</td>
                      <td>
                        <a className="n-row-link" href={`/issues/${row.issue.id}`} aria-label={`Open issue for ${propertyLabel(row.property)}`} />
                        {row.issue.summary}
                      </td>
                      <td>{propertyLabel(row.property)}</td>
                      <td>{row.link.startDate}</td>
                      <td>
                        <div className="n-row-actions">
                          <a className="n-btn n-btn-quiet" href={`/issues/${row.issue.id}`}>
                            Open &rarr;
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details className="n-section" open>
        <summary>Timeline</summary>
        <div className="n-section-body">
          <TimelineFilterForm id={id} sp={sp} />

          {!hasAnyComms && (
            <p className="banner-warning" role="note" style={{ marginBottom: 'var(--space-md)' }}>
              No communications recorded yet — real calls/texts/emails flow in once JustCall/Gmail are integrated
              (demo: run <code>node --experimental-strip-types scripts/demo-seed-comms.ts</code>).
            </p>
          )}

          {timeline.entries.length === 0 ? (
            <p className="muted">No timeline entries match these filters.</p>
          ) : (
            <div className={styles.feed}>
              {timeline.entries.map((entry) => (
                <TimelineRow key={`${entry.sourceTable}:${entry.sourceId}:${entry.kind}`} entry={entry} enrichment={enrichment.get(entry.sourceId)} />
              ))}
            </div>
          )}

          {timeline.nextCursor && (
            <a className="n-load-more" href={buildTimelineHref(id, sp, { after: timeline.nextCursor })}>
              Load more &darr;
            </a>
          )}
        </div>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------
// Filter form — GET, URL-driven (roadmap: "timeline filters ... same
// URL-driven server-side filter pattern as /issues").
// ---------------------------------------------------------------------

function TimelineFilterForm({ id, sp }: { id: string; sp: Awaited<PageProps['searchParams']> }) {
  const selectedKinds = new Set(toArray(sp.kind));
  return (
    <form method="get" action={`/people/${id}`} className={styles.filterForm}>
      <div className={styles.filterField}>
        <span>Entry kinds</span>
        <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
          {PERSON_KINDS.map((k) => (
            <label key={k} className="n-filter-checkbox">
              <input type="checkbox" name="kind" value={k} defaultChecked={selectedKinds.has(k)} />
              {KIND_LABEL[k]}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.filterField}>
        <label htmlFor="direction">Direction</label>
        <select id="direction" name="direction" className="n-select" defaultValue={sp.direction ?? ''}>
          <option value="">Any</option>
          <option value="inbound">Inbound</option>
          <option value="outbound">Outbound</option>
        </select>
      </div>

      <div className={styles.filterField}>
        <label htmlFor="from">From</label>
        <input id="from" type="date" name="from" className="n-input" defaultValue={sp.from ?? ''} />
      </div>

      <div className={styles.filterField}>
        <label htmlFor="to">To</label>
        <input id="to" type="date" name="to" className="n-input" defaultValue={sp.to ?? ''} />
      </div>

      <button type="submit" className="n-btn n-btn-primary">
        Apply
      </button>
      {(selectedKinds.size > 0 || sp.direction || sp.from || sp.to) && (
        <a className="n-btn n-btn-quiet" href={`/people/${id}`}>
          Clear filters
        </a>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------
// Timeline rows
// ---------------------------------------------------------------------

function TimelineRow({ entry, enrichment }: { entry: TimelineEntry; enrichment: CommEnrichment | undefined }) {
  if (entry.kind === 'communication') {
    return <CommunicationRow entry={entry} enrichment={enrichment} />;
  }
  if (entry.kind === 'audit') {
    // Reuses ChangeLogFeed's plain-English diff renderer (Wave 2b) instead of
    // this page re-deriving its own — see that module's header doc comment.
    // TimelineEntry.detail for an 'audit' kind is already the audit row's
    // `reason` (timeline-repo.ts's auditEntryFrom), so it's passed as
    // `reason`, not `detail`.
    return (
      <div className={styles.row}>
        <span className={styles.iconWrap}>
          <ActivityIcon size={14} />
        </span>
        <div>
          <div className={styles.title}>
            <Pill color="gray">Change</Pill>
          </div>
          <AuditDiffLine fallbackLabel={entry.title} before={entry.before} after={entry.after} reason={entry.detail} actor={entry.actor} at={entry.at} showMeta={false} />
        </div>
        <span className={styles.time}>{formatDateTime(entry.at)}</span>
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <span className={styles.iconWrap}>
        <PersonIcon size={14} />
      </span>
      <div>
        <div className={styles.title}>
          <Pill color="blue">Case link</Pill>
          {entry.title}
        </div>
        {entry.detail && <div className={styles.snippet}>{entry.detail}</div>}
      </div>
      <span className={styles.time}>{formatDateTime(entry.at)}</span>
    </div>
  );
}

function CommunicationRow({ entry, enrichment }: { entry: TimelineEntry; enrichment: CommEnrichment | undefined }) {
  const channel = enrichment?.channel ?? 'other';
  const direction = enrichment?.direction ?? 'outbound';
  const Icon = commIconFor(channel);
  const participants = enrichment ? [enrichment.fromName, enrichment.toName].filter((n): n is string => Boolean(n)).join(' → ') : null;

  return (
    <div className={styles.row}>
      <span className={styles.iconWrap}>
        <Icon size={14} />
      </span>
      <div>
        <div className={styles.title}>
          <Pill color="green">{humanize(channel)}</Pill>
          <span className={`${styles.direction} ${direction === 'inbound' ? styles.inbound : styles.outbound}`}>{humanize(direction)}</span>
          {participants && <span className="muted">{participants}</span>}
        </div>
        {entry.detail && <div className={styles.snippet}>{entry.detail}</div>}
        {enrichment && enrichment.issueContexts.length > 0 && (
          <div className={styles.meta}>
            {enrichment.issueContexts.map((ctx) => (
              <Pill key={ctx.issueId} color="orange" className={styles.contextChip}>
                Re: {ctx.label}
              </Pill>
            ))}
          </div>
        )}
      </div>
      <span className={styles.time}>{formatDateTime(entry.at)}</span>
    </div>
  );
}
