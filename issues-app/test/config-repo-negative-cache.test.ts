/**
 * config-repo-negative-cache.test.ts — regression coverage for the ROUND-2
 * P1 finding: config-repo.ts's in-memory `currentVersionCache`/`entryCache`
 * used to cache a MISS (undefined) exactly the same as a hit. An actor-less
 * (or RLS-filtered) read — e.g. app/issues/new/page.tsx before its
 * withActor fix — produces a miss under `config_versions_select_broad_internal`
 * ("using (issues_current_actor() is not null)"), and that miss then got
 * cached process-wide for CACHE_TTL_MS (30s), silently starving every
 * SUBSEQUENT, correctly actor-scoped caller (including transitionPhase's
 * loadTransitionDefinitions) of the real config value for the rest of the
 * TTL — disabling the entire transition engine ("Allowed destinations:
 * none") for up to 30 seconds after a single anonymous/misconfigured read.
 *
 * BEFORE this fix: the assertion below fails (`value` is `undefined`,
 * poisoned by the actor-less miss in step 1).
 * AFTER this fix: `value` is defined — a miss is never cached.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as configRepo from '../lib/repositories/config-repo.ts';
import { closeTestDb, createTestDb, setActorContext, type TestDbHandle } from './helpers/pglite.ts';

const TEST_ROLE = 'issues_config_negative_cache_test_role';

describe('config-repo: a miss is never cached (P1 regression)', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
    await handle.client.exec(`create role ${TEST_ROLE} nosuperuser noinherit login;`);
    await handle.client.exec(`grant select on config_versions, config_entries to ${TEST_ROLE};`);
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('an actor-less RLS-filtered miss does not poison a later, correctly actor-scoped read of the same config key', async () => {
    await handle.client.exec(`set role ${TEST_ROLE};`);

    // Step 1: an actor-less read — no app.actor_id ever set on this
    // connection — exactly what a page that forgot withActor produces.
    // config_versions_select_broad_internal's `issues_current_actor() is
    // not null` filters every row out, so this is a genuine miss, not an
    // error.
    configRepo.clearCache();
    const miss = await configRepo.currentVersion(handle.db, 'phase_1_defaults');
    expect(miss).toBeUndefined();

    // Step 2: a correctly actor-scoped read, immediately after, in the same
    // process (same in-memory cache, well within the 30s TTL) — must see
    // the real, currently-effective config version, not a cached miss from
    // step 1.
    const version = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-coordinator', ['coordinator']);
      return configRepo.currentVersion(tx, 'phase_1_defaults');
    });
    expect(version).toBeDefined();

    // Same story one level down, for configRepo.get (what listIssueTypes /
    // the transition engine's loadTransitionDefinitions actually call).
    configRepo.clearCache();
    const entryMiss = await configRepo.get(handle.db, 'phase_1_defaults', 'issue_types');
    expect(entryMiss).toBeUndefined();

    const entryValue = await handle.db.transaction(async (tx) => {
      await setActorContext(tx, 'actor-coordinator', ['coordinator']);
      return configRepo.get(tx, 'phase_1_defaults', 'issue_types');
    });
    expect(entryValue).toBeDefined();
  });
});
