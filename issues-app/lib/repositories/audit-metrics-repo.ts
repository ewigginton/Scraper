/**
 * audit-metrics-repo — read-only aggregate/feed views over `audit_events`
 * for the global Activity feed and the admin activity-by-actor metrics
 * (roadmap "Change log everywhere" / "Admin activity metrics", spec §8.2,
 * §14). Distinct from lib/repositories/audit-repo.ts (single-object trail,
 * used by case pages) and lib/repositories/timeline-repo.ts (per-issue/
 * per-person multi-source interleave) — this module is company-wide.
 *
 * Actor identity (per 20260731090500_issues_rls_audit_hardening.sql):
 * actor_external_id is the Hub staff identity string every command
 * populates today; actor_id (a person_refs uuid) is the rarer case.
 * coalesce(actor_external_id, actor_id::text, 'unattributed') is the ONE
 * identity expression used everywhere in this file — activitiesByActor's
 * grouping and recentActivity's actor filter both key off it, so a caller
 * that filters recentActivity by an activitiesByActor row's `actor` value
 * gets exactly that actor's rows back.
 *
 * No business rules here (DESIGN.md §6) — reads only.
 */

import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { auditEvents, type AuditEvent } from '../db/schema.ts';
import { clampLimit, decodeCursor, encodeCursor } from './keyset-cursor.ts';
import { isUuid, sanitizeText } from './id-guard.ts';

/**
 * object_table values any shipped command actually writes today (grepped
 * from every `objectTable:` literal under lib/services/*.ts) — the runtime
 * allowlist for the `category`/`objectTables` filter params below, same
 * duplication-of-the-real-set convention as issues-query-repo.ts's
 * VALID_ISSUE_TYPES. communication_events/communication_links are
 * deliberately absent: comms are never audited via audit_events (they're
 * their own append-only record, spec §28.6), so 'communication' is not a
 * valid audit category.
 */
export const VALID_OBJECT_TABLES = new Set([
  'approvals',
  'holds',
  'issues',
  'payment_requests',
  'possession_records',
  'saved_views',
  'stale_acknowledgments',
  'tasks',
]);

/** The one actor-identity expression this whole module agrees on. */
const ACTOR_EXPR = sql<string>`coalesce(${auditEvents.actorExternalId}, ${auditEvents.actorId}::text, 'unattributed')`;

const MAX_STRING_LEN = 200;
const MAX_ACTOR_ROWS = 500;

function sanitizeDateBound(input: unknown): Date | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, MAX_STRING_LEN);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function sanitizeCategory(input: unknown): string | null {
  return typeof input === 'string' && VALID_OBJECT_TABLES.has(input) ? input : null;
}

function sanitizeCategories(input: unknown): { requested: boolean; values: string[] } {
  if (!Array.isArray(input)) return { requested: false, values: [] };
  const values = [...new Set(input.filter((v): v is string => typeof v === 'string' && VALID_OBJECT_TABLES.has(v)))];
  return { requested: input.length > 0, values };
}

/**
 * Delegates to id-guard.sanitizeText (INJECTION FUZZ finding, round 2):
 * this previously only did `.trim().slice(...)` with no NUL-byte strip, so
 * a `%00` in `actor` reached the wire as a bound parameter's value and
 * 500'd with a raw Postgres "invalid byte sequence" driver error on
 * /activity instead of behaving like every other free-text filter.
 */
function sanitizeActor(input: unknown): string | null {
  return sanitizeText(input, MAX_STRING_LEN);
}

// ---------------------------------------------------------------------
// activitiesByActor
// ---------------------------------------------------------------------

export interface ActivitiesByActorParams {
  from?: string | null;
  to?: string | null;
  category?: string | null;
}

export interface ActorActivityRow {
  actor: string;
  count: number;
}

/** Number of audit_events by actor (spec §8.2 coordinator-performance / §14 baseline metrics), optionally scoped to a date range and one object_table category. Bounded to MAX_ACTOR_ROWS distinct actors, ordered busiest-first. */
export async function activitiesByActor(db: DbHandle, params: ActivitiesByActorParams = {}): Promise<ActorActivityRow[]> {
  const from = sanitizeDateBound(params.from);
  const to = sanitizeDateBound(params.to);
  const category = sanitizeCategory(params.category ?? null);

  const conditions: SQL[] = [];
  if (from) conditions.push(gte(auditEvents.occurredAt, from));
  if (to) conditions.push(lte(auditEvents.occurredAt, to));
  if (category) conditions.push(eq(auditEvents.objectTable, category));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({ actor: ACTOR_EXPR, count: sql<number>`count(*)`.mapWith(Number) })
    .from(auditEvents)
    .where(where)
    .groupBy(ACTOR_EXPR)
    .orderBy(desc(sql`count(*)`), ACTOR_EXPR)
    .limit(MAX_ACTOR_ROWS);

  return rows;
}

// ---------------------------------------------------------------------
// recentActivity
// ---------------------------------------------------------------------

export interface RecentActivityFilters {
  /** object_table allowlist (spec "filterable by ... case / person / action category"); requested-but-nothing-valid matches nothing, same idiom as issues-query-repo.ts. */
  objectTables?: string[];
  /** Matches the SAME coalesce(actor_external_id, actor_id::text, 'unattributed') identity activitiesByActor groups by. */
  actor?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface RecentActivityParams {
  filters?: RecentActivityFilters;
  limit?: number | null;
  cursor?: string | null;
}

export interface RecentActivityResult {
  rows: AuditEvent[];
  nextCursor: string | null;
}

function keysetPredicate(cursor: { at: string; tie: string }): SQL | undefined {
  if (!isUuid(cursor.tie)) return undefined;
  return sql`(
    (${auditEvents.occurredAt} < ${cursor.at}::timestamptz)
    OR (${auditEvents.occurredAt} = ${cursor.at}::timestamptz AND ${auditEvents.id} < ${cursor.tie}::uuid)
  )`;
}

/** The global, company-wide activity feed (roadmap "Change log everywhere"), newest first, keyset-paginated. */
export async function recentActivity(db: DbHandle, params: RecentActivityParams = {}): Promise<RecentActivityResult> {
  const limit = clampLimit(params.limit);
  const objectTables = sanitizeCategories(params.filters?.objectTables);
  const actor = sanitizeActor(params.filters?.actor ?? null);
  const from = sanitizeDateBound(params.filters?.from ?? null);
  const to = sanitizeDateBound(params.filters?.to ?? null);
  const decoded = decodeCursor(params.cursor);
  const cursorPredicate = decoded ? keysetPredicate(decoded) : undefined;
  // A structurally valid cursor whose tie isn't a uuid can't be ours — treat exactly like a missing cursor (page 1) rather than silently matching nothing.
  const cursor = decoded && cursorPredicate ? decoded : null;

  const conditions: SQL[] = [];
  if (objectTables.requested) {
    conditions.push(objectTables.values.length === 0 ? sql`false` : inArray(auditEvents.objectTable, objectTables.values));
  }
  if (actor) conditions.push(sql`${ACTOR_EXPR} = ${actor}`);
  if (from) conditions.push(gte(auditEvents.occurredAt, from));
  if (to) conditions.push(lte(auditEvents.occurredAt, to));
  if (cursor) {
    const predicate = keysetPredicate(cursor);
    if (predicate) conditions.push(predicate);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt.toISOString(), last.id) : null;

  return { rows: page, nextCursor };
}
