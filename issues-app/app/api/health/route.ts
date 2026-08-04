/**
 * app/api/health/route.ts — health check.
 *
 * ADVERSARIAL-REVIEW FIX (P1, missing GRANT finding): a misconfigured
 * deployment whose DATABASE_URL authenticates as a superuser or a
 * BYPASSRLS role (e.g. Supabase's default `postgres` role) silently
 * disables the ENTIRE RLS scaffold (supabase/migrations/
 * 20260731090200_issues_rls.sql, 20260731090500_issues_rls_audit_hardening.sql)
 * with no error anywhere — the app just runs, leaking whatever RLS was
 * supposed to hide. This assertion makes that failure LOUD instead of
 * silent: it fails the health check the moment the connection is wrong,
 * rather than waiting for someone to notice restricted evidence leaking in
 * production. See 20260731090700_issues_app_role_grants.sql, which
 * provisions the correct `issues_app` role (nosuperuser, nobypassrls) that
 * DATABASE_URL should authenticate as.
 *
 * ADVERSARIAL-REVIEW FIX (round 2, P2, info leak): this route has no auth
 * gate of any kind — the only route in the package that touches the DB
 * outside `withActor` — and used to return the raw driver error message
 * (`err.message`) plus `rolsuper`/`rolbypassrls` to ANY unauthenticated
 * caller. Driver errors in this position can carry infrastructure detail
 * (internal DB hostnames/IPs, the connecting role's name, auth-failure
 * detail), and rolsuper/rolbypassrls tell an outside caller whether RLS is
 * currently inert — pre-auth reconnaissance requirements line 872
 * explicitly forbids ("through ... APIs, or logs"). Now: (1) the raw
 * driver error is logged server-side only, never returned; (2) the
 * detailed privilege/reason payload requires a shared-secret header
 * (`ISSUES_HEALTH_TOKEN`, see .env.example) — everyone else gets a bare
 * ok/not-ok liveness answer.
 */
import { tryGetDb } from '../../_lib/db.ts';

/** True when the caller presented the configured health-check secret via the `x-health-token` header. If ISSUES_HEALTH_TOKEN is unset, detail is never shown to anyone (fails closed, not open). */
function isDetailedRequest(req: Request): boolean {
  const expected = process.env.ISSUES_HEALTH_TOKEN;
  if (!expected) return false;
  const provided = req.headers.get('x-health-token');
  return provided === expected;
}

export async function GET(req: Request) {
  const detailed = isDetailedRequest(req);
  const db = tryGetDb();
  if (!db) {
    // No DATABASE_URL configured at all — a real problem, but a different
    // one than the RLS-bypass check below; report it distinctly rather
    // than crashing this route.
    return Response.json({ ok: false, ...(detailed ? { reason: 'DATABASE_URL is not configured.' } : {}) }, { status: 503 });
  }

  try {
    const result = await db.execute('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
    const rows = (result as unknown as { rows?: Array<{ rolsuper: boolean; rolbypassrls: boolean }> }).rows ?? (result as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>);
    const row = rows[0];
    if (!row) {
      return Response.json({ ok: false, ...(detailed ? { reason: "Could not determine the connecting role's privileges." } : {}) }, { status: 503 });
    }
    if (row.rolsuper || row.rolbypassrls) {
      if (process.env.ISSUES_DEMO === '1') {
        // Demo mode runs on embedded PGlite, which only has a superuser —
        // expected there, and .demo-db holds only fictional fixture data.
        // The assertion stays LOUD for every real deployment below.
        return Response.json({
          ok: true,
          mode: 'demo',
          ...(detailed ? { note: 'Embedded demo database (PGlite); RLS is not enforced in demo mode.' } : {}),
        });
      }
      return Response.json(
        {
          ok: false,
          ...(detailed
            ? {
                reason:
                  'DATABASE_URL authenticates as a superuser or BYPASSRLS role — every RLS policy in this schema is silently disabled. ' +
                  'Point DATABASE_URL at the issues_app role (see 20260731090700_issues_app_role_grants.sql and PORTING.md) instead.',
                rolsuper: row.rolsuper,
                rolbypassrls: row.rolbypassrls,
              }
            : {}),
        },
        { status: 503 },
      );
    }
    return Response.json({ ok: true, ...(detailed ? { rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls } : {}) });
  } catch (err) {
    // Never return the raw driver error to the caller — it can carry
    // infrastructure detail (internal hostnames/IPs, role names,
    // auth-failure detail). Log it server-side for operators instead.
    console.error('[health] db probe failed', err);
    return Response.json({ ok: false, ...(detailed ? { reason: 'Database probe failed.' } : {}) }, { status: 503 });
  }
}
