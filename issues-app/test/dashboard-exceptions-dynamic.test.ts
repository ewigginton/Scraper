/**
 * dashboard-exceptions-dynamic.test.ts — regression guard for the round-2
 * P1 fix: /dashboard and /exceptions were the only two routes in app/ with
 * no dynamic API (no params/searchParams to await), so Next.js silently
 * static-prerendered them at BUILD time instead of per-request. That baked
 * a build-time "Database not configured" card into permanent HTML when
 * DATABASE_URL was unset at build, and HARD-FAILED the build when it was
 * set (because getCurrentUser()'s production guard threw during prerender,
 * having never actually been reached by real request traffic).
 *
 * This does NOT re-run `next build` (slow, and requires standing up/tearing
 * down a real or fake DATABASE_URL at build time — out of scope for the
 * unit suite; see PORTING.md for the documented manual-verify step: run
 * `npm run build` and confirm both routes show ƒ (Dynamic), not ○
 * (Static), in the route summary). What this test cheaply and reliably
 * catches is the actual regression mechanism: `export const dynamic =
 * 'force-dynamic'` being present (so Next.js can never again decide these
 * routes are static), and `getCurrentUser()` being called before the
 * `tryGetDb()` early return (so a missing/unreachable DATABASE_URL can
 * never again skip the auth-stub's production guard).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROUTES = [
  { name: 'dashboard', url: new URL('../app/dashboard/page.tsx', import.meta.url) },
  { name: 'exceptions', url: new URL('../app/exceptions/page.tsx', import.meta.url) },
];

function readText(url: URL): string {
  return readFileSync(url, 'utf8');
}

describe('dashboard/exceptions force-dynamic + auth-before-db fix (static regression guard)', () => {
  for (const { name, url } of ROUTES) {
    const src = readText(url);

    it(`${name}/page.tsx exports force-dynamic, so Next.js can never static-prerender it at build time again`, () => {
      expect(src).toMatch(/export const dynamic\s*=\s*['"]force-dynamic['"]/);
    });

    it(`${name}/page.tsx calls getCurrentUser() BEFORE the tryGetDb() null-db early return, so a missing DATABASE_URL can never skip the auth-stub's production guard`, () => {
      // Match the actual call-assignment statements, not prose in comments
      // (this file's own fix-rationale comments mention both function names).
      const getCurrentUserIndex = src.indexOf('const user = await getCurrentUser();');
      const tryGetDbIndex = src.indexOf('const db = tryGetDb();');
      expect(getCurrentUserIndex).toBeGreaterThan(-1);
      expect(tryGetDbIndex).toBeGreaterThan(-1);
      expect(getCurrentUserIndex).toBeLessThan(tryGetDbIndex);
    });
  }
});
