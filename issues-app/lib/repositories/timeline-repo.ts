/**
 * timeline-repo — the chronological, multi-source "story" view for an issue
 * or a person (spec §29.11, Wave 2 roadmap "Issue timeline view" / "Person
 * timeline page"). Every entry is normalized to the same shape regardless
 * of source table, so the UI renders one interleaved list rather than N
 * separate sections.
 *
 * Sources merged for issueTimeline:
 *  - communications (via comms-repo.listForIssue, includeLinkedPeople
 *    ALWAYS true — spec §9.1/"Cleanup-timeline people scope" requires every
 *    linked person's messages, not a togglable option).
 *  - audit_events for the issue's object graph: the issue itself, plus its
 *    tasks/holds/phase_instances, fetched as object ids in ONE query per
 *    table, then ONE combined audit_events query across all four
 *    (object_table, object_id) groups (tighter than one query per table,
 *    never looser).
 *  - phase_instances openings/closings, read directly off started_at/
 *    ended_at (NOT via audit_events — no shipped command currently writes
 *    object_table='phase_instances' rows; see lib/services/transition-
 *    engine.ts, which audits phase transitions under object_table='issues'
 *    instead. The object-graph audit query above still asks for
 *    object_table='phase_instances' defensively/forward-compatibly, but
 *    today it will always return zero rows — these dedicated entries are
 *    the actual signal).
 *  - notices, read directly off the notices table.
 *
 * Pagination: a heterogeneous multi-source feed can't be paginated with a
 * single SQL ORDER BY/LIMIT, so this module fans out one bounded, ordered,
 * limited query per source (each independently keyset-correct on its own
 * timestamp+id), merges the results in memory using the SAME total order
 * the combined cursor encodes, and slices to the page size. See
 * `compareEntries`/`isPastCursor` below for the merge invariant this
 * relies on. phase_instances/notices are small enough per issue that they
 * are refetched in full on every page (still bounded by a defensive LIMIT)
 * rather than cursor-pushed at the SQL level; communications and
 * audit_events (the two sources that can grow large over an issue's
 * lifetime) DO push the cursor into their SQL query.
 */

import { and, desc, eq, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { auditEvents, holds, issuePeople, notices, phaseInstances, tasks } from '../db/schema.ts';
import * as commsRepo from './comms-repo.ts';
import { clampLimit, decodeCursor, encodeCursor } from './keyset-cursor.ts';
import { isUuid, sanitizeUuidArray } from './id-guard.ts';

// ---------------------------------------------------------------------
// Shared entry shape
// ---------------------------------------------------------------------

export type TimelineKind = 'communication' | 'audit' | 'phase_open' | 'phase_close' | 'notice' | 'issue_link';

export interface TimelineEntry {
  at: Date;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  /** Best-effort identity: actor_external_id, else actor_id, else 'unattributed'. Null for entry kinds with no actor concept (e.g. a communication). */
  actor: string | null;
  sourceTable: string;
  sourceId: string;
  /** True when this entry is ALSO linked to a DIFFERENT issue/matter than the one being viewed (spec §29.1). Only ever set on 'communication' entries — the only source that can be cross-linked today. */
  crossMatter?: boolean;
}

const VALID_KINDS = new Set<TimelineKind>(['communication', 'audit', 'phase_open', 'phase_close', 'notice', 'issue_link']);
const VALID_DIRECTIONS = new Set(['inbound', 'outbound']);
const MAX_STRING_LEN = 200;
const OBJECT_GRAPH_ID_LIMIT = 1000;
const PHASE_NOTICE_LIMIT = 500;

export interface TimelineFilters {
  kinds?: string[];
  personRefIds?: string[];
  direction?: string | null;
  participantQuery?: string | null;
}

interface NormalizedFilters {
  kinds: { requested: boolean; values: TimelineKind[] };
  personRefIds: string[];
  personRefIdsRequested: boolean;
  direction: string | null;
  participantQuery: string | null;
}

function normalizeFilters(filters: TimelineFilters | undefined): NormalizedFilters {
  const kindsInput = filters?.kinds;
  const kindValues = Array.isArray(kindsInput) ? kindsInput.filter((k): k is TimelineKind => typeof k === 'string' && VALID_KINDS.has(k as TimelineKind)) : [];
  const direction = typeof filters?.direction === 'string' && VALID_DIRECTIONS.has(filters.direction) ? filters.direction : null;
  const participantQueryRaw = typeof filters?.participantQuery === 'string' ? filters.participantQuery.trim().slice(0, MAX_STRING_LEN) : '';
  return {
    kinds: { requested: Array.isArray(kindsInput) && kindsInput.length > 0, values: [...new Set(kindValues)] },
    personRefIds: sanitizeUuidArray(filters?.personRefIds),
    personRefIdsRequested: Array.isArray(filters?.personRefIds) && filters.personRefIds.length > 0,
    direction,
    participantQuery: participantQueryRaw.length > 0 ? participantQueryRaw : null,
  };
}

/** Total order every source-fetch, sort, and cursor comparison in this file agrees on: newest `at` first; ties broken ascending by `sourceTable:sourceId:kind`. */
function tieOf(e: TimelineEntry): string {
  return `${e.sourceTable}:${e.sourceId}:${e.kind}`;
}

function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  const byTime = b.at.getTime() - a.at.getTime();
  if (byTime !== 0) return byTime;
  const ta = tieOf(a);
  const tb = tieOf(b);
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

interface Cursor {
  at: string;
  tie: string;
}

/** True when `e` belongs strictly AFTER `cursor` in the total order above (i.e. is eligible for the next page). No cursor means every entry qualifies (page 1). */
function isPastCursor(e: TimelineEntry, cursor: Cursor | null): boolean {
  if (!cursor) return true;
  const cursorAtMs = Date.parse(cursor.at);
  const eAtMs = e.at.getTime();
  if (eAtMs < cursorAtMs) return true;
  if (eAtMs > cursorAtMs) return false;
  return tieOf(e) > cursor.tie;
}

/**
 * comms-repo's own cursor is a strict "<" predicate on (occurred_at, id).
 * To push this module's combined cursor's `at` into that call as an
 * INCLUSIVE upper bound (everything at-or-before `at`; exact ties across
 * sources get resolved afterward by the in-memory isPastCursor filter), the
 * `id` half is set to the maximum possible uuid — real ids (random v4) are
 * always less than it, so `id < MAX_UUID` is true for every real row and
 * only `occurred_at` ends up constraining the query.
 */
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function commsCursorParam(cursorAt: string | undefined): string | undefined {
  return cursorAt ? encodeCursor(cursorAt, MAX_UUID) : undefined;
}

// ---------------------------------------------------------------------
// Per-source fetchers
// ---------------------------------------------------------------------

async function fetchCommsEntries(
  db: DbHandle,
  issueId: string,
  filters: NormalizedFilters,
  cursorAt: string | undefined,
  limit: number,
): Promise<TimelineEntry[]> {
  const result = await commsRepo.listForIssue(db, {
    issueId,
    includeLinkedPeople: true,
    personRefIds: filters.personRefIdsRequested ? filters.personRefIds : undefined,
    direction: filters.direction,
    participantQuery: filters.participantQuery,
    limit,
    cursor: commsCursorParam(cursorAt),
  });
  return result.rows.map((row) => ({
    at: row.event.occurredAt,
    kind: 'communication' as const,
    title: `${capitalize(row.event.channel)} (${row.event.direction})`,
    detail: row.event.summary ?? null,
    actor: null,
    sourceTable: 'communication_events',
    sourceId: row.event.id,
    crossMatter: row.crossMatter,
  }));
}

const OBJECT_TABLE_LABEL: Record<string, string> = {
  issues: 'Issue',
  tasks: 'Task',
  holds: 'Hold',
  phase_instances: 'Phase',
  person_refs: 'Person',
};

function auditEntryFrom(row: typeof auditEvents.$inferSelect): TimelineEntry {
  const label = OBJECT_TABLE_LABEL[row.objectTable] ?? row.objectTable;
  return {
    at: row.occurredAt,
    kind: 'audit',
    title: `${label} ${row.action}`,
    detail: row.reason ?? null,
    actor: row.actorExternalId ?? row.actorId ?? 'unattributed',
    sourceTable: row.objectTable,
    sourceId: row.objectId,
  };
}

/** ONE combined audit_events query across the issue's whole object graph (issue + its tasks/holds/phase_instances ids, each id set fetched in its own single bounded query first). */
async function fetchIssueObjectGraphAuditEntries(db: DbHandle, issueId: string, cursorAt: string | undefined, limit: number): Promise<TimelineEntry[]> {
  const [taskIds, holdIds, phaseIds] = await Promise.all([
    db.select({ id: tasks.id }).from(tasks).where(eq(tasks.issueId, issueId)).limit(OBJECT_GRAPH_ID_LIMIT).then((r) => r.map((x) => x.id)),
    db.select({ id: holds.id }).from(holds).where(eq(holds.issueId, issueId)).limit(OBJECT_GRAPH_ID_LIMIT).then((r) => r.map((x) => x.id)),
    db.select({ id: phaseInstances.id }).from(phaseInstances).where(eq(phaseInstances.issueId, issueId)).limit(OBJECT_GRAPH_ID_LIMIT).then((r) => r.map((x) => x.id)),
  ]);

  const branches: SQL[] = [and(eq(auditEvents.objectTable, 'issues'), eq(auditEvents.objectId, issueId))!];
  if (taskIds.length > 0) branches.push(and(eq(auditEvents.objectTable, 'tasks'), inArray(auditEvents.objectId, taskIds))!);
  if (holdIds.length > 0) branches.push(and(eq(auditEvents.objectTable, 'holds'), inArray(auditEvents.objectId, holdIds))!);
  if (phaseIds.length > 0) branches.push(and(eq(auditEvents.objectTable, 'phase_instances'), inArray(auditEvents.objectId, phaseIds))!);

  const conditions: SQL[] = [or(...branches)!];
  if (cursorAt) conditions.push(lte(auditEvents.occurredAt, new Date(cursorAt)));

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(limit);

  return rows.map(auditEntryFrom);
}

/** Direct read of phase_instances (NOT via audit_events — see this module's header comment). Small per-issue cardinality: fetched in full every page, bounded defensively. */
async function fetchPhaseEntries(db: DbHandle, issueId: string): Promise<TimelineEntry[]> {
  const rows = await db.select().from(phaseInstances).where(eq(phaseInstances.issueId, issueId)).limit(PHASE_NOTICE_LIMIT);
  const entries: TimelineEntry[] = [];
  for (const p of rows) {
    if (p.startedAt) {
      entries.push({
        at: p.startedAt,
        kind: 'phase_open',
        title: `Phase opened — ${p.phaseKey}`,
        detail: p.entryReason ?? null,
        actor: p.ownerId ?? null,
        sourceTable: 'phase_instances',
        sourceId: p.id,
      });
    }
    if (p.endedAt) {
      entries.push({
        at: p.endedAt,
        kind: 'phase_close',
        title: `Phase closed — ${p.phaseKey}`,
        detail: p.exitOutcome ?? null,
        actor: p.ownerId ?? null,
        sourceTable: 'phase_instances',
        sourceId: p.id,
      });
    }
  }
  return entries;
}

/** Direct read of notices. Small per-issue cardinality, same treatment as phase entries. */
async function fetchNoticeEntries(db: DbHandle, issueId: string, filters: NormalizedFilters): Promise<TimelineEntry[]> {
  // requested-but-nothing-valid -> match nothing, same idiom as every other filter in this module.
  if (filters.personRefIdsRequested && filters.personRefIds.length === 0) return [];

  const conditions: SQL[] = [eq(notices.issueId, issueId)];
  if (filters.personRefIdsRequested) conditions.push(inArray(notices.recipientPersonRefId, filters.personRefIds));

  const rows = await db
    .select()
    .from(notices)
    .where(and(...conditions))
    .limit(PHASE_NOTICE_LIMIT);
  return rows.map((n) => ({
    at: n.sentAt ?? n.createdAt,
    kind: 'notice' as const,
    title: `Notice ${n.status}`,
    detail: n.cureDeadline ? `Cure deadline ${n.cureDeadline}` : null,
    actor: null,
    sourceTable: 'notices',
    sourceId: n.id,
  }));
}

// ---------------------------------------------------------------------
// issueTimeline
// ---------------------------------------------------------------------

export interface IssueTimelineParams {
  issueId: string;
  filters?: TimelineFilters;
  limit?: number | null;
  cursor?: string | null;
}

export interface TimelineResult {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

export async function issueTimeline(db: DbHandle, params: IssueTimelineParams): Promise<TimelineResult> {
  if (!isUuid(params.issueId)) return { entries: [], nextCursor: null };

  const filters = normalizeFilters(params.filters);
  if (filters.kinds.requested && filters.kinds.values.length === 0) return { entries: [], nextCursor: null };
  const limit = clampLimit(params.limit);
  const cursor = decodeCursor(params.cursor);

  const wants = (k: TimelineKind) => !filters.kinds.requested || filters.kinds.values.includes(k);
  const fetchLimit = limit + 1;

  const [commsEntries, auditEntries, phaseEntries, noticeEntries] = await Promise.all([
    wants('communication') ? fetchCommsEntries(db, params.issueId, filters, cursor?.at, fetchLimit) : Promise.resolve([]),
    wants('audit') ? fetchIssueObjectGraphAuditEntries(db, params.issueId, cursor?.at, fetchLimit) : Promise.resolve([]),
    wants('phase_open') || wants('phase_close') ? fetchPhaseEntries(db, params.issueId) : Promise.resolve([]),
    wants('notice') ? fetchNoticeEntries(db, params.issueId, filters) : Promise.resolve([]),
  ]);

  const filteredPhaseEntries = phaseEntries.filter((e) => wants(e.kind));

  const merged = [...commsEntries, ...auditEntries, ...filteredPhaseEntries, ...noticeEntries]
    .filter((e) => isPastCursor(e, cursor))
    .sort(compareEntries);

  const hasMore = merged.length > limit;
  const page = hasMore ? merged.slice(0, limit) : merged;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.at.toISOString(), tieOf(last)) : null;

  return { entries: page, nextCursor };
}

// ---------------------------------------------------------------------
// personTimeline
// ---------------------------------------------------------------------

export interface PersonTimelineParams {
  personRefId: string;
  filters?: TimelineFilters;
  limit?: number | null;
  cursor?: string | null;
}

/**
 * A person's own timeline: their communications, their issue_people links
 * (when they were linked to a case, in what role, and when that ended), and
 * audit_events where they are the OBJECT (object_table='person_refs') — a
 * category no shipped command currently writes to (person_refs is a synced
 * read-model, not directly audited by Property Operations), included for
 * forward-compatibility the same way issueTimeline's phase_instances
 * audit-graph branch is.
 */
export async function personTimeline(db: DbHandle, params: PersonTimelineParams): Promise<TimelineResult> {
  if (!isUuid(params.personRefId)) return { entries: [], nextCursor: null };

  const filters = normalizeFilters(params.filters);
  if (filters.kinds.requested && filters.kinds.values.length === 0) return { entries: [], nextCursor: null };
  const limit = clampLimit(params.limit);
  const cursor = decodeCursor(params.cursor);

  const wants = (k: TimelineKind) => !filters.kinds.requested || filters.kinds.values.includes(k);
  const fetchLimit = limit + 1;

  const [commsEntries, linkEntries, auditEntries] = await Promise.all([
    wants('communication')
      ? commsRepo
          .listForPerson(db, {
            personRefId: params.personRefId,
            direction: filters.direction,
            participantQuery: filters.participantQuery,
            limit: fetchLimit,
            cursor: commsCursorParam(cursor?.at),
          })
          .then((result) =>
            result.rows.map(
              (event): TimelineEntry => ({
                at: event.occurredAt,
                kind: 'communication',
                title: `${capitalize(event.channel)} (${event.direction})`,
                detail: event.summary ?? null,
                actor: null,
                sourceTable: 'communication_events',
                sourceId: event.id,
              }),
            ),
          )
      : Promise.resolve([]),
    wants('issue_link') ? fetchIssueLinkEntries(db, params.personRefId) : Promise.resolve([]),
    wants('audit') ? fetchPersonObjectAuditEntries(db, params.personRefId, cursor?.at, fetchLimit) : Promise.resolve([]),
  ]);

  const merged = [...commsEntries, ...linkEntries, ...auditEntries].filter((e) => isPastCursor(e, cursor)).sort(compareEntries);

  const hasMore = merged.length > limit;
  const page = hasMore ? merged.slice(0, limit) : merged;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.at.toISOString(), tieOf(last)) : null;

  return { entries: page, nextCursor };
}

async function fetchIssueLinkEntries(db: DbHandle, personRefId: string): Promise<TimelineEntry[]> {
  const rows = await db.select().from(issuePeople).where(eq(issuePeople.personRefId, personRefId)).limit(PHASE_NOTICE_LIMIT);
  const entries: TimelineEntry[] = [];
  for (const link of rows) {
    entries.push({
      at: new Date(`${link.startDate}T00:00:00.000Z`),
      kind: 'issue_link',
      title: `Linked to issue as ${link.role}`,
      detail: link.notes ?? null,
      actor: null,
      sourceTable: 'issue_people',
      sourceId: link.id,
    });
    if (link.endDate) {
      entries.push({
        at: new Date(`${link.endDate}T00:00:00.000Z`),
        kind: 'issue_link',
        title: `Unlinked from issue (was ${link.role})`,
        detail: link.notes ?? null,
        actor: null,
        sourceTable: 'issue_people',
        sourceId: `${link.id}:end`,
      });
    }
  }
  return entries;
}

async function fetchPersonObjectAuditEntries(db: DbHandle, personRefId: string, cursorAt: string | undefined, limit: number): Promise<TimelineEntry[]> {
  const conditions: SQL[] = [eq(auditEvents.objectTable, 'person_refs'), eq(auditEvents.objectId, personRefId)];
  if (cursorAt) conditions.push(lte(auditEvents.occurredAt, new Date(cursorAt)));
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(limit);
  return rows.map(auditEntryFrom);
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
