/**
 * auth-stub.test.ts — regression coverage for lib/auth/current-user.ts's
 * production guard (adversarial-review finding): the guard used to fire
 * ONLY on the exact string NODE_ENV === 'production', so an UNSET
 * NODE_ENV (a custom entrypoint, a container that forgets to set it, a
 * preview/staging target left at 'development') sailed past it and handed
 * the unconditional coordinator identity to every anonymous request. The
 * fix inverts this to an allowlist of known-safe contexts, failing closed
 * on everything else — including unset.
 */
import { afterEach, describe, expect, it } from 'vitest';

const ENV_KEYS = ['NODE_ENV', 'VITEST', 'ISSUES_ALLOW_AUTH_STUB'] as const;

// process.env.NODE_ENV is typed read-only by @types/node; this suite
// deliberately manipulates it (and VITEST/ISSUES_ALLOW_AUTH_STUB) to
// exercise every branch of the production guard, so go through a mutable
// view of the same underlying object rather than fighting the type.
const mutableEnv = process.env as Record<string, string | undefined>;

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete mutableEnv[key];
  else mutableEnv[key] = value;
}

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snap[key] = mutableEnv[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) setEnv(key, snap[key]);
}

describe('lib/auth/current-user.ts: production guard', () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it('ADVERSARIAL-REVIEW REGRESSION: an unset NODE_ENV (outside the test runner) refuses the stub, it does not fail open', async () => {
    setEnv('NODE_ENV', undefined);
    setEnv('VITEST', undefined);
    setEnv('ISSUES_ALLOW_AUTH_STUB', undefined);

    // Force a fresh module evaluation isn't required — getCurrentUser reads
    // process.env at call time, not at import time.
    const { getCurrentUser } = await import('../lib/auth/current-user.ts');
    await expect(getCurrentUser()).rejects.toThrow(/development-only auth stub/);
  });

  it('NODE_ENV="production" still refuses the stub', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('VITEST', undefined);
    setEnv('ISSUES_ALLOW_AUTH_STUB', undefined);

    const { getCurrentUser } = await import('../lib/auth/current-user.ts');
    await expect(getCurrentUser()).rejects.toThrow(/development-only auth stub/);
  });

  it('NODE_ENV="development" allows the stub', async () => {
    setEnv('NODE_ENV', 'development');
    setEnv('VITEST', undefined);
    setEnv('ISSUES_ALLOW_AUTH_STUB', undefined);

    const { getCurrentUser } = await import('../lib/auth/current-user.ts');
    const user = await getCurrentUser();
    expect(user.roles).toEqual(['coordinator']);
    expect(user.name).toBe('Dev User');
  });

  it('ISSUES_ALLOW_AUTH_STUB=true allows the stub even with no NODE_ENV, but labels the identity unmistakably', async () => {
    setEnv('NODE_ENV', undefined);
    setEnv('VITEST', undefined);
    setEnv('ISSUES_ALLOW_AUTH_STUB', 'true');

    const { getCurrentUser } = await import('../lib/auth/current-user.ts');
    const user = await getCurrentUser();
    expect(user.roles).toEqual(['coordinator']);
    expect(user.name).toBe('UNAUTHENTICATED DEV STUB');
  });
});
