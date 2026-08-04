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
    const [at, tie] = parsed as [unknown, unknown];
    if (typeof at !== 'string' || typeof tie !== 'string') return null;
    if (Number.isNaN(Date.parse(at))) return null;
    if (tie.length === 0 || tie.length > 200) return null;
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
