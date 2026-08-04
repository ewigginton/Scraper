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
 * limited query per source and merges the results in memory. Two KINDS of
 * source need different treatment:
 *
 *  - "small" sources (phase_instances, notices, issue_people links) are
 *    refetched in FULL every page (still bounded by a defensive LIMIT,
 *    never literally unbounded) — cheap because they're scoped to one
 *    issue/person and inherently low-cardinality.
 *  - "paginated" sources (communications, audit_events) can genuinely grow
 *    large over an issue's/person's lifetime, so each carries its OWN
 *    per-source cursor threaded through this module's combined cursor
 *    payload (`comms`/`audit` fields). See `mergeAndPaginate`'s doc comment
 *    for why a naive "reuse the combined cursor's timestamp as every
 *    source's SQL bound" is WRONG (it silently drops rows whenever one
 *    source's boundary advances faster than another's) and why per-source
 *    advancement — advance only once a source's fetched batch is FULLY
 *    consumed into a page, otherwise hold steady and let the merge filter
 *    re-trim the same batch next time — is the correct fix.
 */

import { and, desc, eq, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { auditEvents, holds, issuePeople, notices, phaseInstances, tasks } from '../db/schema.ts';
import * as commsRepo from './comms-repo.ts';
import { clampLimit, decodeCursor as decodeSimpleCursor, encodeCursor as encodeSimpleCursor } from './keyset-cursor.ts';
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

/** True when `e` belongs strictly AFTER `{at, tie}` in the total order above (i.e. is eligible for the next page). No cursor means every entry qualifies (page 1). */
function isPastCursor(e: TimelineEntry, cursor: { at: string; tie: string } | null): boolean {
  if (!cursor) return true;
  const cursorAtMs = Date.parse(cursor.at);
  const eAtMs = e.at.getTime();
  if (eAtMs < cursorAtMs) return true;
  if (eAtMs > cursorAtMs) return false;
  return tieOf(e) > cursor.tie;
}

// ---------------------------------------------------------------------
// Combined cursor: {at, tie} for merge/sort correctness (small sources,
// which have no cursor of their own) PLUS one independently-advancing
// per-source cursor for each paginated source (comms/audit).
// ---------------------------------------------------------------------

/** Sentinel meaning "this source is fully exhausted, do not query it again" — distinct from an absent field (page 1 / "start from the top"), since re-issuing an unset cursor would silently restart that source from its newest row forever. */
const SOURCE_DONE = '__done__';

interface CombinedCursorPayload {
  at: string;
  tie: string;
  comms?: string;
  audit?: string;
}

const MAX_CURSOR_LEN = 4000;

function encodeCombinedCursor(payload: CombinedCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Never throws — any malformed/hostile cursor decodes to null, treated as page 1. */
function decodeCombinedCursor(raw: string | null | undefined): CombinedCursorPayload | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LEN) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.at !== 'string' || Number.isNaN(Date.parse(p.at))) return null;
    if (typeof p.tie !== 'string' || p.tie.length === 0 || p.tie.length > 300) return null;
    const comms = typeof p.comms === 'string' && p.comms.length <= 500 ? p.comms : undefined;
    const audit = typeof p.audit === 'string' && p.audit.length <= 500 ? p.audit : undefined;
    return { at: p.at, tie: p.tie, comms, audit };
  } catch {
    return null;
  }
}

/**
 * comms-repo's own cursor is a strict "<" predicate on (occurred_at, id) —
 * a plain [at, id] pair, same shape as this module's `comms`/`audit`
 * per-source cursor fields, so keyset-cursor.ts's encode/decode is reused
 * directly for both (audit_events cursor built the same way below).
 */
function auditCursorFor(row: { occurredAt: Date; id: string }): string {
  return encodeSimpleCursor(row.occurredAt.toISOString(), row.id);
}

// ---------------------------------------------------------------------
// Paginated-source fetch results + the shared merge/paginate step
// ---------------------------------------------------------------------

interface PaginatedBatch {
  key: 'comms' | 'audit';
  entries: TimelineEntry[];
  /** This source's own correct "resume here" cursor for its NEXT unfetched row, or null if it has none (repo-reported exhaustion). Ignored/absent when the batch came from SOURCE_DONE (already known exhausted). */
  repoNextCursor: string | null;
  /** How many rows this fetch actually returned (<= the requested fetchLimit) — used to detect "this batch was a full page, there might be more" vs "this was everything". */
  fetchedCount: number;
  /** The per-source cursor value that was used to PRODUCE this batch — carried forward unchanged on partial consumption (see module doc comment). */
  cursorUsed: string | undefined;
}

function matchesSourceKey(e: TimelineEntry, key: 'comms' | 'audit'): boolean {
  return key === 'comms' ? e.sourceTable === 'communication_events' : e.kind === 'audit';
}

/**
 * Merge every fetched candidate (small-source entries + paginated-source
 * batches) into one page, and compute the next combined cursor.
 *
 * Per-source advancement rule (the fix for the "faster source's boundary
 * silently skips a slower source's unconsumed rows" bug): a paginated
 * source's persisted cursor only moves forward once ALL of its fetched
 * batch made it into the returned page (fetchedCount === consumedCount) —
 * at that point it's safe to jump to that source's own next-page cursor.
 * If only SOME of a batch was consumed, the source's cursor is left
 * UNCHANGED; the next page re-fetches the identical batch, and the
 * isPastCursor filter (driven by the combined {at, tie}, not any one
 * source's pace) correctly strips the already-emitted prefix and re-offers
 * exactly the leftover suffix. This converges because the combined cursor
 * strictly advances every page (as long as there is more data to page
 * through) even when a given source doesn't.
 */
function mergeAndPaginate(smallEntries: TimelineEntry[], paginated: PaginatedBatch[], cursor: CombinedCursorPayload | null, limit: number): { entries: TimelineEntry[]; nextCursor: string | null } {
  const candidates = [...smallEntries, ...paginated.flatMap((p) => p.entries)];
  const eligible = candidates.filter((e) => isPastCursor(e, cursor)).sort(compareEntries);

  const hasMore = eligible.length > limit;
  const page = hasMore ? eligible.slice(0, limit) : eligible;
  const last = page[page.length - 1];

  if (!hasMore || !last) return { entries: page, nextCursor: null };

  const nextPayload: CombinedCursorPayload = { at: last.at.toISOString(), tie: tieOf(last) };
  for (const source of paginated) {
    const consumedCount = page.filter((e) => matchesSourceKey(e, source.key)).length;
    const fullyConsumed = consumedCount === source.fetchedCount;
    const nextSourceCursor = fullyConsumed ? (source.repoNextCursor ?? SOURCE_DONE) : source.cursorUsed;
    if (source.key === 'comms') nextPayload.comms = nextSourceCursor;
    else nextPayload.audit = nextSourceCursor;
  }

  return { entries: page, nextCursor: encodeCombinedCursor(nextPayload) };
}

// ---------------------------------------------------------------------
// Per-source fetchers
// ---------------------------------------------------------------------

async function fetchCommsBatch(db: DbHandle, issueId: string, filters: NormalizedFilters, sourceCursor: string | undefined, fetchLimit: number): Promise<PaginatedBatch> {
  if (sourceCursor === SOURCE_DONE) return { key: 'comms', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: sourceCursor };

  const result = await commsRepo.listForIssue(db, {
    issueId,
    includeLinkedPeople: true,
    personRefIds: filters.personRefIdsRequested ? filters.personRefIds : undefined,
    direction: filters.direction,
    participantQuery: filters.participantQuery,
    limit: fetchLimit,
    cursor: sourceCursor,
  });
  const entries = result.rows.map(
    (row): TimelineEntry => ({
      at: row.event.occurredAt,
      kind: 'communication',
      title: `${capitalize(row.event.channel)} (${row.event.direction})`,
      detail: row.event.summary ?? null,
      actor: null,
      sourceTable: 'communication_events',
      sourceId: row.event.id,
      crossMatter: row.crossMatter,
    }),
  );
  return { key: 'comms', entries, repoNextCursor: result.nextCursor, fetchedCount: result.rows.length, cursorUsed: sourceCursor };
}

async function fetchPersonCommsBatch(db: DbHandle, personRefId: string, filters: NormalizedFilters, sourceCursor: string | undefined, fetchLimit: number): Promise<PaginatedBatch> {
  if (sourceCursor === SOURCE_DONE) return { key: 'comms', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: sourceCursor };

  const result = await commsRepo.listForPerson(db, {
    personRefId,
    direction: filters.direction,
    participantQuery: filters.participantQuery,
    limit: fetchLimit,
    cursor: sourceCursor,
  });
  const entries = result.rows.map(
    (event): TimelineEntry => ({
      at: event.occurredAt,
      kind: 'communication',
      title: `${capitalize(event.channel)} (${event.direction})`,
      detail: event.summary ?? null,
      actor: null,
      sourceTable: 'communication_events',
      sourceId: event.id,
    }),
  );
  return { key: 'comms', entries, repoNextCursor: result.nextCursor, fetchedCount: result.rows.length, cursorUsed: sourceCursor };
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

/** ONE combined audit_events query across the issue's whole object graph (issue + its tasks/holds/phase_instances ids, each id set fetched in its own single bounded query first). Fetches fetchLimit+1 to know whether more remain, same convention as every other keyset query in this codebase. */
async function fetchIssueObjectGraphAuditBatch(db: DbHandle, issueId: string, sourceCursor: string | undefined, fetchLimit: number): Promise<PaginatedBatch> {
  if (sourceCursor === SOURCE_DONE) return { key: 'audit', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: sourceCursor };

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
  const decoded = sourceCursor ? decodeSimpleCursor(sourceCursor) : null;
  if (decoded && isUuid(decoded.tie)) conditions.push(auditKeysetBefore(decoded));

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(fetchLimit + 1);

  const hasMore = rows.length > fetchLimit;
  const page = hasMore ? rows.slice(0, fetchLimit) : rows;
  const lastRow = page[page.length - 1];
  const repoNextCursor = hasMore && lastRow ? auditCursorFor(lastRow) : null;

  return { key: 'audit', entries: page.map(auditEntryFrom), repoNextCursor, fetchedCount: page.length, cursorUsed: sourceCursor };
}

function keysetBefore(decoded: { at: string; tie: string }): SQL {
  return and(
    // strictly before (occurred_at, id) in desc order — standard seek predicate.
    or(lte(auditEvents.occurredAt, new Date(decoded.at)), undefined),
  )!;
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
  const cursor = decodeCombinedCursor(params.cursor);

  const wants = (k: TimelineKind) => !filters.kinds.requested || filters.kinds.values.includes(k);
  const fetchLimit = limit + 1;

  const [commsBatch, auditBatch, phaseEntries, noticeEntries] = await Promise.all([
    wants('communication')
      ? fetchCommsBatch(db, params.issueId, filters, cursor?.comms, fetchLimit)
      : Promise.resolve<PaginatedBatch>({ key: 'comms', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: cursor?.comms }),
    wants('audit')
      ? fetchIssueObjectGraphAuditBatch(db, params.issueId, cursor?.audit, fetchLimit)
      : Promise.resolve<PaginatedBatch>({ key: 'audit', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: cursor?.audit }),
    wants('phase_open') || wants('phase_close') ? fetchPhaseEntries(db, params.issueId) : Promise.resolve([]),
    wants('notice') ? fetchNoticeEntries(db, params.issueId, filters) : Promise.resolve([]),
  ]);

  const filteredPhaseEntries = phaseEntries.filter((e) => wants(e.kind));
  return mergeAndPaginate([...filteredPhaseEntries, ...noticeEntries], [commsBatch, auditBatch], cursor, limit);
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
  const cursor = decodeCombinedCursor(params.cursor);

  const wants = (k: TimelineKind) => !filters.kinds.requested || filters.kinds.values.includes(k);
  const fetchLimit = limit + 1;

  const [commsBatch, linkEntries, auditBatch] = await Promise.all([
    wants('communication')
      ? fetchPersonCommsBatch(db, params.personRefId, filters, cursor?.comms, fetchLimit)
      : Promise.resolve<PaginatedBatch>({ key: 'comms', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: cursor?.comms }),
    wants('issue_link') ? fetchIssueLinkEntries(db, params.personRefId) : Promise.resolve([]),
    wants('audit')
      ? fetchPersonObjectAuditBatch(db, params.personRefId, cursor?.audit, fetchLimit)
      : Promise.resolve<PaginatedBatch>({ key: 'audit', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: cursor?.audit }),
  ]);

  return mergeAndPaginate(linkEntries, [commsBatch, auditBatch], cursor, limit);
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

async function fetchPersonObjectAuditBatch(db: DbHandle, personRefId: string, sourceCursor: string | undefined, fetchLimit: number): Promise<PaginatedBatch> {
  if (sourceCursor === SOURCE_DONE) return { key: 'audit', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: sourceCursor };

  const conditions: SQL[] = [eq(auditEvents.objectTable, 'person_refs'), eq(auditEvents.objectId, personRefId)];
  const decoded = sourceCursor ? decodeSimpleCursor(sourceCursor) : null;
  if (decoded && isUuid(decoded.tie)) conditions.push(keysetBefore(decoded));

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(fetchLimit + 1);

  const hasMore = rows.length > fetchLimit;
  const page = hasMore ? rows.slice(0, fetchLimit) : rows;
  const lastRow = page[page.length - 1];
  const repoNextCursor = hasMore && lastRow ? auditCursorFor(lastRow) : null;

  return { key: 'audit', entries: page.map(auditEntryFrom), repoNextCursor, fetchedCount: page.length, cursorUsed: sourceCursor };
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
