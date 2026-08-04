-- 20260804130000_issues_search_expansion_indexes.sql
-- Wave 2b: search expansion (roadmap "Search expansion"; spec §15 "Support
-- search by property/development/tract, person, phone/email"). New
-- migration; does not edit any landed file.
--
-- lib/repositories/issues-query-repo.ts's listIssues/countIssues `q` filter
-- and lib/repositories/people-repo.ts's searchPeople now additionally match:
--   - person_refs.display_name (already indexed: person_refs_display_name_idx,
--     20260731090000_issues_core.sql — NOT duplicated here)
--   - person_refs.contact_snapshot ->> 'phone' / ->> 'email' (NOT previously
--     indexed)
--   - property_refs.development / property_refs.tract (NOT previously
--     indexed; verified against 20260731090000_issues_core.sql and
--     20260804100000_issues_scale_indexes_search_views.sql)
--
-- Verified against every landed migration (grep "create index" /
-- "create unique index" across supabase/migrations/*.sql) before adding
-- anything below.
--
-- Caveat carried over from property_refs_display_name_idx's own comment
-- (20260804100000_issues_scale_indexes_search_views.sql): the person-name
-- and phone/email matches are ILIKE **substring** (`%q%`), which a plain or
-- lower()-expression btree index cannot accelerate (only a leading-wildcard-
-- capable index type like pg_trgm can, and this schema deliberately avoids
-- that extension dependency — same "'simple' config ... no pg_trgm
-- dependency" rationale as the summary_tsv column). These lower()
-- expression indexes are added anyway because they DO help the exact-ish
-- lookups other future callers reasonably want (e.g. `lower(...) = lower($1)`
-- phone/email exact match), and cost nothing at this table's volume. The
-- development/tract indexes below are plain (not lower()-expression),
-- mirroring property_refs_display_name_idx exactly: the query issues ILIKE
-- with a **prefix** pattern (`q%`, no leading wildcard) via
-- issues-query-repo.ts's `${col} ilike ${prefix}`, which is the same
-- imperfect-but-consistent tradeoff that existing index already accepted.

create index person_refs_contact_snapshot_phone_lower_idx
  on person_refs (lower(contact_snapshot ->> 'phone'));

create index person_refs_contact_snapshot_email_lower_idx
  on person_refs (lower(contact_snapshot ->> 'email'));

comment on index person_refs_contact_snapshot_phone_lower_idx is
  'Backs case-insensitive phone lookups against person_refs.contact_snapshot (spec §15 search-by-phone). Does not accelerate the ILIKE %substring% search-box query in people-repo.ts/issues-query-repo.ts (leading wildcard) — see this migration''s header comment.';

comment on index person_refs_contact_snapshot_email_lower_idx is
  'Backs case-insensitive email lookups against person_refs.contact_snapshot (spec §15 search-by-email). Does not accelerate the ILIKE %substring% search-box query in people-repo.ts/issues-query-repo.ts (leading wildcard) — see this migration''s header comment.';

create index property_refs_development_idx
  on property_refs (development);

create index property_refs_tract_idx
  on property_refs (tract);

comment on index property_refs_development_idx is
  'Backs the /issues search box''s ILIKE-prefix match against property_refs.development (spec §15 search-by-development). Same prefix-ILIKE tradeoff as property_refs_display_name_idx.';

comment on index property_refs_tract_idx is
  'Backs the /issues search box''s ILIKE-prefix match against property_refs.tract (spec §15 search-by-tract). Same prefix-ILIKE tradeoff as property_refs_display_name_idx.';
