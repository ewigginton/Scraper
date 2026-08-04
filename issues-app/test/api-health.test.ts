/**
 * api-health.test.ts — coverage for app/api/health/route.ts's auth gate
 * (P2 info-leak finding, round 2).
 *
 * Before the fix, this route had NO auth gate of any kind and returned the
 * raw driver error message plus rolsuper/rolbypassrls to ANY unauthenticated
 * caller — pre-auth reconnaissance into internal DB detail and whether RLS
 * is currently inert. The fix gates all of that behind a shared-secret
 * `x-health-token` header (ISSUES_HEALTH_TOKEN); everyone else gets a bare
 * `{ ok }` liveness answer.
 *
 * Run with no DATABASE_URL configured (this suite's default env), so every
 * request exercises the tryGetDb()-is-null branch — the shallowest, DB-free
 * path through the route, which is enough to prove the auth-gating
 * behavior without needing a live Postgres connection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ORIGINAL_TOKEN = process.env.ISSUES_HEALTH_TOKEN;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ISSUES_DEMO = process.env.ISSUES_DEMO;

describe('GET /api/health auth gate', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.ISSUES_DEMO;
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.ISSUES_HEALTH_TOKEN;
    else process.env.ISSUES_HEALTH_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (ORIGINAL_ISSUES_DEMO === undefined) delete process.env.ISSUES_DEMO;
    else process.env.ISSUES_DEMO = ORIGINAL_ISSUES_DEMO;
  });

  it('an unauthenticated request gets ok:false with no reason/detail field at all', async () => {
    delete process.env.ISSUES_HEALTH_TOKEN;
    const { GET } = await import('../app/api/health/route.ts');
    const res = await GET(new Request('http://localhost/api/health'));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body).not.toHaveProperty('reason');
    expect(body).not.toHaveProperty('rolsuper');
    expect(body).not.toHaveProperty('rolbypassrls');
  });

  it('presenting a WRONG x-health-token still withholds detail', async () => {
    process.env.ISSUES_HEALTH_TOKEN = 'the-real-secret';
    const { GET } = await import('../app/api/health/route.ts');
    const res = await GET(new Request('http://localhost/api/health', { headers: { 'x-health-token': 'guessed-wrong' } }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body).not.toHaveProperty('reason');
  });

  it('presenting the CORRECT x-health-token reveals the reason detail', async () => {
    process.env.ISSUES_HEALTH_TOKEN = 'the-real-secret';
    const { GET } = await import('../app/api/health/route.ts');
    const res = await GET(new Request('http://localhost/api/health', { headers: { 'x-health-token': 'the-real-secret' } }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('DATABASE_URL is not configured.');
  });

  it('REGRESSION: when ISSUES_HEALTH_TOKEN is unset entirely, detail is withheld from EVERYONE (fails closed, not open) even if a header is guessed', async () => {
    delete process.env.ISSUES_HEALTH_TOKEN;
    const { GET } = await import('../app/api/health/route.ts');
    // An empty/undefined expected token must never match an empty/undefined
    // provided header — otherwise omitting ISSUES_HEALTH_TOKEN in prod would
    // accidentally leave the detailed path open to everyone.
    const res = await GET(new Request('http://localhost/api/health', { headers: { 'x-health-token': '' } }));
    const body = await res.json();
    expect(body).not.toHaveProperty('reason');
  });
});
