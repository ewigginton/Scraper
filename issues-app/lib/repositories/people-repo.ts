/**
 * people-repo — read-only DB access backing the /people index and /people/[id]
 * "CRM stand-in" person page (Wave 2 roadmap "Person timeline page"; spec
 * §9.1 "CRM communications and people", §29.11 shared record-timeline).
 *
 * This module is deliberately NEW (does not edit lib/repositories/timeline-repo.ts
 * or comms-repo.ts, both out of this lane's assigned paths — see this app's
 * concurrency rules): it composes those existing repos plus a few bounded
 * queries of its own (search, linked-issue lookups, and a small
 * TimelineEntry-enrichment step for the comm-row UI) rather than modifying
 * them. No business rules live here (DESIGN.md §6) — reads only.
 */

import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import {
  communicationEvents,
  communicationLinks,
  issuePeople,
  issues,
  personRefs,
  propertyRefs,
  type Issue,
  type IssuePerson,
  type PersonRef,
  type PropertyRef,
} from '../db/schema.ts';
import * as timelineRepo from './timeline-repo.ts';
import type { TimelineEntry, TimelineFilters, TimelineResult } from './timeline-repo.ts';
import { clampLimit } from './keyset-cursor.ts';
import { isUuid, sanitizeUuidArray } from './id-guard.ts';

const MAX_STRING_LEN = 200;
const LINKED_ISSUES_LIMIT = 200;
const ENRICH_ID_LIMIT = 250;

// ---------------------------------------------------------------------
// searchPeople — /people index
// ---------------------------------------------------------------------

export interface SearchPeopleParams {
  /** Free-text (spec §15 "search by person, phone/email"), matched via ILIKE substring against display_name and contact_snapshot's phone/email fields. */
  q?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface PersonListRow {
  person: PersonRef;
  linkedIssueCount: number;
}

export interface SearchPeopleResult {
  rows: PersonListRow[];
  nextCursor: string | null;
}

/** Opaque [display_name, id] keyset cursor, same base64url-JSON idiom as issues-query-repo.ts's own encode/decode — a local copy rather than reusing lib/repositories/keyset-cursor.ts, whose decodeCursor rejects any non-timestamp `at` value (this sorts by a plain text column). */
function encodePeopleCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id]), 'utf8').toString('base64url');
}

function decodePeopleCursor(raw: string | null | undefined): { sortValue: string; id: string } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [sortValue, id] = parsed as [unknown, unknown];
    if (typeof sortValue !== 'string' || typeof id !== 'string' || !isUuid(id)) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

function sanitizeQuery(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping the NUL byte Postgres text columns reject outright, same rationale as issues-query-repo.ts's stripNulBytes.
  const trimmed = input.replace(/\x00/g, '').trim().slice(0, MAX_STRING_LEN);
  return trimmed.length > 0 ? trimmed : null;
}

/** Searchable, keyset-paginated person_refs list (spec: "/people index — searchable, table of person_refs"). Ordered by display_name asc, id asc. */
export async function searchPeople(db: DbHandle, params: SearchPeopleParams = {}): Promise<SearchPeopleResult> {
  const q = sanitizeQuery(params.q);
  const limit = clampLimit(params.limit, 50);
  const cursor = decodePeopleCursor(params.cursor);

  const conditions: SQL[] = [];
  if (q) {
    const like = `%${q}%`;
    conditions.push(
      sql`(
        ${personRefs.displayName} ilike ${like}
        or ${personRefs.contactSnapshot} ->> 'phone' ilike ${like}
        or ${personRefs.contactSnapshot} ->> 'email' ilike ${like}
      )`,
    );
  }
  if (cursor) {
    conditions.push(
      sql`((${personRefs.displayName} > ${cursor.sortValue}) OR (${personRefs.displayName} = ${cursor.sortValue} AND ${personRefs.id} > ${cursor.id}::uuid))`,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(personRefs)
    .where(where)
    .orderBy(asc(personRefs.displayName), asc(personRefs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodePeopleCursor(last.displayName, last.id) : null;

  if (page.length === 0) return { rows: [], nextCursor };

  // ONE aggregated query for the page's linked-issue counts (never per-row).
  const ids = page.map((p) => p.id);
  const countRows = await db
    .select({ personRefId: issuePeople.personRefId, value: count() })
    .from(issuePeople)
    .where(inArray(issuePeople.personRefId, ids))
    .groupBy(issuePeople.personRefId);
  const countByPerson = new Map(countRows.map((r) => [r.personRefId, r.value]));

  return {
    rows: page.map((person) => ({ person, linkedIssueCount: countByPerson.get(person.id) ?? 0 })),
    nextCursor,
  };
}

// ---------------------------------------------------------------------
// getPerson / getPersonIssues — /people/[id] header + linked issues
// ---------------------------------------------------------------------

export async function getPerson(db: DbHandle, id: string): Promise<PersonRef | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(personRefs).where(eq(personRefs.id, id)).limit(1);
  return row ?? null;
}

export interface PersonIssueRow {
  link: IssuePerson;
  issue: Issue;
  property: PropertyRef;
}

/** This person's linked issues (role + issue + property, for display + link to /issues/[id]), newest link first, bounded. */
export async function getPersonIssues(db: DbHandle, personRefId: string): Promise<PersonIssueRow[]> {
  if (!isUuid(personRefId)) return [];
  const rows = await db
    .select({ link: issuePeople, issue: issues, property: propertyRefs })
    .from(issuePeople)
    .innerJoin(issues, eq(issuePeople.issueId, issues.id))
    .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
    .where(eq(issuePeople.personRefId, personRefId))
    .orderBy(desc(issuePeople.startDate), desc(issuePeople.id))
    .limit(LINKED_ISSUES_LIMIT);
  return rows;
}

// ---------------------------------------------------------------------
// personTimelinePage — thin wrapper over timeline-repo.personTimeline that
// adds an in-memory date-range filter (roadmap: "filter controls ... date
// range"; timeline-repo.TimelineFilters has no date-range field — see that
// module's doc comment, out of this lane's assigned paths to extend). The
// underlying query is still ORDER BY + LIMIT + bounded per source; the date
// bound only trims the already-bounded page in memory, so a narrow range can
// legitimately return fewer rows than `limit` without that meaning "no more
// pages" — callers should keep following nextCursor regardless.
// ---------------------------------------------------------------------

export interface PersonTimelinePageParams {
  personRefId: string;
  filters?: TimelineFilters;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number | null;
  cursor?: string | null;
}

function parseDateBound(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

export async function personTimelinePage(db: DbHandle, params: PersonTimelinePageParams): Promise<TimelineResult> {
  const result = await timelineRepo.personTimeline(db, {
    personRefId: params.personRefId,
    filters: params.filters,
    limit: params.limit,
    cursor: params.cursor,
  });

  const fromMs = parseDateBound(params.fromDate);
  // toDate is a calendar day boundary — treat it as inclusive through end-of-day.
  const toMs = parseDateBound(params.toDate ? `${params.toDate}T23:59:59.999Z` : null);
  if (fromMs === null && toMs === null) return result;

  const entries = result.entries.filter((e) => {
    const t = e.at.getTime();
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  });
  return { entries, nextCursor: result.nextCursor };
}

// ---------------------------------------------------------------------
// enrichCommunicationEntries — per-page lookup of channel/direction/
// participants/issue-context for the 'communication'-kind TimelineEntry rows
// on a page, so the UI can render real message rows (icon by type, direction
// arrow, participants, cross-matter issue-context labels) instead of just
// the generic title/detail text. ONE bounded query per page (capped ids),
// never per-row.
// ---------------------------------------------------------------------

export interface CommEnrichment {
  channel: string;
  direction: string;
  fromName: string | null;
  toName: string | null;
  /** Issue(s) this communication is linked to via communication_links, for "regarding <issue>" labeling — every issue link is shown, since a person page has no single "current matter" baseline the way an issue page does (roadmap: "cross-matter entries labeled with their issue context"). */
  issueContexts: Array<{ issueId: string; label: string }>;
}

export async function enrichCommunicationEntries(db: DbHandle, entries: TimelineEntry[]): Promise<Map<string, CommEnrichment>> {
  const commEntries = entries.filter((e) => e.kind === 'communication' && e.sourceTable === 'communication_events');
  const ids = sanitizeUuidArray(commEntries.map((e) => e.sourceId)).slice(0, ENRICH_ID_LIMIT);
  if (ids.length === 0) return new Map();

  const [eventRows, linkRows] = await Promise.all([
    db.select().from(communicationEvents).where(inArray(communicationEvents.id, ids)),
    db
      .select({ communicationEventId: communicationLinks.communicationEventId, issueId: communicationLinks.issueId })
      .from(communicationLinks)
      .where(and(inArray(communicationLinks.communicationEventId, ids), sql`${communicationLinks.issueId} is not null`)),
  ]);

  const linkedIssueIds = sanitizeUuidArray(linkRows.map((l) => l.issueId));
  const [issueRows, personIdRows] = await Promise.all([
    linkedIssueIds.length > 0
      ? db
          .select({ issue: issues, property: propertyRefs })
          .from(issues)
          .innerJoin(propertyRefs, eq(issues.propertyRefId, propertyRefs.id))
          .where(inArray(issues.id, linkedIssueIds))
      : Promise.resolve([]),
    Promise.resolve(
      sanitizeUuidArray([...eventRows.map((r) => r.fromPersonRefId), ...eventRows.map((r) => r.toPersonRefId)]),
    ),
  ]);
  const personRows = personIdRows.length > 0 ? await db.select().from(personRefs).where(inArray(personRefs.id, personIdRows)) : [];

  const issueLabelById = new Map(issueRows.map((r) => [r.issue.id, r.property.displayName ?? r.issue.summary ?? r.issue.id]));
  const personNameById = new Map(personRows.map((p) => [p.id, p.displayName]));
  const issueIdsByEvent = new Map<string, string[]>();
  for (const link of linkRows) {
    if (!link.issueId) continue;
    const list = issueIdsByEvent.get(link.communicationEventId) ?? [];
    list.push(link.issueId);
    issueIdsByEvent.set(link.communicationEventId, list);
  }

  const out = new Map<string, CommEnrichment>();
  for (const event of eventRows) {
    out.set(event.id, {
      channel: event.channel,
      direction: event.direction,
      fromName: event.fromPersonRefId ? (personNameById.get(event.fromPersonRefId) ?? null) : null,
      toName: event.toPersonRefId ? (personNameById.get(event.toPersonRefId) ?? null) : null,
      issueContexts: (issueIdsByEvent.get(event.id) ?? []).map((issueId) => ({
        issueId,
        label: issueLabelById.get(issueId) ?? issueId,
      })),
    });
  }
  return out;
}

// Re-exported so pages can import everything person-timeline-related from
// this one module.
export type { TimelineEntry, TimelineFilters, TimelineResult };
