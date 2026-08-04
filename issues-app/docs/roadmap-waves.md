# Issues UI — wave roadmap (Emma-directed)

Direction set by Emma (Aug 2026): the app should feel like **Notion / Attio** —
flexible, scalable, editable — while every safety rule from the requirements
doc stays server-enforced. This file is the durable scope record for the
waves that follow docs/notion-redesign.md (Wave 1).

## Wave 1 — database-view core (notion-redesign.md, in flight)
Sidebar shell · All Issues view (browse/open every issue, sort, filter,
full-text search, column show/hide, group-by, saved views) · keyset
pagination + composite indexes · 300-case volume seed · Notion visual idiom.

## Wave 2 — spec §15/§8.2/§13 completions
- FIRST: issue-level change log upgrade (Emma priority) — the case page's
  History section becomes a readable activity feed: newest-first, per-field
  diffs ("Priority: Normal → High — <actor>, <time>"), category filter kept,
  paginated. Same audit_events data, human rendering.
- Search expansion: person name / phone / email, development / tract,
  case id — context-aware per spec §15.
- Hover cards on every linked person/property (key info + quick links).
- General Issues dashboard (§8.2): open by type/stage/state/coordinator,
  aging, overdue by coordinator, off-market aging. SSR, CSS-only charts.
- Exception / data-quality queue (§13): no-future-due-date, missing summary,
  ready-not-released, stale cases, invalid combos — with owner + next action.

## Wave 3 — the Attio layer
- Inline editing from tables and case page (priority, coordinator, queue,
  summary, business-priority label). EVERY inline edit routes through the
  audited services — no direct writes; stage/phase changes stay exclusively
  behind the transition engine (spec §21). Optimistic UI, server-validated.
- Board (kanban) view by phase/stage alongside table view; per-view saved.
- Side-peek: row click opens the case as a slide-over; full page still
  available. Deep-linkable.
- Quick-open palette (Cmd+K): jump to any case/person/property.

## Change log everywhere (Emma, Aug 2026 — cross-wave requirement)
The append-only audit_events layer (spec §29.2) already captures who/what/
before/after/why/when for every command, including denials. The UX layer:
- Per-record readable change feed on case, person, vendor, and saved-view
  screens: field-level diffs ("Priority: Normal → High — <actor>, <time>"),
  rendered from audit_events before/after jsonb. Paginated.
- Global Activity feed page: recent changes across all records, filterable
  by case / person / action category, bounded queries.
- Inline edits (Wave 3) must produce field-level audit rows by construction
  (service-layer routing guarantees this; verifier checks it).
- No new tables needed — this is a projection over audit_events; if per-field
  query performance requires it, add an index on (object_table, object_id,
  occurred_at desc) (already present — verify before adding).

## Standing constraints (all waves)
- No new npm dependencies (Hub portability). Plain React + CSS.
- No business-rule changes in lib/services safety core without explicit
  scope; verifier diffs the service layer every wave.
- Every list query bounded (ORDER BY + LIMIT); URL params through strict
  allowlists; injection-fuzz on every new param surface.
- npm run validate green before every push; screenshots as behavioral proof.
