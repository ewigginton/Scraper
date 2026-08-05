/**
 * priority-rank — the shared business-rank ORDER BY expression for a
 * `priority` text column, reused by every repo that sorts on one.
 * `issues.priority` (issues-query-repo.ts's /issues Priority sort) and
 * `tasks.priority` (tasks-repo.ts's inboxForUser "My Work" queues) share
 * the identical CHECK-constrained domain {low, normal, high, urgent}
 * (lib/db/schema.ts:260,470) — and, before this fix, the identical bug:
 * sorting the bare text column is LEXICOGRAPHIC, not business-importance.
 * ASCII-wise 'high' < 'low' < 'normal' < 'urgent', so a naive "most urgent
 * first" `ORDER BY priority DESC` silently buries every `high`-priority
 * row under `low`.
 *
 * ROUND-4 fixed this for issues.priority only (the /issues sort), with the
 * rank expression defined private to issues-query-repo.ts. ROUND-5 (P2)
 * finding: tasks-repo.ts's five inboxForUser queue queries had the
 * IDENTICAL defect on the SAME domain, left unfixed because the mapping
 * lived private to one module instead of a chokepoint both repos could
 * share — exactly the kind of pattern-reimplementation drift rounds 3-4
 * punished elsewhere in this codebase. Hoisting the expression here,
 * column-parameterized so it works for either table's `priority` column,
 * closes that class for good: there is now exactly one place this mapping
 * is written, and every caller (issues-query-repo.ts, tasks-repo.ts) sorts
 * by calling it rather than re-deriving it.
 *
 * The literal rank values ('4'..'1') MUST stay byte-identical to
 * supabase/migrations/20260805100000_issues_priority_rank_index.sql's
 * expression index (round-5 P3 fix) — that index only accelerates the
 * /issues Priority sort if Postgres can match this exact expression
 * verbatim. If this mapping ever changes, a matching new migration must
 * accompany it (or the sort silently degrades back to a full scan+sort).
 */

import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

export function priorityRankExpr(column: SQLWrapper): SQL {
  return sql`case ${column} when 'urgent' then '4' when 'high' then '3' when 'normal' then '2' else '1' end`;
}
