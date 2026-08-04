/**
 * issue-authz.ts — shared authorization check for issue-scoped "release
 * gate fact" commands (issue-service.recordPriceReview,
 * possession-service.recordPossession). Both write the exact facts
 * checkReleaseEligibility's release gate consumes
 * (`price_review_complete`/`possession_unresolved`), so both need the same
 * server-side role check transitionPhase already applies via
 * DEFAULT_TRANSITION_ROLES before committing a phase change.
 *
 * ADVERSARIAL-REVIEW FIX (round 2, P1 IDOR): neither command had ANY
 * app-layer role check before this fix — both accepted an arbitrary
 * `issueId` from form data and wrote straight to the DB with no role
 * argument even existing to reject a caller. Any authenticated caller
 * (including `employee`, `sales`, `loan_services`) could post any issue's
 * uuid and flip its release gate open. RLS (coordinator/manager/admin
 * write policies) was the only remaining layer, and it is silently absent
 * whenever DATABASE_URL is misconfigured to the table-owner/superuser
 * connection this app has run on to date (see
 * 20260731090700_issues_app_role_grants.sql's doc comment) — the same
 * "server independently rechecks permission" rule task-service.ts's own
 * IDOR fix already established.
 *
 * DECISION: deliberately role-only (coordinator/manager/admin), NOT
 * additionally scoped to the issue's own coordinator/queue. transitionPhase
 * — the other command that gates the exact same release check — is itself
 * role-only with no per-issue ownership scoping (any coordinator/manager/
 * admin may transition ANY issue, not just their own), matching DESIGN.md
 * §7's explicit "Phase 1 grants broad internal view (business preference)"
 * statement. Adding an ownership/queue restriction here that transitionPhase
 * itself does not enforce would be inconsistent with the established
 * pattern for this exact class of command and would silently block
 * legitimate coordinator handoffs (case reassignment, coverage) that
 * transitionPhase already allows. Task ownership (task-service.ts's
 * assertTaskAuthorized) is a different concern — personal work-screen
 * assignment accountability — not release-gating, so that check's stricter
 * ownership scoping does not carry over here.
 */
export class IssueAuthorizationError extends Error {
  code = 'issue_not_authorized';
  constructor(message: string) {
    super(message);
    this.name = 'IssueAuthorizationError';
  }
}

/** Mirrors transition-engine.ts's DEFAULT_TRANSITION_ROLES exactly. */
export const RELEASE_GATE_FACT_ROLES = ['coordinator', 'manager', 'admin'];

export interface IssueAuthorizationInput {
  /** Roles the acting user currently holds — rechecked server-side regardless of what the UI offered (never from form data). */
  actorRoles?: string[];
}

/** Throws IssueAuthorizationError unless the actor holds one of RELEASE_GATE_FACT_ROLES. */
export function assertIssueAuthorized(input: IssueAuthorizationInput, action: string): void {
  const roles = input.actorRoles ?? [];
  if (!roles.some((r) => RELEASE_GATE_FACT_ROLES.includes(r))) {
    throw new IssueAuthorizationError(`${action} requires role(s): ${RELEASE_GATE_FACT_ROLES.join(', ')}.`);
  }
}
