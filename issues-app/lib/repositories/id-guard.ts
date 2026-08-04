/**
 * id-guard — tiny shared validators for untrusted uuid-shaped input at the
 * repo layer (comms-repo, timeline-repo, audit-metrics-repo). Every id that
 * reaches a `::uuid` cast or an `inArray`/`eq` against a uuid column comes
 * from a URL param or cursor payload and MUST be validated here first — an
 * invalid string reaching a `::uuid` cast throws a raw driver error instead
 * of failing safely, and Drizzle's `inArray`/`eq` happily bind a non-uuid
 * string as a parameter (Postgres, not Drizzle, would be the one to reject
 * it, and only for the cast case, not a plain `= any(...)` text compare).
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const MAX_ID_ARRAY = 100;

/** Filters an untrusted array down to well-formed, de-duplicated uuid strings, capped at MAX_ID_ARRAY. Non-array/non-string entries are dropped silently, never thrown. */
export function sanitizeUuidArray(input: unknown, max = MAX_ID_ARRAY): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (isUuid(raw)) {
      seen.add(raw.toLowerCase());
      if (seen.size >= max) break;
    }
  }
  return [...seen];
}
