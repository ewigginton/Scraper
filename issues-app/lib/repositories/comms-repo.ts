/**
 * comms-repo — all DB access for the shared `communication_events` +
 * `communication_links` tables (spec §28.6, §9.1). No content is ever
 * copied: one communication_events row may be linked to many
 * issues/tasks/people via communication_links, and this module always reads
 * through those links rather than duplicating rows.
 *
 * Schema note (read EXACTLY off supabase/migrations/20260731090100_issues_
 * work_platform.sql + lib/db/schema.ts, not assumed): communication_events
 * has NO `participants` jsonb column. Participants are two FKs —
 * `from_person_ref_id` / `to_person_ref_id` — onto `person_refs`, whose own
 * `contact_snapshot` jsonb (`{phone, email}`) is where free-text participant
 * search (name/phone/email) actually has to join. Every "participant"
 * reference in this file means that representation, not a jsonb array on
 * the event row itself.
 *
 * No business rules live here (DESIGN.md §6) — just reads.
 */

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import {
  communicationEvents,
  communicationLinks,
  issuePeople,
  personRefs,
  type CommunicationChannel,
  type CommunicationDirection,
  type CommunicationEvent,
} from '../db/schema.ts';
import { clampLimit, decodeCursor, encodeCursor } from './keyset-cursor.ts';
import { isUuid, sanitizeUuidArray } from './id-guard.ts';

// ---------------------------------------------------------------------
// Allowlists (mirrors the DB CHECK constraints — see lib/db/schema.ts's
// own comment on why these literal sets are duplicated at the app layer
// rather than introspected from the CHECK constraint).
// ---------------------------------------------------------------------

const VALID_CHANNELS = new Set<CommunicationChannel>(['call', 'text', 'email', 'voicemail', 'notice', 'other']);
const VALID_DIRECTIONS = new Set<CommunicationDirection>(['inbound', 'outbound']);

const MAX_STRING_LEN = 200;
const LINKED_PEOPLE_LIMIT = 500;

interface SanitizedArrayFilter<T extends string> {
  requested: boolean;
  values: T[];
}

/** Same "requested but nothing valid -> match nothing" distinction as issues-query-repo.ts's sanitizeStringArray. */
function sanitizeChannels(input: unknown): SanitizedArrayFilter<CommunicationChannel> {
  if (!Array.isArray(input)) return { requested: false, values: [] };
  const values = new Set<CommunicationChannel>();
  for (const raw of input) {
    if (typeof raw === 'string' && VALID_CHANNELS.has(raw as CommunicationChannel)) {
      values.add(raw as CommunicationChannel);
    }
  }
  return { requested: input.length > 0, values: [...values] };
}

function sanitizeDirection(input: unknown): CommunicationDirection | null {
  return typeof input === 'string' && VALID_DIRECTIONS.has(input as CommunicationDirection) ? (input as CommunicationDirection) : null;
}

function sanitizeParticipantQuery(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, MAX_STRING_LEN);
  return trimmed.length > 0 ? trimmed : null;
}

function impossibleIfEmpty<T extends string>(field: SanitizedArrayFilter<T>): SQL | undefined {
  return field.requested && field.values.length === 0 ? sql`false` : undefined;
}

/** Cursor tie-break for communication_events is always its own uuid id — reject anything else instead of letting a stale/foreign cursor reach a `::uuid` cast. */
function validCommsCursor(raw: string | null | undefined): { at: string; id: string } | null {
  const decoded = decodeCursor(raw);
  if (!decoded || !isUuid(decoded.tie)) return null;
  return { at: decoded.at, id: decoded.tie };
}

function keysetPredicate(cursor: { at: string; id: string }): SQL {
  return sql`(
    (${communicationEvents.occurredAt} < ${cursor.at}::timestamptz)
    OR (${communicationEvents.occurredAt} = ${cursor.at}::timestamptz AND ${communicationEvents.id} < ${cursor.id}::uuid)
  )`;
}

function participantSearchCondition(query: string): SQL {
  const like = `%${query}%`;
  // Deliberately unaliased subqueries against the real `person_refs` table
  // object (not a raw "pf"/"pt" string alias) so every identifier drizzle
  // renders is guaranteed to match the FROM clause it's rendered into —
  // two independent EXISTS scopes don't need to disambiguate from each
  // other, only from the correlated outer `communication_events` row.
  const textMatch = sql`(${personRefs.displayName} ilike ${like} or ${personRefs.contactSnapshot} ->> 'phone' ilike ${like} or ${personRefs.contactSnapshot} ->> 'email' ilike ${like})`;
  const fromMatch = sql`exists (select 1 from person_refs where ${eq(personRefs.id, communicationEvents.fromPersonRefId)} and ${textMatch})`;
  const toMatch = sql`exists (select 1 from person_refs where ${eq(personRefs.id, communicationEvents.toPersonRefId)} and ${textMatch})`;
  return sql`(${fromMatch} or ${toMatch})`;
}

// ---------------------------------------------------------------------
// listForPerson
// ---------------------------------------------------------------------

export interface ListForPersonParams {
  personRefId: string;
  /** Allowlisted against communication_events.channel; requested-but-invalid values match nothing (never silently "all"). */
  types?: string[];
  direction?: string | null;
  /** Free-text match against the OTHER party's person_refs.display_name + contact_snapshot phone/email (this person's own identity is already fixed by personRefId). */
  participantQuery?: string | null;
  limit?: number | null;
  /** Opaque cursor from a previous page's nextCursor, or null/undefined for page 1. */
  cursor?: string | null;
}

export interface ListForPersonResult {
  rows: CommunicationEvent[];
  nextCursor: string | null;
}

/** A person's own communications (they appear as either from or to), newest first — the Person timeline's data source (spec §9.1). */
export async function listForPerson(db: DbHandle, params: ListForPersonParams): Promise<ListForPersonResult> {
  if (!isUuid(params.personRefId)) return { rows: [], nextCursor: null };

  const types = sanitizeChannels(params.types);
  const direction = sanitizeDirection(params.direction ?? null);
  const participantQuery = sanitizeParticipantQuery(params.participantQuery ?? null);
  const limit = clampLimit(params.limit);
  const cursor = validCommsCursor(params.cursor);

  const conditions: SQL[] = [
    or(eq(communicationEvents.fromPersonRefId, params.personRefId), eq(communicationEvents.toPersonRefId, params.personRefId))!,
  ];
  if (types.requested) conditions.push(impossibleIfEmpty(types) ?? inArray(communicationEvents.channel, types.values));
  if (direction) conditions.push(eq(communicationEvents.direction, direction));
  if (participantQuery) conditions.push(participantSearchCondition(participantQuery));
  if (cursor) conditions.push(keysetPredicate(cursor));

  const rows = await db
    .select()
    .from(communicationEvents)
    .where(and(...conditions))
    .orderBy(desc(communicationEvents.occurredAt), desc(communicationEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt.toISOString(), last.id) : null;

  return { rows: page, nextCursor };
}

// ---------------------------------------------------------------------
// listForIssue
// ---------------------------------------------------------------------

export type CommsLinkage = 'direct' | 'via-person' | 'both';

export interface CommsIssueRow {
  event: CommunicationEvent;
  /** How this communication surfaced on the issue's timeline. */
  linkage: CommsLinkage;
  /** issue_people.person_ref_id values (of THIS issue) this comm is also linked to via communication_links, if any. */
  viaPersonRefIds: string[];
  /** True when this comm is ALSO linked (via communication_links.issue_id) to a DIFFERENT issue — spec §29.1 cross-matter labeling. */
  crossMatter: boolean;
  crossMatterIssueIds: string[];
}

export interface ListForIssueParams {
  issueId: string;
  /** Fold in every communication linked to any person in this issue's issue_people (spec §9.1), not just comms linked directly to the issue. */
  includeLinkedPeople: boolean;
  /** Restrict to these people (a subset of the issue's linked people picked in the UI's multi-select) — narrows BOTH direct and folded-in comms by from/to identity. */
  personRefIds?: string[];
  types?: string[];
  direction?: string | null;
  /** Free-text match against from/to person_refs.display_name + contact_snapshot phone/email. */
  participantQuery?: string | null;
  limit?: number | null;
  cursor?: string | null;
}

export interface ListForIssueResult {
  rows: CommsIssueRow[];
  nextCursor: string | null;
  /** issue_people count actually folded in (0 when includeLinkedPeople is false) — lets the UI caption "N linked people". */
  linkedPersonCount: number;
}

/**
 * Every communication relevant to an issue: linked to the issue directly,
 * plus (when includeLinkedPeople) every communication linked to any person
 * currently in the issue's issue_people (spec §9.1's "all communication
 * history for linked people, not only the current coordinator's activity").
 * Deduped by communication_events.id; each row tagged with which linkage(s)
 * surfaced it and whether it's ALSO linked to a different issue (spec
 * §29.1 cross-matter labeling).
 */
export async function listForIssue(db: DbHandle, params: ListForIssueParams): Promise<ListForIssueResult> {
  if (!isUuid(params.issueId)) return { rows: [], nextCursor: null, linkedPersonCount: 0 };

  const includeLinkedPeople = params.includeLinkedPeople === true;
  const types = sanitizeChannels(params.types);
  const direction = sanitizeDirection(params.direction ?? null);
  const participantQuery = sanitizeParticipantQuery(params.participantQuery ?? null);
  const limit = clampLimit(params.limit);
  const cursor = validCommsCursor(params.cursor);
  const requestedPersonIds = sanitizeUuidArray(params.personRefIds);
  const personScopeRequested = Array.isArray(params.personRefIds) && params.personRefIds.length > 0;

  // One bounded query: every person currently linked to this issue.
  const linkedPersonRows = includeLinkedPeople
    ? await db.select({ personRefId: issuePeople.personRefId }).from(issuePeople).where(eq(issuePeople.issueId, params.issueId)).limit(LINKED_PEOPLE_LIMIT)
    : [];
  const linkedPersonIds = linkedPersonRows.map((r) => r.personRefId);

  // The universe of people whose comms fold in via the person-link path:
  // the issue's linked people, narrowed to the caller's multi-select if given.
  const viaPersonUniverse = includeLinkedPeople
    ? personScopeRequested
      ? linkedPersonIds.filter((id) => requestedPersonIds.includes(id))
      : linkedPersonIds
    : [];

  // Deliberately unaliased subqueries against the real `communication_links`
  // table object, same reasoning as participantSearchCondition above — each
  // EXISTS is its own scope, so both can reference the same unaliased table
  // name without colliding.
  const existsDirectLink = sql`exists (
    select 1 from communication_links
    where ${and(eq(communicationLinks.communicationEventId, communicationEvents.id), eq(communicationLinks.issueId, params.issueId))}
  )`;
  const existsViaPersonLink =
    viaPersonUniverse.length > 0
      ? sql`exists (
          select 1 from communication_links
          where ${and(eq(communicationLinks.communicationEventId, communicationEvents.id), inArray(communicationLinks.personRefId, viaPersonUniverse))}
        )`
      : undefined;

  const conditions: SQL[] = [(existsViaPersonLink ? or(existsDirectLink, existsViaPersonLink) : existsDirectLink)!];

  // The multi-select person filter also narrows by participant identity,
  // independent of which link surfaced the row — "show only Dale's and
  // Rita's messages" should hide a directly-linked comm between two other
  // people just as much as it hides a folded-in one.
  if (personScopeRequested) {
    conditions.push(
      requestedPersonIds.length === 0
        ? sql`false`
        : or(inArray(communicationEvents.fromPersonRefId, requestedPersonIds), inArray(communicationEvents.toPersonRefId, requestedPersonIds))!,
    );
  }

  if (types.requested) conditions.push(impossibleIfEmpty(types) ?? inArray(communicationEvents.channel, types.values));
  if (direction) conditions.push(eq(communicationEvents.direction, direction));
  if (participantQuery) conditions.push(participantSearchCondition(participantQuery));
  if (cursor) conditions.push(keysetPredicate(cursor));

  const rows = await db
    .select()
    .from(communicationEvents)
    .where(and(...conditions))
    .orderBy(desc(communicationEvents.occurredAt), desc(communicationEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt.toISOString(), last.id) : null;

  if (page.length === 0) {
    return { rows: [], nextCursor, linkedPersonCount: linkedPersonIds.length };
  }

  // ONE bounded follow-up query (id set capped at the page size, never
  // per-row) to classify each returned event's linkage(s).
  const pageIds = page.map((r) => r.id);
  const linkRows = await db
    .select({ communicationEventId: communicationLinks.communicationEventId, issueId: communicationLinks.issueId, personRefId: communicationLinks.personRefId })
    .from(communicationLinks)
    .where(inArray(communicationLinks.communicationEventId, pageIds));

  const linkedPersonSet = new Set(linkedPersonIds);
  const byEvent = new Map<string, { direct: boolean; viaPersonIds: Set<string>; otherIssueIds: Set<string> }>();
  for (const id of pageIds) byEvent.set(id, { direct: false, viaPersonIds: new Set(), otherIssueIds: new Set() });
  for (const link of linkRows) {
    const bucket = byEvent.get(link.communicationEventId);
    if (!bucket) continue;
    if (link.issueId === params.issueId) bucket.direct = true;
    if (link.issueId && link.issueId !== params.issueId) bucket.otherIssueIds.add(link.issueId);
    if (link.personRefId && linkedPersonSet.has(link.personRefId)) bucket.viaPersonIds.add(link.personRefId);
  }

  const classifiedRows: CommsIssueRow[] = page.map((event) => {
    const bucket = byEvent.get(event.id) ?? { direct: false, viaPersonIds: new Set<string>(), otherIssueIds: new Set<string>() };
    const viaPersonRefIds = [...bucket.viaPersonIds];
    const linkage: CommsLinkage = bucket.direct && viaPersonRefIds.length > 0 ? 'both' : bucket.direct ? 'direct' : 'via-person';
    const crossMatterIssueIds = [...bucket.otherIssueIds];
    return { event, linkage, viaPersonRefIds, crossMatter: crossMatterIssueIds.length > 0, crossMatterIssueIds };
  });

  return { rows: classifiedRows, nextCursor, linkedPersonCount: linkedPersonIds.length };
}
