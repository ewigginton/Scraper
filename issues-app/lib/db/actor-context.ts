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

/** Set app.actor_id / app.roles on this connection/transaction for the RLS policies to read. */
export async function setActorContext(tx: DbHandle, actor: ActorContext): Promise<void> {
  const rolesCsv = actor.roles.join(',');
  await tx.execute(sql`select set_config('app.actor_id', ${actor.actorId}, true), set_config('app.roles', ${rolesCsv}, true)`);
}
