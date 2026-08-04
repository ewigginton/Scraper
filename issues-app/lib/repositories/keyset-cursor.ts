/**
 * keyset-cursor — shared opaque-cursor encode/decode for every "newest
 * first" keyset-paginated feed added in this module (comms-repo,
 * timeline-repo, audit-metrics-repo). Mirrors the base64url JSON `[sortValue,
 * id]` shape lib/repositories/issues-query-repo.ts established, generalized
 * so it isn't tied to the `issues` table's id column: this file's callers
 * page over communication_events, audit_events, and (in timeline-repo) a
 * merged multi-table feed keyed by a synthetic `sourceTable:sourceId` tie
 * breaker instead of a bare uuid.
 *
 * Decoding NEVER throws — any malformed/hostile cursor string decodes to
 * `null`, which every caller here treats as "start over from page 1" rather
 * than a thrown error (same contract as issues-query-repo.decodeCursor).
 */

import { containsNulByte } from './id-guard.ts';

export interface DecodedCursor {
  /** ISO timestamp string of the row the previous page ended on. */
  at: string;
  /** Tiebreaker for rows sharing the same `at` — a table id, or `table:id` for a merged feed. */
  tie: string;
}

const MAX_CURSOR_LEN = 2000;

/** Encode an opaque "resume after this row" cursor. */
export function encodeCursor(at: string, tie: string): string {
  return Buffer.from(JSON.stringify([at, tie]), 'utf8').toString('base64url');
}

/** Returns null (treat as first page) on ANY malformed input — never throws. */
export function decodeCursor(raw: string | null | undefined): DecodedCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LEN) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [rawAt, tie] = parsed as [unknown, unknown];
    if (typeof rawAt !== 'string' || typeof tie !== 'string') return null;
    // ROUND-2 FIX (P2): Date.parse() accepts far more formats than
    // Postgres's timestamptz parser (e.g. RFC-2822-with-trailing-zone-name
    // strings like "Sat, 01 Jan 2024 00:00:00 GMT+0000 (Coordinated
    // Universal Time)"). A cursor carrying one of those used to sail past
    // this guard and then blow up as a raw driver error at the `::timestamptz`
    // cast in comms-repo.ts/audit-metrics-repo.ts/timeline-repo.ts instead
    // of the "malformed cursor -> page 1" contract this function promises.
    // Canonicalize to a real ISO string instead of merely checking
    // parseability: every legitimate cursor was minted by encodeCursor from
    // `.toISOString()` in the first place (see the callers in comms-repo.ts
    // etc.), so re-deriving the canonical ISO string never changes a valid
    // cursor's value, and a canonical ISO string always parses in Postgres.
    const atMs = Date.parse(rawAt);
    if (Number.isNaN(atMs)) return null;
    const at = new Date(atMs).toISOString();
    if (tie.length === 0 || tie.length > 200) return null;
    // INJECTION FUZZ finding (round 2): `tie` (and, belt-and-braces, `at`)
    // can end up bound as a raw text parameter downstream (tie-break
    // comparisons) — a NUL byte here would 500 with a raw Postgres
    // "invalid byte sequence" error instead of the "malformed cursor ->
    // page 1" contract this function otherwise guarantees. Reject rather
    // than silently strip, since altering a cursor's value could
    // otherwise reorder/skip rows.
    if (containsNulByte(at) || containsNulByte(tie)) return null;
    return { at, tie };
  } catch {
    return null;
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Same clamp policy as issues-query-repo.ts: non-finite/non-positive falls back to the default; everything else is capped at MAX_LIMIT. */
export function clampLimit(raw: number | null | undefined, defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return defaultLimit;
  return Math.min(Math.floor(raw), maxLimit);
}
