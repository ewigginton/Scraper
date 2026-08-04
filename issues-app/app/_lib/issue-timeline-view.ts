/**
 * app/_lib/issue-timeline-view.ts — URL <-> query-object plumbing for the
 * case Timeline view (app/issues/[id]/timeline/page.tsx; Wave 2b roadmap
 * "Issue timeline view" / "Timeline filters", spec §9.1/§29.11/§31.4). Pure
 * param parsing/href-building, same split as app/_lib/issues-view.ts and
 * app/_lib/activity-view.ts — lib/repositories/timeline-repo.ts's
 * TimelineFilters normalization is the actual trust boundary; every value
 * produced here is re-validated there (kinds/personRefIds/direction), so an
 * allowlist mismatch here fails closed (silently dropped), never open.
 */

export const ISSUE_TIMELINE_KINDS = ['communication', 'audit', 'phase_open', 'phase_close', 'notice'] as const;
export type IssueTimelineKind = (typeof ISSUE_TIMELINE_KINDS)[number];

export const ISSUE_TIMELINE_KIND_LABEL: Record<IssueTimelineKind, string> = {
  communication: 'Communications',
  audit: 'Changes',
  phase_open: 'Phase opened',
  phase_close: 'Phase closed',
  notice: 'Notices',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QS_LEN = 200;

export type IssueTimelineSearchParams = Record<string, string | string[] | undefined>;

export function firstString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export interface IssueTimelineView {
  kinds: IssueTimelineKind[];
  personRefIds: string[];
  direction: 'inbound' | 'outbound' | null;
  participantQuery: string | null;
  /** Calendar-day bounds (`YYYY-MM-DD`, straight from an `<input type=date>`) — the page resolves these to inclusive start/end-of-day instants before calling timeline-repo, same convention as app/people/[id]/page.tsx's `from`/`to`. */
  from: string | null;
  to: string | null;
  cursor: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeDateParam(v: string | undefined): string | null {
  const trimmed = v?.trim();
  return trimmed && DATE_RE.test(trimmed) ? trimmed : null;
}

export function parseIssueTimelineParams(sp: IssueTimelineSearchParams): IssueTimelineView {
  const kinds = toArray(sp.kind).filter((k): k is IssueTimelineKind => (ISSUE_TIMELINE_KINDS as readonly string[]).includes(k));
  const personRefIds = [...new Set(toArray(sp.person).filter((id) => UUID_RE.test(id)))];
  const directionRaw = firstString(sp.direction);
  const direction = directionRaw === 'inbound' || directionRaw === 'outbound' ? directionRaw : null;
  const participantRaw = firstString(sp.participant)?.trim().slice(0, MAX_QS_LEN);

  return {
    kinds,
    personRefIds,
    direction,
    participantQuery: participantRaw && participantRaw.length > 0 ? participantRaw : null,
    from: sanitizeDateParam(firstString(sp.from)),
    to: sanitizeDateParam(firstString(sp.to)),
    cursor: firstString(sp.after)?.slice(0, 4000) ?? null,
  };
}

export type IssueTimelineHrefOverrides = Partial<Record<'kind' | 'person' | 'direction' | 'participant' | 'from' | 'to' | 'after', string | string[] | null>>;

/** Rebuilds the timeline querystring with `overrides` merged in (`null` removes a key). Used by the "Load more" link (only `after` changes) and any future sort/kind-toggle links. */
export function buildIssueTimelineHref(issueId: string, sp: IssueTimelineSearchParams, overrides: IssueTimelineHrefOverrides = {}): string {
  const merged: IssueTimelineSearchParams = { ...sp };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v) usp.append(key, v);
    }
  }
  const qs = usp.toString();
  return qs ? `/issues/${issueId}/timeline?${qs}` : `/issues/${issueId}/timeline`;
}

export function hasActiveIssueTimelineFilters(view: IssueTimelineView): boolean {
  return view.kinds.length > 0 || view.personRefIds.length > 0 || Boolean(view.direction) || Boolean(view.participantQuery) || Boolean(view.from) || Boolean(view.to);
}
