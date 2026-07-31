/**
 * Auth stub: exported module signature for current user identity.
 *
 * IMPORTANT: The Hub replaces this module with its shared staff identity service.
 * Property Operations MUST NEVER have a separate login surface (Master Vision §30.1).
 * This stub exists ONLY for standalone development and testing; it is NOT used in production.
 *
 * At deployment to the Hub, this module is replaced with:
 * - Shared staff identity (pulled from the Hub's identity service)
 * - Session context (via Hub middleware)
 * - No login form or separate staff auth (forbidden by Master Vision §30.1)
 *
 * DO NOT:
 * - Add JWT parsing, OAuth, or any auth library here
 * - Create a login page or flow
 * - Store credentials in .env
 * - Use this for authorization decisions (that's the RLS+application layer)
 */

export interface CurrentUser {
  id: string;
  name: string;
  roles: string[];
}

/**
 * Returns the current authenticated user.
 * In production (Hub), this is replaced with the shared identity middleware.
 * Standalone/test: returns a hardcoded dev user.
 *
 * ADVERSARIAL-REVIEW FIX: this stub used to hand out ['coordinator', 'admin']
 * unconditionally with no environment guard, and app/actions.ts feeds
 * `user.roles` straight into transitionPhase/releaseHold's role checks. Per
 * DESIGN.md §1 this package "runs standalone (npm run dev) against any
 * Postgres/Supabase dev database so it can be demonstrated and reviewed" —
 * under that documented mode, with NODE_ENV=production and no explicit
 * opt-in, any unauthenticated visitor would hold admin and could release
 * holds / drive phase transitions. This now refuses to run in production
 * unless explicitly opted into (ISSUES_ALLOW_AUTH_STUB=true, meant only for
 * a reviewable demo deployment that everyone understands is unauthenticated),
 * and drops 'admin' from the granted roles so the dev identity cannot
 * exercise admin-only paths even then.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  // STUB: Standalone development only.
  // The Hub middleware injects real identity here.
  if (process.env.NODE_ENV === 'production' && process.env.ISSUES_ALLOW_AUTH_STUB !== 'true') {
    throw new Error(
      'lib/auth/current-user.ts is a development-only auth stub and refuses to run with NODE_ENV=production. ' +
        'This module MUST be replaced with the Hub\'s shared staff identity service before any non-local deployment ' +
        '(see PORTING.md). Set ISSUES_ALLOW_AUTH_STUB=true only for an explicitly unauthenticated demo/review deployment.',
    );
  }
  return {
    id: 'dev-user',
    name: 'Dev User',
    roles: ['coordinator'],
  };
}
