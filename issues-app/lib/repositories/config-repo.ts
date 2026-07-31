/**
 * config-repo — all DB access for `config_versions` / `config_entries`
 * (config-as-data, spec §12). Values are cached in-memory per
 * (config_key, entry_key), with a short TTL, since configuration changes
 * rarely but is read on hot paths (transition engine, eligibility checks).
 * Call `clearCache()` after writing a new config_versions/config_entries
 * row in the same process (e.g. in tests, or an admin-config command) for
 * an immediate cache-bust rather than waiting out the TTL.
 *
 * ADVERSARIAL-REVIEW FIX: this cache used to have no TTL and no
 * invalidation hook at all, so a release-safety config change (tightening
 * a transition prerequisite, changing the bid threshold) had no effect
 * until the process restarted — there is no admin/config write UI in this
 * phase, so clearCache() was called only from tests. A short TTL
 * (CACHE_TTL_MS) makes effective-dated config versions (config_versions.
 * effective_from in the future) actually activate on schedule, and bounds
 * how stale a release-safety rule can be after any config change, without
 * requiring a LISTEN/NOTIFY or per-request version-stamp mechanism (left
 * as a documented follow-up for a genuinely multi-process deployment —
 * this phase runs a single Next.js process per DESIGN.md §4).
 */

import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { DbHandle } from './db-handle.ts';
import { configEntries, configVersions, type ConfigVersion } from '../db/schema.ts';

/** How long a cached value is trusted before being re-read from the DB. */
const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const entryCache = new Map<string, CacheEntry<unknown>>();
const currentVersionCache = new Map<string, CacheEntry<ConfigVersion | undefined>>();

function cacheKey(configKey: string, entryKey: string): string {
  return `${configKey} ${entryKey}`;
}

function freshValue<T>(cache: Map<string, CacheEntry<T>>, key: string): { hit: true; value: T } | { hit: false } {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return { hit: true, value: entry.value };
  }
  if (entry) {
    cache.delete(key);
  }
  return { hit: false };
}

/**
 * The currently effective config_versions row for a config_key: the row
 * whose effective_from <= now and (effective_to IS NULL OR effective_to >
 * now), most recently effective_from first.
 */
export async function currentVersion(db: DbHandle, configKey: string): Promise<ConfigVersion | undefined> {
  const cached = freshValue(currentVersionCache, configKey);
  if (cached.hit) {
    return cached.value;
  }

  const now = new Date();
  const [row] = await db
    .select()
    .from(configVersions)
    .where(
      and(
        eq(configVersions.configKey, configKey),
        lte(configVersions.effectiveFrom, now),
        or(isNull(configVersions.effectiveTo), gt(configVersions.effectiveTo, now)),
      ),
    )
    .orderBy(desc(configVersions.effectiveFrom))
    .limit(1);

  currentVersionCache.set(configKey, { value: row, expiresAt: Date.now() + CACHE_TTL_MS });
  return row;
}

/**
 * Get a single config_entries.entry_value for the currently effective
 * version of configKey, by entryKey. Returns undefined if there is no
 * current version or no matching (non-retired) entry.
 */
export async function get<T = unknown>(db: DbHandle, configKey: string, entryKey: string): Promise<T | undefined> {
  const key = cacheKey(configKey, entryKey);
  const cached = freshValue(entryCache, key);
  if (cached.hit) {
    return cached.value as T | undefined;
  }

  const version = await currentVersion(db, configKey);
  if (!version) {
    entryCache.set(key, { value: undefined, expiresAt: Date.now() + CACHE_TTL_MS });
    return undefined;
  }

  const [row] = await db
    .select()
    .from(configEntries)
    .where(
      and(
        eq(configEntries.configVersionId, version.id),
        eq(configEntries.entryKey, entryKey),
        eq(configEntries.retired, false),
      ),
    );

  const value = row?.entryValue as T | undefined;
  entryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Clear the in-memory cache. Call after writing config_versions/config_entries. */
export function clearCache(): void {
  entryCache.clear();
  currentVersionCache.clear();
}
