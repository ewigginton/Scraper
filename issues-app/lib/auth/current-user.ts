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
  /** Queue names this user's roles cover, in addition to direct task assignment — see queuesForRoles's doc comment. */
  queues: string[];
}

/**
 * ROUND-2 ADVERSARIAL-REVIEW FIX (P1): task-service.ts's assertTaskAuthorized
 * (the round-1 task IDOR fix) grants access via EITHER direct assignment OR
 * `actorQueues` covering the task's queue, but no production caller ever
 * supplied `actorQueues` — there was no field on CurrentUser to source it
 * from. Queue-only tasks ARE created by shipped commands (`openFromLoanDefault`
 * -> queue 'new_unreviewed'; `handleReinstatementEffective` -> queue
 * 'waiting_blocked' when the issue has no coordinator), so those tasks were
 * invisible to every work screen (tasks-repo.ts's ownerFilter also takes
 * `queues`) and rejected from the case view with "assigned to someone else"
 * for every non-manager/admin user.
 *
 * DECISION (config-driven per DESIGN.md §7, "role rights"): the shipped
 * config-as-data schema (config_versions/config_entries) has no role/queue
 * matrix rows in this phase's seeded config, so this is a literal, documented
 * mapping here rather than a DB read — the two queues shipped commands
 * actually create (`new_unreviewed`, `waiting_blocked`) are covered by the
 * roles that do intake/triage work (coordinator, manager, admin), matching
 * DEFAULT_TRANSITION_ROLES / RELEASE_GATE_FACT_ROLES exactly. A future
 * config-as-data migration can replace this literal with a real read
 * without changing any caller's shape.
 */
const ROLE_QUEUES: Record<string, string[]> = {
  coordinator: ['new_unreviewed', 'waiting_blocked'],
  manager: ['new_unreviewed', 'waiting_blocked'],
  admin: ['new_unreviewed', 'waiting_blocked'],
};

function queuesForRoles(roles: string[]): string[] {
  const queues = new Set<string>();
  for (const role of roles) {
    for (const queue of ROLE_QUEUES[role] ?? []) {
      queues.add(queue);
    }
  }
  return [...queues];
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
 *
 * ADVERSARIAL-REVIEW FOLLOW-UP FIX (this round): the guard used to fire
 * ONLY on the exact string NODE_ENV === 'production', so any OTHER value —
 * most importantly an UNSET NODE_ENV (a custom node entrypoint, a
 * container/host that forgets to set it, a preview/staging target left at
 * 'development') — sailed straight past it and handed the unconditional
 * coordinator identity to every anonymous request. Inverted to an
 * allowlist: the stub now runs ONLY for known-safe contexts (explicit
 * local `development`, or the test runner) or the explicit
 * unauthenticated-demo opt-in; every other value, including unset, is
 * treated as production and refused. Fail closed, not fail open.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  // STUB: Standalone development only.
  // The Hub middleware injects real identity here.
  const isKnownSafeContext = process.env.NODE_ENV === 'development' || process.env.VITEST === 'true';
  if (!isKnownSafeContext && process.env.ISSUES_ALLOW_AUTH_STUB !== 'true') {
    throw new Error(
      'lib/auth/current-user.ts is a development-only auth stub and refuses to run outside NODE_ENV=development ' +
        '(including when NODE_ENV is unset). This module MUST be replaced with the Hub\'s shared staff identity ' +
        'service before any non-local deployment (see PORTING.md). Set ISSUES_ALLOW_AUTH_STUB=true only for an ' +
        'explicitly unauthenticated demo/review deployment.',
    );
  }
  const roles = ['coordinator'];
  return {
    id: 'dev-user',
    // Deliberately unmistakable when ISSUES_ALLOW_AUTH_STUB is what let
    // this run outside real local dev (e.g. a demo deployment) — app/
    // page.tsx already renders user.name, so this makes an unauthenticated
    // demo visually obvious rather than looking like a real signed-in user.
    name: process.env.NODE_ENV === 'development' ? 'Dev User' : 'UNAUTHENTICATED DEV STUB',
    roles,
    queues: queuesForRoles(roles),
  };
}
