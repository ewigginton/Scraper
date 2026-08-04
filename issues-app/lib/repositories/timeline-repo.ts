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

import { and, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { auditEvents, holds, issuePeople, notices, phaseInstances, tasks } from '../db/schema.ts';
import * as commsRepo from './comms-repo.ts';
import { clampLimit, decodeCursor as decodeSimpleCursor, encodeCursor as encodeSimpleCursor } from './keyset-cursor.ts';
import { isUuid, sanitizeText, sanitizeUuidArray } from './id-guard.ts';

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
  /**
   * Raw audit_events.before/after jsonb (Wave 2b "readable change-log feed",
   * spec §29.2/§31.4) — undefined for every non-'audit' kind, and for 'audit'
   * entries whenever the underlying row's before/after was null. Consumers
   * compute a plain-English field diff from these via app/_lib/audit-diff.ts
   * rather than this module rendering any UI itself (DESIGN.md §6: no
   * presentation logic in a repository).
   */
  before?: unknown;
  after?: unknown;
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
  /**
   * Inclusive `at` lower/upper bounds (roadmap "Timeline filters ... date
   * range"). Precise ISO instants, NOT calendar days — a caller driven by a
   * `<input type=date>` field resolves that to an inclusive end-of-day
   * instant (e.g. `${date}T23:59:59.999Z`) before it reaches this module,
   * same convention lib/repositories/people-repo.ts's personTimelinePage
   * established. Invalid/absent values are dropped rather than throwing.
   */
  fromDate?: string | null;
  toDate?: string | null;
}

interface NormalizedFilters {
  kinds: { requested: boolean; values: TimelineKind[] };
  personRefIds: string[];
  personRefIdsRequested: boolean;
  direction: string | null;
  participantQuery: string | null;
  fromDate: Date | null;
  toDate: Date | null;
}

/** Same "parse, drop if invalid, never throw" contract as comms-repo.ts's/audit-metrics-repo.ts's sanitizeDateBound (duplicated rather than imported — this module already treats comms-repo as an external collaborator it calls through, not a shared-internals dependency). */
function sanitizeDateBound(input: unknown): Date | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, MAX_STRING_LEN);
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function normalizeFilters(filters: TimelineFilters | undefined): NormalizedFilters {
  const kindsInput = filters?.kinds;
  const kindValues = Array.isArray(kindsInput) ? kindsInput.filter((k): k is TimelineKind => typeof k === 'string' && VALID_KINDS.has(k as TimelineKind)) : [];
  const direction = typeof filters?.direction === 'string' && VALID_DIRECTIONS.has(filters.direction) ? filters.direction : null;
  // Delegates to id-guard.sanitizeText (INJECTION FUZZ finding, round 2):
  // this previously only did `.trim().slice(...)` with no NUL-byte strip,
  // so a `%00` in `participant` reached the wire as a bound parameter's
  // value and 500'd with a raw Postgres "invalid byte sequence" driver
  // error on /issues/[id]/timeline instead of behaving like every other
  // free-text filter's safe no-op.
  return {
    kinds: { requested: Array.isArray(kindsInput) && kindsInput.length > 0, values: [...new Set(kindValues)] },
    personRefIds: sanitizeUuidArray(filters?.personRefIds),
    personRefIdsRequested: Array.isArray(filters?.personRefIds) && filters.personRefIds.length > 0,
    direction,
    participantQuery: sanitizeText(filters?.participantQuery, MAX_STRING_LEN),
    fromDate: sanitizeDateBound(filters?.fromDate ?? null),
    toDate: sanitizeDateBound(filters?.toDate ?? null),
  };
}

/** Shared date-range test for the "small" sources (phase/notice/issue-link), which are fetched in full and filtered in memory rather than via SQL gte/lte — see this module's header doc comment on why those sources skip SQL pushdown entirely. */
function inDateRange(at: Date, filters: NormalizedFilters): boolean {
  if (filters.fromDate && at.getTime() < filters.fromDate.getTime()) return false;
  if (filters.toDate && at.getTime() > filters.toDate.getTime()) return false;
  return true;
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
 * TWO correctness hazards a naive top-K merge across independently-limited
 * sources runs into, both handled below:
 *
 * 1. Per-source advancement: a paginated source's persisted cursor only
 *    moves forward once ALL of its still-relevant fetched rows made it
 *    into a returned page (see `pendingFromSource`/`fullyConsumed`) — at
 *    that point it's safe to jump to that source's own next-page cursor.
 *    If only SOME were consumed, the source's cursor is left UNCHANGED; the
 *    next page re-fetches the identical batch, and the isPastCursor filter
 *    (driven by the combined {at, tie}, not any one source's pace)
 *    correctly strips the already-emitted prefix and re-offers exactly the
 *    leftover suffix.
 *
 * 2. Safe watermark: a source with a SMALL per-page fetch limit only ever
 *    "sees" down to a certain depth each round (the oldest `at` in its
 *    fetched batch — its "explored boundary"). If another source (or a
 *    fully-available small source) offers a candidate OLDER than some
 *    still-active source's explored boundary, emitting it now would be
 *    unsound: that shallow source might have a HIDDEN row, not yet
 *    fetched, that's chronologically NEWER than the candidate but older
 *    than the shallow source's own already-seen rows — exactly the
 *    scenario where two audit rows 6ms apart share a batch with a third
 *    source's row sitting 13ms further back, still unexplored. Candidates
 *    older than `safeWatermark` (the deepest/most-recent explored boundary
 *    among all sources that still have more data) are withheld this round;
 *    they remain valid candidates and get correctly interleaved once a
 *    later page explores that source deeper.
 *
 * Both mechanisms converge: the combined cursor strictly advances every
 * page as long as unconsumed/unexplored data remains anywhere.
 */
function mergeAndPaginate(smallEntries: TimelineEntry[], paginated: PaginatedBatch[], cursor: CombinedCursorPayload | null, limit: number): { entries: TimelineEntry[]; nextCursor: string | null } {
  const candidates = [...smallEntries, ...paginated.flatMap((p) => p.entries)];
  const eligible = candidates.filter((e) => isPastCursor(e, cursor));

  // safeWatermark: the newest ("shallowest") explored-boundary among every
  // paginated source that still has more data (repoNextCursor !== null).
  // Undefined (no source is a threat) means no candidate needs withholding.
  let safeWatermarkMs: number | undefined;
  for (const source of paginated) {
    if (source.repoNextCursor === null || source.entries.length === 0) continue;
    const boundaryMs = Math.min(...source.entries.map((e) => e.at.getTime()));
    safeWatermarkMs = safeWatermarkMs === undefined ? boundaryMs : Math.max(safeWatermarkMs, boundaryMs);
  }

  const emittable = (safeWatermarkMs === undefined ? eligible : eligible.filter((e) => e.at.getTime() >= safeWatermarkMs!)).sort(compareEntries);
  const withheldByWatermark = eligible.length > emittable.length;

  const anySourceHasMoreBeyondFetch = paginated.some((p) => p.repoNextCursor !== null);
  const hasMore = emittable.length > limit || withheldByWatermark || anySourceHasMoreBeyondFetch;
  const page = hasMore ? emittable.slice(0, limit) : emittable;
  const last = page[page.length - 1];

  if (!hasMore || !last) return { entries: page, nextCursor: null };

  const nextPayload: CombinedCursorPayload = { at: last.at.toISOString(), tie: tieOf(last) };
  for (const source of paginated) {
    // How many of THIS fetch's rows are still "new" this round (not
    // already emitted on an earlier page) — comparing against the raw
    // fetched count would be wrong once a re-fetched batch's leading rows
    // have already been consumed previously (see this function's doc
    // comment, point 1). Rows withheld by the watermark correctly count as
    // "still pending" here too, since they did NOT make it into `page`.
    const pendingFromSource = source.entries.filter((e) => isPastCursor(e, cursor)).length;
    const consumedCount = page.filter((e) => matchesSourceKey(e, source.key)).length;
    const fullyConsumed = consumedCount === pendingFromSource;
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
    fromDate: filters.fromDate?.toISOString() ?? null,
    toDate: filters.toDate?.toISOString() ?? null,
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
    fromDate: filters.fromDate?.toISOString() ?? null,
    toDate: filters.toDate?.toISOString() ?? null,
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
    before: row.before,
    after: row.after,
  };
}

/** ONE combined audit_events query across the issue's whole object graph (issue + its tasks/holds/phase_instances ids, each id set fetched in its own single bounded query first). Fetches fetchLimit+1 to know whether more remain, same convention as every other keyset query in this codebase. */
async function fetchIssueObjectGraphAuditBatch(db: DbHandle, issueId: string, filters: NormalizedFilters, sourceCursor: string | undefined, fetchLimit: number): Promise<PaginatedBatch> {
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
  if (filters.fromDate) conditions.push(gte(auditEvents.occurredAt, filters.fromDate));
  if (filters.toDate) conditions.push(lte(auditEvents.occurredAt, filters.toDate));
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

/** Standard "seek method" predicate: strictly past `decoded` in (occurred_at DESC, id DESC) order — same shape as comms-repo.ts's/audit-metrics-repo.ts's keysetPredicate. */
function auditKeysetBefore(decoded: { at: string; tie: string }): SQL {
  return sql`(
    (${auditEvents.occurredAt} < ${decoded.at}::timestamptz)
    OR (${auditEvents.occurredAt} = ${decoded.at}::timestamptz AND ${auditEvents.id} < ${decoded.tie}::uuid)
  )`;
}

/** Direct read of phase_instances (NOT via audit_events — see this module's header comment). Small per-issue cardinality: fetched in full every page, bounded defensively, then filtered in memory (kinds + date range) — see NormalizedFilters.fromDate/toDate's doc comment on why these "small" sources skip SQL pushdown. */
async function fetchPhaseEntries(db: DbHandle, issueId: string, filters: NormalizedFilters): Promise<TimelineEntry[]> {
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
  return entries.filter((e) => inDateRange(e.at, filters));
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
  return rows
    .map(
      (n): TimelineEntry => ({
        at: n.sentAt ?? n.createdAt,
        kind: 'notice' as const,
        title: `Notice ${n.status}`,
        detail: n.cureDeadline ? `Cure deadline ${n.cureDeadline}` : null,
        actor: null,
        sourceTable: 'notices',
        sourceId: n.id,
      }),
    )
    .filter((e) => inDateRange(e.at, filters));
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
      ? fetchIssueObjectGraphAuditBatch(db, params.issueId, filters, cursor?.audit, fetchLimit)
      : Promise.resolve<PaginatedBatch>({ key: 'audit', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: cursor?.audit }),
    wants('phase_open') || wants('phase_close') ? fetchPhaseEntries(db, params.issueId, filters) : Promise.resolve([]),
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
    wants('issue_link') ? fetchIssueLinkEntries(db, params.personRefId, filters) : Promise.resolve([]),
    wants('audit')
      ? fetchPersonObjectAuditBatch(db, params.personRefId, filters, cursor?.audit, fetchLimit)
      : Promise.resolve<PaginatedBatch>({ key: 'audit', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: cursor?.audit }),
  ]);

  return mergeAndPaginate(linkEntries, [commsBatch, auditBatch], cursor, limit);
}

async function fetchIssueLinkEntries(db: DbHandle, personRefId: string, filters: NormalizedFilters): Promise<TimelineEntry[]> {
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
  return entries.filter((e) => inDateRange(e.at, filters));
}

async function fetchPersonObjectAuditBatch(db: DbHandle, personRefId: string, filters: NormalizedFilters, sourceCursor: string | undefined, fetchLimit: number): Promise<PaginatedBatch> {
  if (sourceCursor === SOURCE_DONE) return { key: 'audit', entries: [], repoNextCursor: null, fetchedCount: 0, cursorUsed: sourceCursor };

  const conditions: SQL[] = [eq(auditEvents.objectTable, 'person_refs'), eq(auditEvents.objectId, personRefId)];
  if (filters.fromDate) conditions.push(gte(auditEvents.occurredAt, filters.fromDate));
  if (filters.toDate) conditions.push(lte(auditEvents.occurredAt, filters.toDate));
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

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
