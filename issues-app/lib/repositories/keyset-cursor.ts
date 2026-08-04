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

import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
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

/**
 * ROUND-3 FIX (P1: keyset-cursor.ts:23-28 et al): every cursor timestamp in
 * this package used to be minted from a JS `Date.prototype.toISOString()`
 * (millisecond resolution), then bound back as `::timestamptz` (microsecond
 * resolution) — whenever a boundary row's timestamp carried a non-zero
 * sub-millisecond component (routine in production: `now()` is the
 * TRANSACTION timestamp, so every audit row one command writes shares one
 * value, and ~999/1000 real transaction timestamps have a non-zero
 * sub-millisecond part), the truncated cursor silently excluded every
 * remaining row in that microsecond group AND reported the feed complete.
 *
 * Fix: mint the cursor from Postgres's OWN rendering of the column,
 * converted to UTC and formatted with fixed-width microseconds via
 * `to_char`, instead of round-tripping through a JS Date. Every caller
 * selects this expression alongside the row's real columns (via
 * `drizzle-orm`'s `getTableColumns` spread + this field) and passes the
 * result straight to `encodeCursor` for the boundary row — no JS Date
 * involved, so no precision is lost. The predicate already casts the cursor
 * back with `::timestamptz`, and Postgres always accepts this exact ISO
 * 8601 + `Z` shape as input regardless of the session's DateStyle/TimeZone
 * GUCs, so this round-trips losslessly end to end.
 */
export function cursorTimestampExpr(column: SQLWrapper): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const CURSOR_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * ROUND-3 FIX (P2: keyset-cursor.ts:66-68 et al): the round-2 fix
 * canonicalized a cursor's timestamp via `new Date(Date.parse(x)).toISOString()`,
 * which is a NO-OP for ISO 8601 extended-year (`+010000-01-01T...`) and
 * year-0000 (`0000-01-01T...`) strings — both parse fine in JS, round-trip
 * byte-for-byte through `toISOString()`, and then blow up as a raw
 * `date/time field value out of range`/`time zone displacement out of
 * range` driver error at the `::timestamptz` cast, exactly the crash the
 * "malformed cursor -> page 1" contract was supposed to prevent.
 *
 * Fix: validate the EXACT canonical shape this package's own
 * `cursorTimestampExpr` always produces — 4-digit year (so an extended-year
 * `+`/`-` prefix can never appear at all, since the regex is fully
 * anchored), then a genuine calendar-correctness check (year/month/day/
 * hour/minute/second round-trip through `Date.UTC`) so a structurally
 * regex-shaped but calendar-invalid value (month 13, day 32, hour 24, a
 * year-0000 that Postgres rejects even though it's 4 digits) is caught
 * here rather than surfacing as a driver error later. The 6-digit
 * microsecond group is validated by the regex only (any 000000-999999
 * value is a valid Postgres fractional-seconds field, so no further check
 * is needed there) and is never round-tripped through a JS Date, which
 * cannot represent it anyway.
 */
export function isValidCursorTimestamp(at: string): boolean {
  const m = CURSOR_TIMESTAMP_RE.exec(at);
  if (!m) return false;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = m;
  const year = Number(yearStr);
  // Postgres has no year 0000 (year 1 BC is written "0001-01-01 BC", not
  // "0000-01-01") — reject outright rather than let it reach the cast.
  if (year < 1) return false;
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(ms)) return false;
  const check = new Date(ms);
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second
  );
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
    if (tie.length === 0 || tie.length > 200) return null;
    // INJECTION FUZZ finding (round 2): `tie` (and, belt-and-braces, `at`)
    // can end up bound as a raw text parameter downstream (tie-break
    // comparisons) — a NUL byte here would 500 with a raw Postgres
    // "invalid byte sequence" error instead of the "malformed cursor ->
    // page 1" contract this function otherwise guarantees. Reject rather
    // than silently strip, since altering a cursor's value could
    // otherwise reorder/skip rows. Checked against `rawAt` (the raw decoded
    // value), BEFORE the timestamp canonicalization below — canonicalizing
    // first would launder a NUL byte straight out of `at` (a fresh
    // `toISOString()` string can never contain one) and silently defeat
    // this check.
    if (containsNulByte(rawAt) || containsNulByte(tie)) return null;
    // ROUND-3 FIX (P2): validate against the EXACT shape cursorTimestampExpr
    // always produces (see its doc comment) instead of round-tripping
    // through Date.parse/toISOString, which is a no-op for — and therefore
    // does not reject — extended-year and year-0000 strings that Postgres's
    // timestamptz parser rejects at the `::timestamptz` cast.
    if (!isValidCursorTimestamp(rawAt)) return null;
    return { at: rawAt, tie };
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
