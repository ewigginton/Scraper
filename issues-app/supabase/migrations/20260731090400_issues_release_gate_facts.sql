-- 20260731090400_issues_release_gate_facts.sql
-- Property Operations ("Issues") — fixes from adversarial review, batch 1.
--
-- New migration (does NOT edit the already-landed 20260731090000/090100
-- files) per the review's own instruction to add new columns/constraints
-- via a new migration rather than mutating a landed one.
--
-- 1. issues.map_link / issues.price_reviewed_at: the Google My Maps link
--    and the last price-review date are Property-Operations-owned facts
--    (spec §5/§6/§10 — "the coordinator pastes the My Maps link"), not
--    Inventory/Tables-owned. property_refs is explicitly documented as a
--    read-through sync cache with ONE writer (the sync job); Property
--    Operations must never write it (DESIGN.md hard rule #2 / Master
--    Vision §30.2). issue-service.createIssue previously wrote
--    property_refs.map_link directly — a second writer on a sync-owned
--    table, and the write would be silently clobbered by the next sync.
--    Storing these facts on `issues` instead fixes both problems and gives
--    a home for the price-review-window blocker (spec §10) that
--    eligibility-service/transition-engine can enforce for real instead of
--    the previous pass-through stub.
alter table issues add column map_link text;
alter table issues add column price_reviewed_at timestamptz;

comment on column issues.map_link is
  'Property-Operations-owned Google My Maps link (spec §5/§6). NOT property_refs.map_link — that column is a sync-owned read-through cache with one writer (the Inventory/Tables sync job); Property Operations never writes it.';
comment on column issues.price_reviewed_at is
  'Property-Operations-owned timestamp of the last development-price review (spec §10). Compared against config thresholds.price_review_window_months by the price_review_complete prerequisite/blocker.';
