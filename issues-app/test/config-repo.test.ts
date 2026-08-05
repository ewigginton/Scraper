/**
 * config-repo.test.ts — regression coverage for `currentVersion`'s
 * ordering determinism (adversarial-review finding): `ORDER BY
 * effective_from DESC LIMIT 1` with no secondary tiebreak means two
 * config_versions rows sharing an identical effective_from would make
 * "which one is current" arbitrary/row-order-dependent rather than
 * deterministically the newer one. A secondary `created_at DESC, id DESC`
 * tiebreak makes it deterministic even on an exact effective_from tie.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, lte } from 'drizzle-orm';
import * as configRepo from '../lib/repositories/config-repo.ts';
import { configEntries, configVersions } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, type TestDbHandle } from './helpers/pglite.ts';

describe('config-repo: currentVersion ordering determinism', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('ADVERSARIAL-REVIEW REGRESSION: two versions sharing an identical effective_from resolve deterministically to the one created later, not row order', async () => {
    const tiedEffectiveFrom = new Date('2026-01-01T00:00:00Z');

    const [older] = await handle.db
      .insert(configVersions)
      .values({
        configKey: 'tiebreak_test',
        versionLabel: 'older',
        effectiveFrom: tiedEffectiveFrom,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning();
    await handle.db.insert(configEntries).values({
      configVersionId: older!.id,
      entryKey: 'marker',
      entryValue: { which: 'older' },
    });

    const [newer] = await handle.db
      .insert(configVersions)
      .values({
        configKey: 'tiebreak_test',
        versionLabel: 'newer',
        effectiveFrom: tiedEffectiveFrom,
        createdAt: new Date('2026-01-02T00:00:00Z'),
      })
      .returning();
    await handle.db.insert(configEntries).values({
      configVersionId: newer!.id,
      entryKey: 'marker',
      entryValue: { which: 'newer' },
    });

    configRepo.clearCache();
    const current = await configRepo.currentVersion(handle.db, 'tiebreak_test');
    expect(current?.id).toBe(newer!.id);

    configRepo.clearCache();
    const marker = await configRepo.get<{ which: string }>(handle.db, 'tiebreak_test', 'marker');
    expect(marker?.which).toBe('newer');
  });

  it('when created_at ALSO ties, the higher id wins deterministically (repeated calls agree, never flip)', async () => {
    const tied = new Date('2026-02-01T00:00:00Z');
    const [a] = await handle.db
      .insert(configVersions)
      .values({ configKey: 'full_tie_test', versionLabel: 'a', effectiveFrom: tied, createdAt: tied })
      .returning();
    const [b] = await handle.db
      .insert(configVersions)
      .values({ configKey: 'full_tie_test', versionLabel: 'b', effectiveFrom: tied, createdAt: tied })
      .returning();
    const expectedWinnerId = [a!.id, b!.id].sort().reverse()[0];

    configRepo.clearCache();
    const first = await configRepo.currentVersion(handle.db, 'full_tie_test');
    configRepo.clearCache();
    const second = await configRepo.currentVersion(handle.db, 'full_tie_test');

    expect(first?.id).toBe(expectedWinnerId);
    expect(second?.id).toBe(expectedWinnerId);
  });
});

describe('20260731090800_issues_config_v1_retire.sql', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('retires v1 explicitly (effective_to = v2.effective_from) so at most one phase_1_defaults version is ever "current"', async () => {
    const versions = await handle.db.select().from(configVersions).where(eq(configVersions.configKey, 'phase_1_defaults'));
    const v1 = versions.find((v) => v.versionLabel === '1');
    const v2 = versions.find((v) => v.versionLabel === '2');
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect(v1?.effectiveTo).not.toBeNull();
    expect(v1?.effectiveTo?.getTime()).toBe(v2?.effectiveFrom.getTime());

    // The actual invariant that matters: regardless of ORDER BY tie-break
    // behavior, the "currently effective" WHERE clause matches EXACTLY one
    // row for this config_key.
    const now = new Date();
    const currentlyEffective = await handle.db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.configKey, 'phase_1_defaults'), lte(configVersions.effectiveFrom, now), isNull(configVersions.effectiveTo)));
    expect(currentlyEffective.length).toBe(1);
    expect(currentlyEffective[0]?.versionLabel).toBe('2');
  });
});
