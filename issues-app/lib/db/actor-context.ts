/**
 * actor-context.ts — sets the session-local GUCs (app.actor_id, app.roles)
 * the RLS policies in supabase/migrations/20260731090200_issues_rls.sql
 * read, from the application connection, per transaction.
 *
 * ADVERSARIAL-REVIEW FIX: grep across all .ts/.tsx previously found
 * set_config/app.actor_id/app.roles used ONLY in test/helpers/pglite.ts —
 * no application code ever set the GUCs the RLS policies depend on, so on
 * a real deployment the RLS scaffold was either fully bypassed (connection
 * using the table owner role) or a silent full lockout (every SELECT
 * returns zero rows, every write denied, for a non-owner role with no
 * actor context set). Every server action that opens a db.transaction(...)
 * should call setActorContext(tx, user) as its first statement.
 *
 * Uses parameterized `set_config(...)` via a tagged SQL template (not
 * string interpolation) — the test helper this mirrors
 * (test/helpers/pglite.ts setActorContext) does its own quote-escaping,
 * which is fine for test fixtures but not a pattern to repeat in
 * application code that will eventually carry real staff identity strings.
 */

import { sql } from 'drizzle-orm';
import type { DbHandle } from '../repositories/db-handle.ts';

export interface ActorContext {
  actorId: string;
  roles: string[];
}

/**
 * The only role names issues_current_roles() (supabase/migrations/
 * 20260731090200_issues_rls.sql) and this package's own role checks (e.g.
 * transition-engine.ts DEFAULT_TRANSITION_ROLES) ever compare against
 * (DESIGN.md §7). ADVERSARIAL-REVIEW FIX: app.roles is encoded as a bare
 * comma-joined string and decoded on the DB side with
 * `string_to_array(..., ',')` — join/split on an unescaped delimiter is not
 * injective, so a single upstream role string containing a comma (e.g.
 * "vendor_portal,admin") would be split into two roles and could forge
 * 'admin'. Filtering to this known-safe allowlist before joining makes the
 * encoding effectively injective (no accepted value can itself contain the
 * delimiter) regardless of what the Hub's identity service ever sends.
 */
const KNOWN_ROLES = new Set(['employee', 'coordinator', 'manager', 'loan_services', 'sales', 'accounting', 'admin', 'service']);

/** Set app.actor_id / app.roles on this connection/transaction for the RLS policies to read. */
export async function setActorContext(tx: DbHandle, actor: ActorContext): Promise<void> {
  const safeRoles = actor.roles.filter((r) => KNOWN_ROLES.has(r));
  const rolesCsv = safeRoles.join(',');
  await tx.execute(sql`select set_config('app.actor_id', ${actor.actorId}, true), set_config('app.roles', ${rolesCsv}, true)`);
}

/**
 * ADVERSARIAL-REVIEW FIX: every render path (app/page.tsx, app/issues/[id]/
 * page.tsx) previously read through the bare, non-transactional `db` handle
 * with no actor context ever set, so under a real RLS-governed connection
 * every SELECT returned zero rows (issues_current_actor() is null) — a
 * total silent lockout distinct from, and just as broken as, the
 * bypassed-RLS case. setActorContext's `set_config(..., is_local=true)`
 * only survives for the REST OF THE CURRENT TRANSACTION (never past a
 * statement boundary outside one, see the app/actions.ts:150 finding this
 * mirrors) so it MUST run inside an explicit transaction — this helper is
 * the one chokepoint every authenticated read should go through instead of
 * calling `db.transaction` ad hoc at each call site.
 */
export async function withActor<T>(db: DbHandle, actor: ActorContext, fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setActorContext(tx, actor);
    return fn(tx);
  });
}
