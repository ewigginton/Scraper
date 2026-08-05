/**
 * app/issues/[id]/timeline/page.tsx — the case Timeline view (Wave 2b
 * roadmap "Issue timeline view" / "Timeline filters" / "Cleanup-timeline
 * people scope", spec §9.1/§29.11/§31.4). Chronological, newest-first
 * interleave of communications (every person linked to the case, not only
 * the current coordinator's activity — spec §9.1, via
 * lib/repositories/timeline-repo.ts's issueTimeline with
 * includeLinkedPeople ALWAYS true) plus holds/phase transitions/tasks
 * (audit_events), phase open/close, and notices.
 *
 * Filters — person(s), entry kind(s), direction, participant text, date
 * range — are a GET form; the URL IS the filter state, same idiom as
 * app/issues/page.tsx and app/people/[id]/page.tsx (no client JS required).
 * Keyset "Load more" at 50 (timeline-repo.issueTimeline's default limit).
 * Cross-matter communications — linked to a DIFFERENT issue than this one —
 * are labeled with that issue's context rather than blended in silently
 * (spec §29.1).
 */

import { eq } from 'drizzle-orm';
import { getCurrentUser } from '../../../../lib/auth/current-user.ts';
import { tryGetDb } from '../../../_lib/db.ts';
import { withActor } from '../../../../lib/db/actor-context.ts';
import { formatDateTime } from '../../../_lib/dates.ts';
import { humanize, timelineKindPillColor } from '../../../_lib/pills.ts';
import { propertyLabel } from '../../../_lib/reference-data.ts';
import { Pill } from '../../../_components/Pill.tsx';
import { AuditDiffLine } from '../../../_components/ChangeLogFeed.tsx';
import { DatabaseUnavailable } from '../../../_components/EmptyState.tsx';
import { ActivityIcon, FlowIcon, DocumentIcon } from '../../../_components/icons.tsx';
import { commIconFor } from '../../../people/_lib/comm-icons.tsx';
import * as issuesRepo from '../../../../lib/repositories/issues-repo.ts';
import * as timelineRepo from '../../../../lib/repositories/timeline-repo.ts';
import { enrichCommunicationEntries, type CommEnrichment } from '../../../../lib/repositories/people-repo.ts';
import { propertyRefs } from '../../../../lib/db/schema.ts';
import {
  ISSUE_TIMELINE_KINDS,
  ISSUE_TIMELINE_KIND_LABEL,
  buildIssueTimelineHref,
  hasActiveIssueTimelineFilters,
  parseIssueTimelineParams,
  type IssueTimelineSearchParams,
  type IssueTimelineView,
} from '../../../_lib/issue-timeline-view.ts';
import styles from './timeline.module.css';

export const metadata = { title: 'Case Timeline — CCL Hub Issues' };

const TIMELINE_LIMIT = 50;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<IssueTimelineSearchParams>;
}

export default async function IssueTimelinePage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>Timeline</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();
  const view = parseIssueTimelineParams(sp);

  const data = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const issue = await issuesRepo.getById(tx, id);
    if (!issue) return null;
    const [property] = await tx.select().from(propertyRefs).where(eq(propertyRefs.id, issue.propertyRefId));
    const timeline = await timelineRepo.issueTimeline(tx, {
      issueId: id,
      filters: {
        kinds: view.kinds.length > 0 ? view.kinds : undefined,
        personRefIds: view.personRefIds.length > 0 ? view.personRefIds : undefined,
        direction: view.direction,
        participantQuery: view.participantQuery,
        // Calendar-day bounds resolved to inclusive start/end-of-day instants
        // here — timeline-repo.TimelineFilters takes precise ISO instants,
        // same split as lib/repositories/people-repo.ts's personTimelinePage.
        fromDate: view.from ? `${view.from}T00:00:00.000Z` : undefined,
        toDate: view.to ? `${view.to}T23:59:59.999Z` : undefined,
      },
      limit: TIMELINE_LIMIT,
      cursor: view.cursor,
    });
    const enrichment = await enrichCommunicationEntries(tx, timeline.entries);
    return { issue, property, timeline, enrichment };
  });

  if (!data) {
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

  const { issue, property, timeline, enrichment } = data;

  return (
    <>
      <a className="n-btn n-btn-quiet" href={`/issues/${issue.id}`} style={{ marginBottom: 'var(--space-md)' }}>
        &larr; Back to case
      </a>

      <header className="n-card">
        <h1 className="n-page-title">Timeline — {propertyLabel(property)}</h1>
        <p className="muted" style={{ marginBottom: 0 }}>
          Every communication with every person linked to this case, plus holds, tasks, phase transitions, notices, and
          material edits (spec §9.1/§29.11) — newest first.
        </p>
      </header>

      <section className="n-card" style={{ marginTop: 'var(--space-lg)' }}>
        <TimelineFilterForm id={issue.id} people={issue.people} view={view} />

        {timeline.entries.length === 0 ? (
          <p className="muted">No timeline entries match these filters.</p>
        ) : (
          <div className={styles.feed}>
            {timeline.entries.map((entry) => (
              <TimelineEntryRow
                key={timelineRepo.timelineEntryKey(entry)}
                entry={entry}
                enrichment={enrichment.get(entry.sourceId)}
                currentIssueId={issue.id}
              />
            ))}
          </div>
        )}

        {timeline.nextCursor && (
          <a className="n-load-more" href={buildIssueTimelineHref(issue.id, sp, { after: timeline.nextCursor })}>
            Load more &darr;
          </a>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------
// Filter form — GET, URL-driven (roadmap "Timeline filters ... same
// URL-driven server-side filter pattern as /issues"; filters compose).
// ---------------------------------------------------------------------

function TimelineFilterForm({
  id,
  people,
  view,
}: {
  id: string;
  people: issuesRepo.IssuePersonWithName[];
  view: IssueTimelineView;
}) {
  const selectedKinds = new Set(view.kinds);
  return (
    <form method="get" action={`/issues/${id}/timeline`} className={styles.filterForm}>
      <div className={styles.filterField}>
        <label htmlFor="person">Person(s)</label>
        <select id="person" name="person" multiple className={`n-select ${styles.personSelect}`} defaultValue={view.personRefIds} aria-label="Filter by linked person">
          {people.length === 0 ? (
            <option disabled>No people linked to this case</option>
          ) : (
            people.map((p) => (
              <option key={p.personRefId} value={p.personRefId}>
                {p.personDisplayName ?? p.personRefId} — {humanize(p.role)}
              </option>
            ))
          )}
        </select>
      </div>

      <div className={styles.filterField}>
        <span>Entry kinds</span>
        <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
          {ISSUE_TIMELINE_KINDS.map((k) => (
            <label key={k} className="n-filter-checkbox">
              <input type="checkbox" name="kind" value={k} defaultChecked={selectedKinds.has(k)} />
              {ISSUE_TIMELINE_KIND_LABEL[k]}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.filterField}>
        <label htmlFor="direction">Direction</label>
        <select id="direction" name="direction" className="n-select" defaultValue={view.direction ?? ''}>
          <option value="">Any</option>
          <option value="inbound">Inbound</option>
          <option value="outbound">Outbound</option>
        </select>
      </div>

      <div className={styles.filterField}>
        <label htmlFor="participant">Participant</label>
        <input
          id="participant"
          type="text"
          name="participant"
          className="n-input"
          placeholder="Name, phone, or email"
          defaultValue={view.participantQuery ?? ''}
        />
      </div>

      <div className={styles.filterField}>
        <label htmlFor="from">From</label>
        <input id="from" type="date" name="from" className="n-input" defaultValue={view.from ?? ''} />
      </div>

      <div className={styles.filterField}>
        <label htmlFor="to">To</label>
        <input id="to" type="date" name="to" className="n-input" defaultValue={view.to ?? ''} />
      </div>

      <button type="submit" className="n-btn n-btn-primary">
        Apply
      </button>
      {hasActiveIssueTimelineFilters(view) && (
        <a className="n-btn n-btn-quiet" href={`/issues/${id}/timeline`}>
          Clear filters
        </a>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------
// Timeline rows
// ---------------------------------------------------------------------

function TimelineEntryRow({
  entry,
  enrichment,
  currentIssueId,
}: {
  entry: timelineRepo.TimelineEntry;
  enrichment: CommEnrichment | undefined;
  currentIssueId: string;
}) {
  if (entry.kind === 'communication') {
    return <CommunicationRow entry={entry} enrichment={enrichment} currentIssueId={currentIssueId} />;
  }

  if (entry.kind === 'audit') {
    return (
      <div className={styles.row}>
        <span className={styles.iconWrap}>
          <ActivityIcon size={14} />
        </span>
        <div>
          <div className={styles.title}>
            <Pill color={timelineKindPillColor(entry.kind)}>Change</Pill>
          </div>
          <AuditDiffLine
            fallbackLabel={entry.title}
            before={entry.before}
            after={entry.after}
            reason={entry.detail}
            actor={entry.actor}
            at={entry.at}
            showMeta={false}
          />
        </div>
        <span className={styles.time}>{formatDateTime(entry.at)}</span>
      </div>
    );
  }

  const Icon = entry.kind === 'notice' ? DocumentIcon : FlowIcon;
  return (
    <div className={styles.row}>
      <span className={styles.iconWrap}>
        <Icon size={14} />
      </span>
      <div>
        <div className={styles.title}>
          <Pill color={timelineKindPillColor(entry.kind)}>{ISSUE_TIMELINE_KIND_LABEL[entry.kind as keyof typeof ISSUE_TIMELINE_KIND_LABEL] ?? humanize(entry.kind)}</Pill>
          {entry.title}
        </div>
        {entry.detail && <div className={styles.snippet}>{entry.detail}</div>}
      </div>
      <span className={styles.time}>{formatDateTime(entry.at)}</span>
    </div>
  );
}

function CommunicationRow({
  entry,
  enrichment,
  currentIssueId,
}: {
  entry: timelineRepo.TimelineEntry;
  enrichment: CommEnrichment | undefined;
  currentIssueId: string;
}) {
  const channel = enrichment?.channel ?? 'other';
  const direction = enrichment?.direction ?? 'outbound';
  const Icon = commIconFor(channel);
  const participants = enrichment ? [enrichment.fromName, enrichment.toName].filter((n): n is string => Boolean(n)).join(' → ') : null;
  // spec §29.1: a communication linked to a DIFFERENT matter is labeled with
  // its context, never blended in silently — only OTHER issues are shown
  // here, not this page's own issue.
  const otherMatterContexts = (enrichment?.issueContexts ?? []).filter((ctx) => ctx.issueId !== currentIssueId);

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
        {otherMatterContexts.length > 0 && (
          <div className={styles.meta}>
            {otherMatterContexts.map((ctx) => (
              <Pill key={ctx.issueId} color="orange" className={styles.contextChip}>
                Also on: {ctx.label}
              </Pill>
            ))}
          </div>
        )}
      </div>
      <span className={styles.time}>{formatDateTime(entry.at)}</span>
    </div>
  );
}
