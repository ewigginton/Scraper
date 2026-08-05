-- 20260805100000_issues_priority_rank_index.sql
-- Round-5 P3 fix: /issues Priority sort index. New migration; does not
-- edit any landed file.
--
-- lib/repositories/issues-query-repo.ts's `priority` sort key (round-4 P2
-- fix, docs in that file's PRIORITY_RANK_EXPR / lib/repositories/
-- priority-rank.ts) orders by a business-rank CASE expression over
-- issues.priority instead of the bare text column, so a descending sort
-- returns urgent > high > normal > low instead of the lexicographic
-- 'urgent' < 'normal' < 'low' < 'high' ASCII order. That fix made the
-- EXISTING issues_priority_idx (20260731090000_issues_core.sql, plain
-- `(priority)`) unusable for this sort: verified via EXPLAIN against PGlite
-- with `enable_seqscan = off` — the planner falls back to `Seq Scan on
-- issues (Disabled: true)` plus a full in-memory Sort, because no index
-- covers the CASE expression, on every page (the keyset predicate's
-- `(case ... end) < $1` is equally unindexed, so page 2+ scans just as
-- much as page 1).
--
-- issues_priority_idx is NOT dropped here — it still serves the `priorities`
-- filter's `issues.priority IN (...)` equality lookup (issues-query-repo.ts
-- buildFilterConditions), an unrelated access path this migration doesn't
-- touch.
--
-- The expression below MUST stay byte-identical to
-- lib/repositories/priority-rank.ts's `priorityRankExpr` output (verified
-- by hand; there is no way to introspect a migration's SQL from application
-- code, same caveat as this schema's other duplicated CHECK-constraint
-- lists) — Postgres only matches a query's ORDER BY/predicate expression to
-- an expression index when the text is structurally identical after
-- parsing, so any future change to that mapping needs a matching new
-- migration or this index silently stops being used again. The CASE
-- expression is immutable (plain column reads + literal comparisons, no
-- volatile functions), so it's safe to index. `id` is appended to match
-- the query's tiebreak column (`ORDER BY <rank> DESC, id DESC` /
-- keysetPredicate), the same shape as every other sort key's index in this
-- schema.
create index issues_priority_rank_idx
  on issues (
    (case priority when 'urgent' then '4' when 'high' then '3' when 'normal' then '2' else '1' end),
    id
  );
