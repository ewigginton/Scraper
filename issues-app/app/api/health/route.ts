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
 */
import { tryGetDb } from '../../_lib/db.ts';

export async function GET() {
  const db = tryGetDb();
  if (!db) {
    // No DATABASE_URL configured at all — a real problem, but a different
    // one than the RLS-bypass check below; report it distinctly rather
    // than crashing this route.
    return Response.json({ ok: false, reason: 'DATABASE_URL is not configured.' }, { status: 503 });
  }

  try {
    const result = await db.execute('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
    const rows = (result as unknown as { rows?: Array<{ rolsuper: boolean; rolbypassrls: boolean }> }).rows ?? (result as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>);
    const row = rows[0];
    if (!row) {
      return Response.json({ ok: false, reason: "Could not determine the connecting role's privileges." }, { status: 503 });
    }
    if (row.rolsuper || row.rolbypassrls) {
      return Response.json(
        {
          ok: false,
          reason:
            'DATABASE_URL authenticates as a superuser or BYPASSRLS role — every RLS policy in this schema is silently disabled. ' +
            'Point DATABASE_URL at the issues_app role (see 20260731090700_issues_app_role_grants.sql and PORTING.md) instead.',
          rolsuper: row.rolsuper,
          rolbypassrls: row.rolbypassrls,
        },
        { status: 503 },
      );
    }
    return Response.json({ ok: true, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls });
  } catch (err) {
    return Response.json({ ok: false, reason: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
