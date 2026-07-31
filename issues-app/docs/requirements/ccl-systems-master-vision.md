                          CCL Systems Master Vision
 The controlling planning document for everything Classic Country Land builds.

 Created 2026-07-30 (Scott + Claude). Source of truth: this file (AI/Projects/CCL Systems Master
 Vision.md). A PDF snapshot lives on Scott's Desktop — this vault file is the live version.

 Rule: every new app, feature, or integration is designed against this document. Before designing
 anything, answer the design-time checklist in §6. When the vision changes, this document changes first.



 1. The Vision
 One source of truth. All company data — website activity, prospects, customers, loans, inventory, contact
 history — lives in one Supabase database. Not "synced between systems": one database that every
 system reads from and writes to, each system owning its own facts.

 Three surfaces, and only three:

 Surface                      Audience              What it is

 The Hub                      Staff                 The internal shell. Every internal app lives inside it: Prospects (CRM),
                                                    Loans, Live Chat, Inventory/Tables, Ask, PTO, Reports, Admin.

 The Website                  Public                ClassicCountryLand.com — the Next.js rebuild. Marketing, property
                                                    listings, lead capture, chat widget.

 The Customer Portal          Customers             The website's logged-in area. A customer sees their loans, payments,
                                                    documents; later, authenticated chat and self-service.

 Anything new is either an app inside the Hub, a page on the Website, or a feature of the Portal. There is no
 fourth surface.

 The two payoffs the vision buys:

       1. Automation without humans in the loop. Example: a customer defaults in the loan system → the
       property's inventory status flips → the website instantly shows the property as available. No exports,
       no copy-paste, no "did anyone update Airtable?"
       2. Customer-360. Click a customer, see everything: what ad brought them in, every page they
       viewed, every chat, every call and email, every contract, their full loan history. One person, one
       record, one screen.
 This is not "one super app UI." It is one data spine with thin, focused apps on top. The Hub is already
 the shell — the super app is the spine, not a merged interface.



 2. The Constitution — principles every design must obey
       1. One writer per fact. Every piece of data has exactly one system allowed to write it. Loans writes
       loan status. Inventory writes availability. Prospects writes contact outcomes. Everyone else reads.
       Two writers to the same column is where "one source of truth" dies.
       2. Identity is the keystone. One canonical person record plus an external-identity map (person_id
       ↔ {website visitor id, chat identity, CRM person, loan borrower, portal login, phone



CCL Systems Master Vision — 2026-07-30 — live copy: Obsidian AI/Projects/CCL Systems Master Vision.md                          Page 1
       system id, …}). With it, Customer-360 is a cheap database join. Without it, it is impossible. Prospects
       requirements §47 is the controlling data model. The identity model — including merge rules (when
       are two records the same person?), survivorship (whose phone number wins?), and
       merge/unmerge with full audit — must be frozen before Prospects builds its person tables.
       3. Events, not syncs. Systems announce facts to a shared domain event log (loan.defaulted,
       property.status_changed, lead.created) and subscribers react. Never point-to-point syncs between
       N systems (that is how the Airtable/Pipedrive era rotted). Live Chat's queued idempotent
       integration-jobs pattern is the proven seed — generalize it, don't reinvent per integration. RULED
       (Scott, 2026-07-30 — D18): cadence_events is PROMOTED to the company-wide log — renamed
       system-neutrally (domain_events), chat's consumer pattern generalized as the subscription
       mechanism, no per-system outbox bridges. The event contract is governed doc-first: changes require
       Scott's sign-off.
       4. Audit everything. Every status change on a shared table records who, when, why, and what event
       triggered it. Land deals dispute years later; the audit trail is the defense. (Loans cell-audit and Chat
       audit tables are the standard to copy.)
       5. Permissions designed once, at the database. One DB serves four audiences — public website
       (anonymous), customers (portal, RLS-scoped to their records), staff (Hub), salespeople (their
       prospects). Row-level security and the role model are a foundation designed centrally, never per-app.
       The first RLS mistake on loan data is a customer reading someone else's balance — this is a security
       boundary and gets adversarial verification, always. RULED (Scott, 2026-07-30 — D17): the central
       RLS/role-model track is COMMISSIONED. Today every protection is app code over a service-role
       connection (no database-level boundary exists); that is disqualifying for the Portal. Deliverables: (a) a
       connection-class role model for all four audiences (the Hub's service-role path constrained, not
       deleted), (b) RLS policies on the shared tables (core_*, cadence_*, lsp_*) with app-layer checks
       retained as a second layer, (c) an adversarial cross-boundary test suite run on every schema change.
       The identity-model design is its input. Scott signs off on the policies. It gates Portal design only —
       loans go-live and site cutover do not wait on it.
       6. Attribution honesty. First-touch and last-touch (UTM/gclid → visitor → lead → person) are
       captured and linked. Perfect cross-device/offline ad causality is not promised — reports state what is
       actually known rather than lying confidently.
       7. Consent lives on the person record. Once the CRM sends SMS/email, TCPA/consent status is a
       first-class field with its own audit trail.
       8. One source of truth is one blast radius. Point-in-time recovery is configured and tested, not
       assumed.
 Anti-goals (things this vision explicitly rejects):

   • No big-bang migrations — every cutover is forward-only with a one-time backfill.
   • No long-lived bidirectional Airtable sync — mirrors are transitional and have an end date.
   • Never two writable homes for the same fact, even "temporarily."
   • No merged super-UI — the spine converges, the apps stay thin and focused.
   • No blocking one system's launch on another's readiness when a queued-job seam can decouple them
     (the Chat↔CRM seam is the model).



 3. Where everything stands (2026-07-30)

CCL Systems Master Vision — 2026-07-30 — live copy: Obsidian AI/Projects/CCL Systems Master Vision.md       Page 2
 System                       Status                Notes

 The Hub                      Live, mature          The staff shell. Apps, access matrix, nav — established.

 Website rebuild              Launch-ready          Next.js rebuild done; launch gate executed and verified. Remaining
                                                    blockers are ops items (budgets, tokens, GTM prune) + cutover day.

 Loans                        Almost ready to       Shannon's servicing engine is THE path. Data in lsp_* tables — already
                              launch                in Supabase. Legacy contractor app rejected (harvest-only).

 Prospects (CRM)              Started —             102-page requirements committed; §47 = the controlling shared data
                              requirements          model. Build barely started. Replaces Pipedrive.
                              done

 Live Chat                    ~25–30% built         Phase 1 ~50–55% (63 of 145 Phase-1 requirements implemented, 35
                                                    partial). Replaces paid LiveChat. CRM seam already decoupled via
                                                    queued jobs.

 Inventory                    In Airtable           Destination: Supabase, forward-only cutover. The mirror that exists today
                              ("Tables")            is transitional by ruling.

 Ask                          Live                  Already reads Supabase only — the pattern proof that consolidation
                                                    works.

 Customer Portal              Direction set, not    Website login → customer's loan data. Separate customer auth (never
                              started               staff auth), RLS-scoped, read-only first.

 Being retired                —                     LiveChat (paid), Pipedrive, NoteSmith, WordPress site, Airtable (as
                                                    system of record).




 4. Sequencing — what must be ordered vs. what runs in parallel
 The dependency spine (these orderings are hard requirements)
       1. Identity model freeze → before Prospects builds. The person table + identity map +
       merge/survivorship rules get designed and frozen first. Every system that ships before this exists
       mints its own IDs and makes the eventual join harder. This is design work on paper — it can and
       should start now, in parallel with everything else.
       2. Loans go-live AND website cutover → before Customer Portal. The portal is the website's
       logged-in area showing loan data — it needs both parents live. Account-linkage verification (proving
       customer X owns loan Y) is the hard problem to solve in its design phase.
       3. Inventory in Supabase → before instant-availability automation. The "default → property back
       on the website" chain can only be wired once inventory's system of record is Supabase, not Airtable.
       4. Identity model + event log → before Customer-360. The 360 page is a join over linked identities
       fed by events. Build the spine, then the page is nearly free.
       5. Event log generalization → before any new cross-system automation. Next integration anyone
       designs uses the shared event mechanism, not a bespoke sync.

 Running in parallel RIGHT NOW (no dependencies between them)
 Track                                   Why it's independent

 Website launch                          Blockers are ops-side items, not other systems. Launch it.



CCL Systems Master Vision — 2026-07-30 — live copy: Obsidian AI/Projects/CCL Systems Master Vision.md                     Page 3
 Track                                   Why it's independent

 Loans launch                            lsp_* is already Supabase; doesn't wait for website, CRM, or anything. Launch it.

 Live Chat Phase 1                       CRM seam is queued jobs — chat never blocks on Prospects.

 Identity model design (§47              Paper/design work. The single most order-sensitive item — starting it now is what
 freeze)                                 keeps Prospects unblocked later.

 Inventory migration design              Schema + backfill planning can proceed; cutover is its own later step.



 The three horizons
 Horizon 1 — now (all parallel):

 Website launch ■ Loans launch ■ Live Chat Phase 1 ■ Identity model freeze (design) ■ Inventory
 migration design.

 Horizon 2 — unlocked by Horizon 1:

   • Central RLS/role-model track (COMMISSIONED 2026-07-30 — design starts now; gates Portal
     design)
   • Shared domain event log: cadence_events → domain_events promotion (RULED 2026-07-30)
   • Customer Portal (unlocked by: loans live + site cutover + the RLS track's role model)
   • Prospects build (unlocked by: identity freeze)
   • Inventory cutover to Supabase (unlocked by: migration design; forward-only)
   • Shared event log (generalized from chat's integration-jobs; first consumers: chat→CRM handoff,
     inventory status)
   • Live Chat Phase 2, LiveChat history migration, site embed
 Horizon 3 — the payoff layer:

   • Customer-360 page in the Hub (join over linked identities)
   • Cross-system automations (default → availability; lead → routing → follow-up)
   • Authenticated chat servicing in the portal
   • Ad-attribution reporting (first/last-touch, honestly labeled)
   • Airtable fully retired as a system of record

 One-page dependency picture
           NOW (parallel):    Website launch    Loans launch    Chat Phase 1    Identity freeze (design)     Inventory design
                                    ■                ■                ■                   ■                         ■
                                    ■■■■■■■■■■■■■■■■■■                    ■                    ■                        ■
                                             ▼                       ▼                    ▼                          ▼
           NEXT:                    Customer Portal          Chat Phase 2      Prospects build           Inventory cutover
                                             ■                       ■                    ■                         ■
                                             ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                   ■
                                                         ▼                       ▼                                  ■
                                                Shared event log ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
                                                         ■
                                                         ▼
           PAYOFF:               Customer-360 · instant-availability automation · portal chat · attribution reports




 5. What each in-flight design must consult this document for


CCL Systems Master Vision — 2026-07-30 — live copy: Obsidian AI/Projects/CCL Systems Master Vision.md                  Page 4
   • Prospects: §47 is the shared data model; the identity map serves all systems, not just the CRM. One
     writer per fact — Prospects owns contact/pipeline facts, nothing else's.
   • Customer Portal: separate customer auth; RLS designed centrally; account-linkage verification is the
     hard problem; read-only first.
   • Live Chat: keep the queued-job seam; identity evidence flows into the canonical person record once
     the identity model lands.
   • Inventory: forward-only Supabase cutover; availability becomes an event other systems (website)
     subscribe to.
   • Website: stays a reader of inventory/availability; lead capture publishes events; attribution capture at
     first touch.
   • Loans: owns loan facts; publishes loan.* events; its data is the portal's first content.



 6. Design-time checklist (answer before building anything new)
       1. Which of the three surfaces does this live on (Hub / Website / Portal)?
       2. Which facts does it write, and is it the single writer for each?
       3. Which facts does it read, and from whose tables?
       4. How do its records link to the canonical person (identity map entry)?
       5. What events does it publish? What events does it consume?
       6. Who are its audiences, and what does RLS look like for each?
       7. What gets audited, and does every status change carry who/when/why?
       8. Does it create a sync, a second writable copy, or a blocking dependency? (If yes — redesign.)



 7. Governance
   • This document controls planning. App-level requirement docs (Prospects requirements, Chat
     requirements, etc.) govern their own internals; where they touch shared data, this document wins.
   • Update on vision change. When Scott changes the vision, this file is updated first, then the PDF
     snapshot on the Desktop is regenerated. Claude sessions carry a standing memory instruction to
     consult this document when designing any project and to keep it current.
   • Related: [[Hub Dashboard]], [[Hub Roadmap]], [[Classic Country Land]], [[LoanSmith]]
 PLACEHOLDER-WILL-FIX-VIA-DIRECT-EDIT




CCL Systems Master Vision — 2026-07-30 — live copy: Obsidian AI/Projects/CCL Systems Master Vision.md     Page 5
