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
- Person timeline page (Emma, Aug 2026): /people/[id] renders the person's
  message/communication timeline from the SHARED communication_events +
  communication_links tables (spec §9.1, §28.6, §29.11) plus their linked
  issues and audit projections. Explicitly a stand-in for the Prospects
  (CRM) person page: when the Hub's CRM ships its person view, Issues links/
  embeds that page instead — same canonical tables, no duplicate store, no
  reinvention. Demo seed gains fictional communication_events (calls/texts/
  emails per person) so timelines are visible at demo time.
- Issue timeline view (Emma, Aug 2026): each case opens into a "Timeline"
  view — chronological interleave of communications, tasks, holds applied/
  released, phase transitions, notices, and material edits from the
  canonical records (§29.11 shared record-timeline). Same data as the
  change-log feed but story-ordered and including communications; paginated.
- Cleanup-timeline people scope (Emma, Aug 2026): the timeline on a cleanup
  (and any case) includes the messages of EVERY person linked to it — owner,
  vendor, neighbor, reporter, buyer — per spec §9.1 ("all communication
  history for linked people, not only the current coordinator's activity").
  Sourcing: communications linked to the issue directly, plus each linked
  person's communication_events. A message that belongs exclusively to a
  DIFFERENT matter is shown labeled with its context rather than blended in
  silently (spec §29.1's matter-context rule), and restricted-classification
  content follows the §29.11 policy (neutral indicator for unauthorized
  viewers, never the content).
- Timeline filters (Emma, Aug 2026): the timeline view is filterable by
  person or persons (multi-select of the linked people), contact/entry type
  (call, text, email, voicemail, notice, task, hold, transition, edit),
  direction (inbound/outbound), and recipient/participant ("who it's to" —
  from communication_events participants). Same URL-driven server-side
  filter pattern as /issues; filters compose; counts shown per filter;
  bounded queries.
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
- Admin activity metrics (Emma, Aug 2026): admin-role-gated view showing the
  number of activities by user (audit_events grouped by actor), filterable
  by date range and action category, with drill-down into that user's feed.
  Aligns with spec §8.2 coordinator-performance reporting and §14 baseline
  metrics. Honest caveat surfaced in the UI: actor identity is the dev-user
  stub until the Hub's shared staff identity is wired in at porting — the
  view ships now, the numbers become meaningful then.
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
