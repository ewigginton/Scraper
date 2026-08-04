# Issues UI v2 — Notion-style workspace, built for volume

Controlling spec for the UI/scale phase. Satisfies spec §15 (saved
spreadsheet-like list views, filters, column show/hide, hover cards feel) and
§25 (pagination, performance at volume). No service/business-rule changes —
this phase touches queries, migrations (indexes/search/saved views), and UI
only. All existing safety rules (eligibility chokepoint, audit, RLS) stay
untouched.

## Look and feel (Notion-inspired, no new dependencies)

- **App shell:** fixed left sidebar (240px, collapsible via `<details>`-free
  CSS/checkbox trick or a small client component): workspace header "CCL Hub —
  Issues", nav groups — *My Work*, *All Issues*, then per-type quick views
  (Default Recovery, Covenant, Market Readiness, Buyer Cleanup, Legal), then
  *New Issue*. Active item highlighted with Notion's subtle gray pill. Content
  area max-width ~1200px, generous whitespace.
- **Typography/tokens:** system font stack; 14px base; #37352f-style ink on
  white; hairline borders (#e9e9e7); hover row background (#f7f7f5); radius
  6px; subtle shadows only on popovers. Dark-mode variables kept working.
- **Pills/tags:** issue type, priority, stage, and hold badges become soft
  colored pills (Notion palette: gray/brown/orange/yellow/green/blue/purple/
  pink/red backgrounds at ~8% tint with darker text).
- **Case page header:** Notion-style properties grid — icon + muted label +
  value rows (Property, Type, Phase, Coordinator, Priority, Restrictions,
  Next task, Due) — instead of the current dense header block. Sections stay
  as cards with `<details>` but restyled with chevrons and quiet headers.
- **Tables:** full-bleed rows with hover highlight, column headers muted
  uppercase 11px, row click opens the case (whole row is a link), inline
  actions on hover-revealed cluster at row end. Sticky header row.
- Inline SVG icons only (single `app/_components/icons.tsx`), no icon or CSS
  framework dependency — must stay portable into the Hub.

## The All Issues database view (`/issues`)

Server-rendered, URL-driven state (every control writes querystring params so
views are shareable/bookmarkable):

- **Filter bar:** issue type (multi), lifecycle status (multi), state (TX/OK/…),
  priority, coordinator/queue, overdue-only toggle, free-text search box.
- **Sort:** any visible column, asc/desc — STRICT server-side allowlist of
  sortable columns; never interpolate client strings into SQL.
- **Columns:** show/hide via a columns menu (URL param `cols=`).
- **Pagination:** keyset (cursor) pagination on stable keys — default sort
  `(updated_at DESC, id DESC)` with `after=` cursor; page size 50; "Load
  next 50" link + total count chip from a separate cheap COUNT query.
- **Saved views (spec §15):** `saved_views` table (id, owner_external_id,
  name, params jsonb, created/updated). UI: "Save view" with name, list of
  the owner's saved views in the sidebar under All Issues, delete. Writes go
  through a repo + audited service function like every other mutation.
- **Group-by (stage or type):** optional `group=` param — grouped rendering
  with per-group counts, still respecting filters; groups load first 10 with
  per-group "show all" linking into a filtered flat view.

## My Work at volume

- Each queue keeps its identity but shows the first 25 with per-queue counts
  and a "View all N" link into `/issues` pre-filtered to that queue's params.
- All seven queue queries already have ORDER BY + LIMIT (adversarial fix);
  keep, and add missing composite indexes (below).

## Scale work (the part that matters at hundreds/thousands of issues)

New migration `*_issues_scale_indexes_search_views.sql` (timestamp later than
20260731090700):
1. Composite indexes matched to the new query shapes, at minimum:
   - `issues (lifecycle_status, updated_at desc, id desc)`
   - `issues (issue_type, lifecycle_status, updated_at desc)`
   - `issues (coordinator_id, lifecycle_status)` and `(queue, lifecycle_status)`
   - `tasks (status, due_date, id)` and `tasks (assignee_id, status, due_date)`
   - `holds (property_ref_id) where released_at is null` (verify existing)
   - `property_refs (state)`, `property_refs (display_name)`
2. **Search:** generated tsvector column on issues
   (`to_tsvector('simple', summary)`) + GIN index; property display-name match
   folded in at query level via a join (ILIKE prefix on display_name uses its
   btree). Core-Postgres only (works on PGlite + Supabase; no pg_trgm
   dependency).
3. `saved_views` table (+ updated_at trigger, RLS policies consistent with the
   existing scaffold: owner-scoped read/write, FORCE RLS).
4. Keep every migration replay-clean; never edit landed files.

Repo layer:
- New `lib/repositories/issues-query-repo.ts`: one composable filtered/sorted/
  keyset-paginated query builder + a matching COUNT — parameterized via
  drizzle operators only; sort columns resolved through a literal allowlist
  map `{col: sqlColumnRef}`; cursor encoded as base64 JSON of the key tuple,
  validated on decode.
- Existing `app/_lib` read paths that belong in repositories move into repos
  (closing the architectural gap flagged in review).
- Every list query in the app carries LIMIT; no unbounded reads anywhere
  (including case-view history: paginate at 50 with "Load more").

Demo/seed:
- `scripts/demo-seed.ts` gains a volume mode (default on): ~300 issues across
  types/states/stages with varied dates via the service layer where the rules
  allow, plus direct-but-valid inserts for aged/backdated variety. Target:
  seed completes < 90s.
- Demo remains the behavioral proof environment: the All Issues view must feel
  instant at 300+ rows.

## Acceptance (verifier checks all of these)

1. `npm run validate` green; no service/business-rule diffs beyond the moved
   read paths (git diff inspected).
2. `/issues` with 300+ seeded issues: filters, sort, search, group-by,
   pagination, and saved views all work server-side (URL-driven), each page
   render issues bounded queries only (assert LIMIT present; no full-table
   reads in the request path — verify via query logging or EXPLAIN on PGlite).
3. Sort/filter/cursor params are injection-safe: fuzz `sort`, `cols`, `after`,
   and every filter param with hostile strings — must 200-with-defaults or
   400, never 500, never raw SQL reaching the driver from client strings.
4. Keyset pagination is stable under concurrent inserts (no skipped/duplicate
   rows across pages when new issues arrive between page loads).
5. RLS/audit intact: saved-view writes audited; existing RLS tests still pass;
   new table has owner-scoped policies + FORCE RLS.
6. Rendered proof: screenshots at 300+ issues of sidebar+All Issues (flat and
   grouped), filtered+searched view, My Work, and the restyled case page.
