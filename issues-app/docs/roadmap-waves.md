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

- Case left-panel: contract/transaction overview + CRM links (Emma, Aug
  2026): the case page's properties panel shows an overview of the
  contract #/transaction for the property (number, status, key dates —
  READ-ONLY: Sales/Transactions and the Contract workflow own those facts,
  §30.2), linking to the contract/transaction record in the CRM. Every
  linked person is clickable through to their CRM people page. Navigation
  stays in-ecosystem: in-app routes/side-peek within the Hub shell, never a
  full redirect out of context. Until the Hub's canonical contract tables
  and the Prospects person pages exist, links target this package's
  /people/[id] stand-in and a contract_refs read-model seam (same alias
  pattern as property_refs/person_refs); at porting they retarget to the
  Hub's canonical routes with no data rework.
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

## Wave 3 — the Attio layer (Emma, Aug 2026 — refined from Attio screenshots)

### Person record page, Attio-style
- Header: name + quick actions (compose email — DRAFT ONLY per spec §11, AI
  never sends; add note; add task). Left "Record Details" panel of
  inline-editable fields (name, emails, phones, description, company/role
  links) — every edit routes through audited services.
- TAB BAR with counts: Overview | Activity | Emails | Calls | Notes | Tasks
  | Files. URL-driven (/people/[id]?tab=emails); each tab is a filtered
  projection of canonical records (communication_events by channel, audit
  feed, tasks, evidence). No duplicate stores.
- Overview tab: Highlights cards (last/next interaction, linked issues,
  company/property links, contact points) + recent Activity + recent
  Emails. Computed indicators (e.g. interaction recency) only when honestly
  derivable from local data, labeled as computed.

### People list as a database view
- Same engine as /issues: named views + view selector, sort chip, filter
  chip, column show/hide, add-column. Generalize saved_views with an
  entity_type column so saved views cover people AND issues. Columns incl.
  last email/call interaction, linked issues, roles.

### Pipeline / board views
- Kanban board for ISSUES by phase/stage, per-view saved; click-through
  first, drag-to-move only after inline editing lands (moves route through
  the transition engine — a drag can be BLOCKED and must show blockers).
- Boundary: sales/deal pipelines belong to Prospects CRM (§30.2); our
  boards cover Property Operations phases only.

### Quick-actions palette (Cmd+K)
- Search records (issues, people, properties, contracts) + quick actions
  (new issue, new task, go to dashboard/activity/exceptions).
  Keyboard-first, one small client component, server-backed search reusing
  the existing bounded search repos.

### Honest-data note
- Email/call counts and interaction recency render from
  communication_events — rich once JustCall/Gmail wire in at Hub port;
  demo shows the structure with seeded fictional conversations.

## Hub-integration phase — Google Chat (Emma, Aug 2026)
CCL uses Google Chat (not Slack). Emma's priority ranking (Aug 2026):
selective thread-capture to cases > work-from-chat > notifications. Full
design: docs/integrations/google-chat-ingestion.md (contract draft for
Scott; selective attach is the recommended default, inference rejected).
Three tiers, all landing in existing seams
(communication_events + integration_identities + idempotent consumption;
spec §19 already names Google Workspace as a communication transport):
1. Outbound notifications: incoming webhooks per Chat space, driven by the
   configurable notification rules (spec §8.3) — urgent holds, overdue
   escalations, payment requests. Webhook URLs are config, never code.
2. Interactive Chat app: card messages with case/task links + actions,
   slash commands, personal DM reminders. Needs a Google Cloud project +
   Chat API under CCL's Workspace.
3. Message ingestion (the Attio-Slack equivalent): Workspace Events API
   subscriptions feed space/DM messages into communication_events with
   provider IDs, surfacing on case/person timelines beside calls/emails.
   Requires workspace-admin consent + an integration contract per spec §22
   with Scott's sign-off (same governance as JustCall/Gmail).
All tiers require real credentials → Hub-integration phase, after porting.

## Wave 4 — Tremor-pattern tables + admin (Emma, Aug 2026 — from Tremor screenshots)
- Filter chips: /issues and /people filter bars become chip-style dropdown
  filters (+Status, +Type, +State, +Costs-style), URL-driven as today.
- Bulk edit: row checkboxes + act-on-selected (reassign coordinator, change
  priority/queue, reschedule tasks, attempt transitions). A bulk action is
  N audited single actions through the existing services — per-row audit
  rows, per-row blocked-result reporting, no silent skips, stage changes
  still individually through the transition engine.
- Export (spec §23): CSV export of the current filtered view —
  permission-gated, records who exported what and when as an audit event,
  applies the same data restrictions as the interface (restricted rows
  excluded for non-authorized roles).
- Settings area (spec §12): admin UI over the existing versioned config —
  dropdown values (add/rename/reorder/retire with history), deadlines,
  thresholds, notification recipients, role-capability matrix, per-person
  approval limits, personal notification preferences (§8.3). Every change
  creates a new config version with audit.
- User management boundary: staff accounts belong to the Hub's shared
  identity (Master Vision §30.1) — no local user CRUD ever. Our settings
  cover roles/limits/preferences for identities the Hub provides.
- Select dropdowns in Tremor's idiom (Emma, Aug 2026): styled
  select/combobox for every filter and form select — searchable when the
  option list is long (states, coordinators, people pickers), keyboard
  navigable, consistent with the chip filters. CSS-first; a small shared
  client component only where native <select> can't reach (search-within-
  dropdown), reused everywhere rather than per-page one-offs.
- Badges in Tremor's idiom (Emma, Aug 2026): refine the pill/badge set
  to Tremor's look — status badges (Live/Inactive/Archived-style) for
  lifecycle, subtle outline/soft variants, consistent sizing — mapped onto
  the existing single-source pill color system (app/_lib/pills.ts) so one
  change restyles every badge app-wide.
- Callouts in Tremor's idiom (Emma, Aug 2026): a shared Callout component
  (info / warning / error / success variants) replacing ad-hoc banners —
  used for blocked-transition panels, restricted-content indicators, stale-
  case prompts, demo-mode notes, and exception rows. One component, themed
  by the pill color tokens, light+dark.
- Breadcrumbs everywhere (Emma, Aug 2026): a shared server-rendered
  Breadcrumbs component on every page — e.g. All Issues > Cedar Ridge
  Tract 14 > Timeline, People > Dale Harmon, Dashboard, Settings > Roles.
  Every segment clickable; list-level crumbs preserve the active filter/
  view context (return to the filtered view you came from, via the same
  URL-driven params); record crumbs use display names, not ids; current
  page is plain text (not a link) per accessibility convention, with
  aria-label="Breadcrumb" nav semantics.
- Design language only from Tremor — no new npm dependencies; built in the
  existing plain-React/CSS system.
