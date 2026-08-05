CCL Hub: Property Operations Requirements

Independent requirements document from the Property Operations perspective | July 29, 2026

# Architecture and scope clarification

This edition treats the CCL Hub as the staff-facing operating surface and Supabase as the shared company data spine. During transition, Inventory/Tables remains authoritative in Airtable until its approved forward-only cutover; no other system may write the same facts. After cutover, Airtable becomes read-only source evidence or archive for that scope and is not a target runtime dependency. If a later statement conflicts with this section or Section 30, the controlling section governs until CCL approves a documented change.

## Confirmed target architecture

• The Hub provides modular workspaces for Property Operations, CRM/Communications, Inventory, Loan Services, Sales/Transactions, and administration. These are coordinated views over shared records, not isolated databases that copy the same property or person.

• Supabase PostgreSQL stores normalized operational records, relationships, configuration, permissions, integration mappings, workflow events, and audit history. Supabase Storage or another CCL-approved service stores files with database metadata and access controls.

• Every core record receives an immutable internal UUID. Airtable, Pipedrive, PandaDoc, JustCall, website, mapping, loan-system, and other provider identifiers remain external aliases with source and provenance.

• Authorization is enforced through server-side checks and Supabase Row Level Security. Interface visibility alone is not permission enforcement.

• Cross-module changes—such as placing a property Off Market, accepting a voluntary surrender, approving cleanup, clearing a legal hold, or releasing a listing—must execute through controlled commands that validate prerequisites, update related records atomically, and write audit events.

• Configuration may control approved values, deadlines, thresholds, notification recipients, and role rights, but configuration cannot bypass database integrity, audit, or safety rules.

  

## Developer-readiness rule

Each Phase 1 requirement must map to a workflow, data objects and required fields, roles and permissions, state transition, validation rule, integration/API event, failure behavior, audit event, notification, and acceptance test. Unresolved business choices remain visibly labeled TBD or Recommended Default and must not be silently hard-coded.

  

# Executive summary

Classic Country Land should build a connected, Supabase-backed CCL Hub that replaces Airtable Inventory and its separate property-issues workflow. The Property Operations tile must coordinate the full life of a property issue while remaining simple for the person doing the work: a clear next task, due date, current phase, concise summary, and one place to see the property, people, communication, documents, legal status, bids, costs, and release requirements.

The Hub should be modular—Inventory, CRM/Communications, Loan Services, Property Operations, Sales/Transactions, documents/PandaDoc—but share one record of properties, people, accounts, documents, tasks, and history. It must prevent status conflicts, preserve audit history, and allow administrators to configure choices, deadlines, approvals, notifications, and restrictions as the company’s process develops.

# 1\. Problems the new system must solve

  - One project currently requires looking through legacy Airtable records, spreadsheets, mapping, CRM/communications, PandaDoc, Loan Services, documents, and website status.
  - Legacy Airtable Activity notes carry important legal and operational history but are difficult to search, report, hand off, or validate. They must be migrated into structured Supabase records while preserving their original text and provenance.
  - The same property can pass through default, legal, voluntary surrender, recovery, cleanup, buyer cleanup, and relisting; a flat issue record becomes overwhelming or loses history.
  - Missing due dates, incomplete documentation, inconsistent labels, and unsafe status combinations make reporting unreliable and create compliance risk.
  - Property Operations needs a current view of contacts and communication without copying data into a separate system.
  - Management needs comparable cleanup-cost and time-off-market reporting, not one-off spreadsheets.

# 2\. Goals and design principles

  - One-stop shop: employees work from the Hub rather than re-entering information across applications.
  - Simple front end; sophisticated controls behind the scenes. The default screen is a task list, not a large form.
  - One permanent Property profile; one issue/case per owner-property event cycle; expandable phases within the case.
  - A case remains together as it moves through phases, but each phase has its own owner, start/end dates, next task, due date, documents, and outcome.
  - Use configurable settings instead of hard-coded workflow choices, deadlines, approval limits, notification recipients, dropdowns, and performance targets.
  - No property may be listed Available when an unresolved legal, foreclosure, safety, occupancy, or cleanup restriction exists.
  - Every active issue must have a next task and due date; every exception must be documented and auditable.

# 3\. Hub architecture and record model

|  |  |  |
| :-: | :-: | :-: |
| \*\*Hub tile\*\* | \*\*Primary responsibility\*\* | \*\*Property Operations integration\*\* |
| Inventory | Property/development/tract record, pricing, availability, transactions, website status | Property Operations reads live property data and publishes operational holds and release decisions. Inventory/Tables remains the single writer of inventory availability and website-status facts. |
| CRM / Communications | People, vendors, calls, texts, emails, voicemail, addresses, communication history | Issue shows all communication for linked people; actions log to person and issue. |
| Loan Services | Accounts, payment history, delinquency, notices, arrangements, AutoPay | Triggers/default data, legal hold, payment/reinstatement approval flow. |
| Documents / PandaDoc | Voluntary surrenders, vendor agreements, buyer cleanup clauses, signatures | Completed forms and signature dates automatically attach to the linked issue. |
| Property Operations | Tasks, condition review, legal coordination, vendors, bids, cleanup, release | System of workflow coordination, controls, reporting, and off-market history. |
| Sales / Transactions | Sales activity, assigned lead, First Dibs, closing/sale triggers | Receives release/review tasks; sale can trigger buyer-cleanup follow-up. |

  

Data relationships: a property has many transactions and issues; a person may be a buyer, owner, reporter, neighbor, vendor, or several roles; an issue has many phases, tasks, communications, documents, bids, cost entries, photos, and history events. A completed case may reopen for the same owner and property, creating a new reporting cycle; a different property always receives a new issue.

# 4\. Issue types and case structure

|  |  |
| :-: | :-: |
| \*\*Issue type\*\* | \*\*Purpose / pathway\*\* |
| Default / Property Recovery | Loan Services-triggered case. May include non-signed VS/legal, accepted VS, vacancy/condition review, CCL cleanup, foreclosure-page disposition, buyer cleanup, and relisting. |
| Covenant Violation | Active owner case with linked reports, notices, cure periods, verification, escalation, fees/legal when configured. May convert into the default pathway if the owner defaults. |
| Market Readiness | Configurable case for CCL-controlled property needing condition, map, pricing, cleanup, or release work outside a default. Final naming/classification remains an Emma decision. |
| Property Legal Matter | Standalone legal issue such as a land/boundary dispute; may place an Off Market legal hold and later hand off to Market Readiness. |
| Buyer Cleanup | A sold property with a contractual cleanup obligation. Normally created/activated by transaction notification, without CCL bid collection. |

  

Use an expandable case view. The top header shows property, linked people, issue type, current phase, owner, current restriction, concise summary, next task, and due date. Sections such as Legal, VS, Recovery Review, Bids, Cleanup, Buyer Cleanup, and Relisting remain collapsed unless active or opened by the user.

# 5\. New issue intake and required information

## 5.1 Intake sources

  - Loan Services: creates a Default case with account/payment/default context; accepted voluntary surrender and non-signed cases route differently.
  - Employees, clients, or neighbors: create or add evidence to a Covenant Violation case. Multiple reports on the same owner/property incident attach to one case.
  - Sales/Transactions: notify or trigger buyer-cleanup follow-up after a Foreclosure-Page sale.
  - Property Operations/management: may open a Market Readiness or Property Legal Matter case.
  - PandaDoc: completed voluntary surrender automatically attaches and can move a case to the accepted-surrender pathway once all required parties signed.

## 5.2 Required at intake

|  |  |
| :-: | :-: |
| \*\*Required item\*\* | \*\*Rule\*\* |
| Property | Select the live property record; show development, tract, state, map/coordinates, status, transaction history, price/True Discount history. |
| Summary | Plain-language description of the problem. Missing/unclear summary is a data-quality flag. |
| People | Link all relevant owner(s), reporter(s), neighbor(s), vendor(s), and contacts. Hover cards show key details and links. |
| Evidence | Photos/video/documents as available; covenant reports require reporter and proof when available. |
| Task | Initial reviewer, next task, and due date. |
| Map | Property Recovery review requires a Google My Maps link; display a paste field and map quick link. |
| Priority / restriction | Priority, urgency, and whether the property must be Off Market or has a legal/safety hold. |

  

# 6\. Detailed workflows and transition rules

## 6.1 Default, voluntary surrender, legal, and recovery

1.  Loan Services creates/feeds the Default case. The Hub distinguishes an accepted voluntary surrender from a non-signed case. “Accepted” means all required parties signed the form; signature date may be entered before the completed form is imported.
2.  If VS is not accepted, the case stays in Default/Legal. The case shows the state-specific legal stage, next required event, next due date, notices, service/delivery evidence, attorney referral, fees, court/case documents, and a complete timeline of Loan Services communications.
3.  Attorney handoff creates an Attorney Packet from property, account, notices, scanned mailed letters, certified-mail receipts, PandaDoc status, documents, and communications. Attorney Process remains flexible but every update requires current legal status, next action/owner, and next due date.
4.  If VS becomes signed after attorney referral, record the signature date, attach/import the form, move the case to Default / Property Recovery, and assign the recovery coordinator. Attorney closeout remains documented.
5.  Property Recovery begins with a map review. Required decision: ready to relist as-is, needs neighbor review, needs CCL cleanup/bids, Foreclosure Page, legal/safety hold, or another configured decision. Record rationale.
6.  Map Review—cleared may release a clearly visible property without neighbor confirmation, but requires the map link, review date, reviewer, and documented reason. Neighbor confirmation remains the normal method when map imagery is uncertain.
7.  Before release, verify former occupant has left and the property is clean/handled through the approved market path. Neighbor confirmation must identify contact, date, response, and evidence. A documented override may use map confidence, vendor inspection, or other reliable evidence.

## 6.2 Foreclosure Page and buyer cleanup

  - Record date placed on Foreclosure Page, True Discount from Inventory, approval, buyer-cleanup obligation, and contractual deadline.
  - While marketed, case status is Waiting for Sale; no recurring follow-up is required. Sales’ sale notification activates Buyer Cleanup.
  - After sale, follow the contract deadline (typically 30 days): create midpoint and one-week-prior follow-ups, plus a reminder on any customer-provided action date.
  - Buyer Cleanup has no CCL bid requirement. Track customer communications, evidence, deadline, confirmation, and escalation to covenant enforcement if not completed.
  - Do not count it as a completed CCL cleanup; report True Discount and buyer-cleanup outcome separately for disposition analysis.

## 6.3 CCL cleanup and relisting

1.  Condition assessment records primary cleanup category, severity, trash/debris size inputs, item counts (sheds, RVs/campers, cars/vehicles, tires, structures), access, terrain/brush, hauling/disposal, hazards, occupancy/personal property, and photos/video.
2.  Request bids from eligible vendors. A complete bid must include cost, estimated time/completion date, and current walkthrough photos or video. Vendor W-9 must be on file or received before payment.
3.  A second complete bid is normally required around $1,500 or more and for severe/complex work. The rule, thresholds, experience-based requirements, and approved exceptions are configurable.
4.  Select/approve vendor under the coordinator’s individual authority limit or route for approval. Capture scheduled start, scheduled completion, signed contractor agreement, delays, scope changes, final photos/video, actual cost, and Accounting payment notification.
5.  Contract amount is the normal cost. An optional “additional cost outside contract” entry records rare extras with reason, documentation, and approval. The job’s total direct cost rolls up for reporting.
6.  Completion requires final photo/video and a documented verification decision. Release requires clean/vacant or authorized disposition, legal clearance where applicable, and no blocking hold.

## 6.4 Covenant violations

  - Create one owner/property case for the incident; multiple neighbor/client reports attach to it. Show the owner’s past violations and resolutions.
  - First Notice: normally 14 days, but configurable longer period with documented reason. Second Notice: normally another 14 days if not cured.
  - Generate notices from the case; record exact notice/delivery dates, method, evidence, cure deadline, and communications.
  - Cure verification may rely on the same reporter, current photos/video, neighbor confirmation, map/drive-by, or another reliable source. Partial work is progress only; the case remains open until all cited items are resolved.
  - Escalate to fees, legal/court, or another configured route based on severity and contract terms. Fees remain configurable as program rules develop.
  - If the owner defaults, convert/link the case to Default while retaining all covenant history, notices, and evidence.

# 7\. Tasks, dates, waiting, and handoff standards

|  |  |
| :-: | :-: |
| \*\*Date / status\*\* | \*\*Definition and required behavior\*\* |
| Action date | Date a customer/vendor says they will act or update; creates a reminder. |
| Target completion date | Expected deadline for work. |
| Verified completion date | Date CCL confirms resolution; never inferred from a promise. |
| Waiting / Blocked / On Hold | Require reason, brief description, party/dependency if applicable, and a next follow-up/due date. Example: “cleanup completion date” or “waiting on attorney update.” |
| Reopened cycle | Same owner + same property reopens the case but begins a new reporting cycle; preserve prior cycle history. |
| Handoff | Header must show next task and due date; missing either is flagged. Show phase, coordinator, summary, restriction, and latest meaningful update. |

  

# 8\. Daily work screens, dashboards, and notifications

## 8.1 Personal work screen

The default screen is an actionable task list. Each row shows property/state, issue type, current stage, task/action, due date, priority, assigned person, and short summary. It supports completion, rescheduling, and opening the case. Required queues: new/unreviewed issues; communications from action dates; letters/notices due; upcoming deadlines; overdue tasks; waiting/blocked items; and approvals.

## 8.2 Team and management dashboards

  - General Issues dashboard: open issues by type/stage/state/coordinator, open/past-due tasks by coordinator, aging, bottlenecks, off-market properties, and simple graphs/trends.
  - Management dashboard: cleanup completed, total spend, average and median cost, category/severity comparisons, comparable-median variance, time from Taking Bids to Completed, time in stage, backlog, completed issues, and state/coordinator performance.
  - Filtering: month-to-date, selected calendar month, quarter-to-date/completed quarter, year-to-date/completed year, and custom range.
  - Comparable benchmark: same primary cleanup category + severity across all states and coordinators. Flag jobs more than 20% above comparable median for review, not automatic fault.
  - Baseline mode first: show actual averages/medians/ranges and trends; set KPIs later after enough reliable data. Settings must permit changing standards.
  - Off-market aging: configurable trigger plus an approved long-term exception with reason, approver, date added, and review date. Examples: active litigation, environmental remediation, title/boundary dispute, access/infrastructure, or intentional business hold.

## 8.3 Notifications and escalation

  - In-app notifications are default. Individuals choose additional channels (email/JustCall) in personal settings; CCL may require urgent/legal notices regardless of preference.
  - Overdue tasks remain on dashboard, receive reminder after one day, and alert manager after a configurable number of days. Use configurable color cues for normal, due soon, overdue, and escalated.
  - Urgent/emergency rules must support environmental agency concerns, safety hazards, serious occupancy/animal/vehicle concerns, and legal/court deadlines; recipients and timing are configurable.

# 9\. Vendor, neighbor, and communication requirements

## 9.1 CRM communications and people

  - Issue displays all prior calls, texts, emails, voicemails, and communication history for linked people—not only the current coordinator’s activity.
  - Users can click to call/text through an integrated provider such as JustCall, send templates, log incoming calls/texts, attach/share/download voicemail, and create follow-up tasks. Activities link automatically to both issue and person profile.
  - Person profile shows all properties purchased, swapped, defaulted, voluntarily surrendered, and otherwise resolved.
  - Maintain all known addresses with source (contract, prior correspondence, driver’s license, etc.), validity flag, selected mailing address, and the exact address used for each mailed notice.
  - Vendor is a CRM role; one person/company may be both vendor and client. Vendor profiles include states, developments, and service radius; W-9 status; linked jobs; and communications.
  - From an issue/map, search nearby tract owners/neighbors by development, distance/radius, active ownership, name, contact details, preferences, do-not-contact warning, prior verification history, and map position. Use live data, not a separate spreadsheet.
  - Vendor performance rating is optional/TBD. The system must at minimum retain job history, actual cost, completion timing, photos, and documentation for later evaluation.

# 10\. Inventory, Sales, website, and release controls

  - Property Operations may read property, development, tract, state, map/coordinates, market status, price/True Discount history, sales lead, First Dibs, transactions, website listing status, and off-market reason according to permission. It may write only its owned Issue, condition, possession, cleanup, hold, and release-decision facts. Inventory/Tables is the single writer of market status, website status, price history, and other Inventory facts; Sales/Transactions is the single writer of sales-lead, First Dibs, and transaction facts.
  - Inventory/Tables writes inventory availability after a controlled release flow and publishes the resulting availability event. The Website reads the authoritative Inventory/Tables state; Property Operations does not directly write availability or website status.
  - Release checks include no blocking issue/hold, condition/vacancy verification, legal/default clearance, map present, and price-review check.
  - If development price has not been reviewed within the configurable window (initially six months, adjustable), create a Sales Manager activity and block listing until review is completed.
  - Cabins, Foreclosure-Page listings, and other configurable special conditions trigger Sales Manager review before website listing.
  - First Dibs and assigned sales lead remain visible; Sales receives needed completion/release/sale tasks.

# 11\. AI copilot requirements

AI must live inside the issue and use permitted linked records—property, people, communications, account/default information, documents, prior tasks, current phase, deadlines, and notes—to reduce re-explaining the case. It may prepare a draft email, text, legal letter, notice, task, handoff summary, vendor bid request, or timeline. The user can provide a short idea for the response and receive a context-aware draft. Drafts require human review/edit and explicit send approval; AI must never send communications, change a status, advance a legal stage, or release a property automatically.

# 12\. Roles, permissions, settings, and audit history

  - All internal employees may view information by default while CCL is small; role status determines editing, approving, releasing, overriding, and administering.
  - Roles are configurable in Settings. Example capabilities: coordinators edit cases/tasks; Loan Services updates account/payment activity; Sales updates sales/First Dibs; Accounting marks payment notification; managers approve threshold/release/exception actions.
  - Individual settings may set approval limits and restrictions. Reinstatement approval may route to Property Operations, Loan Services Manager, Sales Manager, or another configured approver.
  - Authorized administrators can add/rename/reorder/retire dropdown values, revise deadlines and review windows, change notification recipients, enable/disable rules, and modify role rights without development work.
  - All edits, stage moves, approvals, overrides, status changes, imported documents, and deleted/retired values must retain user/date/time audit history. Historical records preserve retired labels.

# 13\. Alerts, exception reporting, and data quality

A dedicated exception dashboard should show ownership, age, reason, and next action—not simply red flags. Authorized users may override a rule only with reason, user, timestamp, and when appropriate approval.

|  |  |
| :-: | :-: |
| \*\*Required flag\*\* | \*\*Recommended behavior\*\* |
| No future due date / no clear summary | Block or prominently warn before leaving active intake; show in data-quality queue. |
| Missing before/after photos | Flag when required by workflow; document approved exception. |
| Ready to relist but not released/closed | Alert Property Operations and Sales; expose blocking item. |
| Available with unresolved legal, foreclosure, safety, or cleanup | Prevent status sync/release; require authorized override if emergency exception. |
| \\\>20% above comparable median | Review flag with category/severity benchmark, not an automatic rejection. |
| Severity 4/5 without two complete bids | Prevent advance or require documented exception/approval. |
| Documentation standard incomplete | Flag missing required documents, timeline entries, verification, contract, W-9, or payment notification as applicable. |
| Invalid type/stage/status | Prevent incompatible combinations and show corrective action. |
| Migration inconsistency | Preserve imported data, flag for cleanup, assign owner, and make reportable. |

  

# 14\. Reporting definitions and cleanup comparison model

The Hub must retain raw assessment inputs so CCL can improve its cleanup-severity and cost model rather than being locked into an early formula. Start with an editable 1–5 severity rating plus structured inputs: primary category, debris/trash amount, piles/estimated loads or other future measurement, affected area, item counts, structures/RVs/vehicles, access, terrain/brush, hauling/disposal, hazards, occupancy, and before photos/video. Allow later vendor walkthrough validation and severity reclassification with audit history.

|  |  |
| :-: | :-: |
| \*\*Measure\*\* | \*\*Definition / control\*\* |
| Completed cleanups | Count CCL-performed cleanup jobs by verified completion date; separately report buyer-cleanup and Foreclosure-Page dispositions. |
| Spend | Approved contract amount plus documented additional direct costs outside contract. |
| Average / median cost | Report all completed CCL cleanups and by primary category/severity/state/coordinator. |
| Comparable median variance | Compare job to same category + severity across all states/coordinators; flag \\\>20%. |
| Time Taking Bids → Completed | Timestamp first complete bid stage/event through verified completion. |
| Time off market | Track total period off market and each phase/reason. Legal is a separate reason/phase and should not be mixed into cleanup-cost effectiveness. |
| Data-entry error rate | Count/review validation flags, exceptions, corrections, and incomplete required items; define baseline after migration. |

  

# 15\. Search, record history, and usability

  - Context-aware search: Property Issues prioritizes properties, issues, people, vendors, communications, documents, and transactions; Loan Services prioritizes accounts/payment data; CRM prioritizes people/vendors/property relationships. “All Hub” broadens search.
  - Support search by property/development/tract, person, phone/email, contract/transaction/case number, issue text, attorney case, vehicle/RV description, document, and communication content as permitted.
  - Hover cards on linked names show key information and quick links; clicking opens the full record.
  - Offer saved spreadsheet-like list views with filters/columns that users may show/hide, plus a focused record window for the issue.
  - Desktop is the supported Property Operations interface. Mobile CRM calling/texting may remain available through the shared CRM, but no Property Operations mobile field workflow is included in Phase 1 or the current roadmap.

# 16\. Migration from Airtable to Supabase

  - Migrate all history: open and completed issues, activities, dates, summaries, linked property/person/transaction records, map links, PandaDoc links, bids, costs, photos, attachments, status/stage history, First Dibs, and pricing fields.
  - Perform data cleanup and mapping before import; create normalization rules for issue/stage names, state variants, status values, duplicate records, and date fields.
  - Records that cannot be standardized remain preserved with a Needs Data Cleanup flag, reason, owner, and reportable queue. Do not silently discard information.
  - Validate samples, relationships, attachments, and reconciliation totals before Airtable becomes a read-only archive. Retain Airtable record IDs and original links only as migration provenance; the Hub must use Supabase internal IDs and must not depend on Airtable after cutover.
  - Exclude the discontinued James/salaried-cleanup allocation process from future costing. Preserve historical values/reporting as legacy data only.

# 17\. Sample workflows

## Example A: signed voluntary surrender with map clearance

PandaDoc confirms all required parties signed. Inventory changes to Off Market, a Default / Property Recovery case is created and assigned. The coordinator pastes the My Maps link, reviews current imagery, records Map Review—cleared with rationale, confirms vacancy/condition through reliable evidence, completes release checks, and routes any required price/special-listing review before the website becomes Available.

## Example B: non-signed VS proceeds to legal, then signs

Loan Services communications, notices, scanned certified-mail receipts, and payment history assemble into the Attorney Packet. The legal coordinator tracks current status, next action, deadline, attorney update, fees, and court documents. If the owner signs later, record signature date and form, close/handoff Legal with outcome and summary, then assign Property Recovery to verify vacancy and condition.

## Example C: Foreclosure Page sale with buyer cleanup

Property is placed on Foreclosure Page with True Discount and buyer cleanup obligation. Case waits passively for sale. Sales notification activates Buyer Cleanup. The Hub creates the contract-specific deadline (typically 30 days), midpoint and one-week-prior reminders, plus a customer-provided action-date reminder. Verify completion or escalate to covenant workflow.

## Example D: repeat covenant issue

A neighbor reports debris on a current owner’s tract. The Hub finds the existing owner/property case and prior notices. New report/photos attach to the case. First and second notices carry configurable cure periods. Partial work is documented but does not close the case. A new violation after completion reopens the same case as a new reporting cycle.

# 18\. Open decisions and recommendations for Emma

|  |  |
| :-: | :-: |
| \*\*Decision\*\* | \*\*Recommendation / why it matters\*\* |
| Exact Market Readiness naming | Use a flexible Market Readiness case initially; decide whether CCL Cleanup is its own type or a work section after reviewing users’ terminology. |
| Legal outcomes and event templates | Build configurable legal event/status/notice templates by state. Begin with required status, owner, next action, and due date rather than hard-coding an immature process. |
| Cleanup severity rubric | Start editable 1–5 severity with raw inputs and baseline data; calibrate formula after enough verified jobs. |
| KPI targets | Run baseline reporting first; later set targets for cost, turnaround, off-market time, documentation, and workload. |
| Approval matrix | Define initial dollar/severity thresholds and special release/reinstatement approvals; maintain individual limits in Settings. |
| Sensitive-data policy | Current preference is broad internal view access. Confirm whether attorney/client/payment details later need restricted views. |
| Website release rules | Confirm all blocking conditions and special listing categories; retain configurable Sales review gates. |
| Vendor scorecard | Start with factual performance history; decide later whether a formal rating/recommendation system will be used. |

  

# Recommended implementation sequence

  - Foundation: shared Property, Person, Account, Document, Transaction, Issue, Task, Phase, and audit-history model; Inventory migration and search.
  - Core operations: Default/VS/Recovery, Covenant, tasks/dates, restrictions, map review, documents, CRM communications, and controlled inventory/website release.
  - Cleanup and vendor: assessment, bids, authority limits, contracts, costs, payment notification, photos, verification, and buyer cleanup.
  - Management: dashboards, cost comparisons, data-quality/exception queue, configurable settings, and reports.
  - Expansion: state legal templates, attorney collaboration, and embedded AI drafting/copilot.

**Document status:** This document reflects the Property Operations perspective and is intentionally specific about required controls while preserving configuration flexibility for legal processes, roles, reporting standards, and future workflows.

# 19\. Product boundary and system ownership

The CCL Hub is the employee workspace. Supabase is the operational data platform. External services remain providers for specialized capabilities until CCL replaces them. The developer must document the authoritative source for every shared field and may not create competing editable copies without a conflict-resolution rule.

  

Recommended system ownership for Phase 1:

• Supabase: Property, Person/Organization, role relationships, Issue, Issue Cycle, Phase Instance, Task, restriction/hold, evidence metadata, document link, bid, vendor job, cost, approval, notification, configuration, integration mapping, workflow event, and audit event.

• Loan Services Hub module: owns servicing workflows for accounts, payment history, delinquency, arrangements, notices, voluntary surrender, default, reinstatement, and account closure. It operates on the same Supabase Property, Person, Contract, Account, Task, Communication, Document, restriction, and audit records used by the other Hub modules; it must not maintain a second copy of those records.

• PandaDoc: document preparation and signature status until replaced. Supabase stores the document relationship, provider ID, template/version, parties, signature events, completed-file reference, and ingestion status.

• JustCall and Google Workspace: communication transport until replaced. Supabase stores normalized communication events, provider identifiers, participants, direction, timestamps, permitted content/recording links, and delivery/sync status.

• Website and Sales/Transactions: authoritative publishing and sale events according to approved integration contracts. Supabase controls release eligibility and records every release decision.

• Airtable: migration source and read-only archive after cutover; never a required runtime dependency.

  

# 20\. Canonical data model requirements

The developer shall deliver an entity-relationship diagram and data dictionary. At minimum, the model must distinguish these records:

• Property: one permanent tract/property identity, development, geography, map references, inventory status, website status, pricing history, and active blocking summary.

• Person and Organization: separate humans and companies with multiple contact methods, addresses, preferences, relationship roles, and source provenance. Shared contact information does not merge people automatically.

• Property relationship: a time-bounded link between a person/organization and a property, including owner, buyer, former owner, neighbor, reporter, vendor, attorney, or other configured role.

• Issue: the long-lived property-operations case for the defined owner-property event. It retains type, summary, priority, coordinator, lifecycle status, current phase, active restrictions, and current next action.

• Issue Cycle: a reportable occurrence within a reopened issue, with its own opened/closed dates, reason, outcome, and metrics while preserving the parent case history.

• Phase Instance: one execution of a configured workflow phase, including owner, start/end, status, entry reason, exit outcome, required evidence, and handoff.

• Task: actionable work with assignee or queue, due date, status, priority, dependency, source rule, completion evidence, and link to issue/cycle/phase/property/person as applicable.

• Restriction/Hold: a separate blocking record with type, scope, effective dates, reason, source, owner, release criteria, release authority, and audit history. A property may have multiple simultaneous holds.

• Evidence/Document: file metadata, storage/provider reference, category, uploader/source, captured date, related records, retention classification, access classification, and integrity/sync status.

• Communication Event: normalized call, voicemail, SMS, email, notice, or other interaction linked to participants and applicable issue/property/task, while retaining provider IDs.

• Bid and Vendor Job: requested scope, vendor, response, completeness, amount, estimated dates, approval, contract, changes, final cost, evidence, and completion verification.

• Approval: requested action, threshold/rule, requester, approver role, decision, reason, evidence, timestamp, and immutable relationship to the affected command.

• Configuration Version: effective-dated workflow definitions, choices, deadlines, thresholds, templates, notification rules, approval limits, and role rights. Historical cases retain the version used.

• Integration Identity and Sync Attempt: internal object, source system, external object type/ID, direction, idempotency key, attempt result, retry schedule, error, and resolution.

• Audit Event: actor, effective role, action, object, before/after representation, reason, correlation/request ID, source, and timestamp. Ordinary users cannot alter or delete audit events.

  

# 21\. Workflow engine and state-transition requirements

Workflows must be data-driven and versioned, but safety-critical transitions require explicit validation in trusted server-side code or database functions.

• A transition definition states allowed source state, destination state, triggering role/event, prerequisites, required fields/evidence, tasks created or closed, notifications, restrictions added/released, approvals, and audit event.

• The interface shows only actions the user may request, but the server independently rechecks permission and prerequisites.

• Cross-record transitions execute atomically. A failed transition must not leave the issue advanced while the property, hold, task, or website status remains inconsistent.

• Replayed webhooks and user retries are idempotent. The same external event cannot create duplicate issues, tasks, documents, costs, or transitions.

• Administrators may publish a new workflow version after validation. Active cases continue under the assigned version unless an authorized migration moves them with documented impact.

• Manual overrides require an allowed override role, reason, evidence when applicable, approval when configured, and an audit event. Overrides never erase the failed prerequisite.

• Reopening creates a new Issue Cycle and preserves prior completion dates and metrics. It does not overwrite the prior outcome.

• An Issue cannot be considered Active without a coordinator/queue, concise summary, next task, and future due date unless it is in an approved passive-wait state with a defined wake-up event.

• A property cannot become Available while any active blocking hold exists. Release evaluates all holds and prerequisites at the moment of the command, not only what the screen previously displayed.

  

# 22\. Integration contracts and resilience

For every external system, the developer shall document: business purpose, authoritative fields, direction, trigger, authentication, payload schema, stable external ID, idempotency key, expected latency, retry policy, timeout, dead-letter/recovery path, reconciliation query, monitoring owner, and user-visible failure behavior.

  

Minimum integration behavior:

• Integration failure must be visible on the affected record and in an operations queue; no silent data loss is permitted.

• Customer or employee work may continue in a safe degraded mode when a non-authoritative provider is unavailable. Deferred work queues for retry without duplication.

• A provider webhook is stored or logged with a correlation ID before processing when needed for recovery and audit.

• Out-of-order events are detected and handled using provider event time, version, or sequence where available.

• Field conflicts follow the approved source-of-truth matrix. The system must not resolve a conflict by whichever system wrote last unless that is the documented rule.

• Administrators can retry, dismiss with reason, or reconcile failed items according to permission. Every recovery action is audited.

• Scheduled reconciliation compares counts and key states between Supabase and each provider and reports discrepancies.

  

# 23\. Roles, security, privacy, and audit controls

Broad view access is a business preference, not a substitute for a permission model. The developer must implement and test a role-capability matrix and Supabase Row Level Security policies for employees, coordinators, managers, Loan Services, Sales, Accounting, administrators, service accounts, and future external collaborators.

• Separate view, create, edit, approve, override, release, export, configure, merge, archive, and technical-administration permissions.

• Sensitive servicing, attorney, payment, identity, and communication content must support field or record restrictions even if Phase 1 initially grants broad internal access.

• Service-role credentials never appear in browser code. Privileged operations run in trusted server-side functions.

• Exports require permission, record who exported what and when, and apply the same data restrictions as the interface.

• Files use private storage by default with short-lived authorized access. Uploads enforce allowed types, size limits, malware scanning or an approved compensating control, and retention rules.

• Logs must not expose full payment data, secrets, authentication tokens, or unnecessary personal information.

• Access to sensitive records, changes to permissions/configuration, approvals, overrides, releases, merges, imports, exports, and deletion/archive actions are auditable.

• Backup, point-in-time recovery, restore testing, incident response, and access-review procedures must be documented before production launch.

  

# 24\. Airtable migration, reconciliation, and cutover

The developer shall profile the actual Airtable bases before finalizing the schema or estimate. Migration must include tables, linked records, formulas whose results carry business meaning, attachments, activity history, created/modified metadata, collaborators when relevant, and deleted/retired choice values needed to interpret history.

  

Required migration outputs and gates:

• Source inventory and field-level source-to-target map, including transformation, default, exclusion reason, and destination owner.

• Mapping of Airtable linked records into Supabase relationship tables without relying on display names.

• Normalization rules for property identifiers, people, organizations, issue types, phases, statuses, dates, addresses, vendors, costs, and legacy choice values.

• Deterministic duplicate rules plus a review queue for ambiguous people, properties, issues, transactions, documents, and communications.

• Every source row is classified as migrated, merged, quarantined, rejected with reason, or intentionally excluded. Counts reconcile by source table and classification.

• Attachments reconcile by source count, migrated count, missing/inaccessible count, and integrity evidence where technically available.

• A production-like rehearsal validates relationships, workflow history, current open work, reports, permissions, search, and integration mappings at representative volume.

• Business users validate samples across every issue type and state, including completed history and reopened cycles.

• The cutover runbook defines freeze/read-only timing, final delta, responsible people, go/no-go criteria, rollback trigger and steps, post-cutover checks, and the date Airtable ceases to be an operational writer.

• Airtable is not retired until CCL signs the reconciliation report and confirms that required history is searchable and reportable in the Hub.

  

# 25\. Nonfunctional and operational requirements

Before implementation is fixed-price or launch-ready, CCL and the developer must approve measurable targets for expected users, properties, people, open/closed issues, tasks, communications, files, concurrent usage, integration volume, and growth.

• Availability, recovery-time objective, recovery-point objective, support hours, maintenance windows, and incident severity/escalation are defined.

• Common task-list, property, person, issue, and search views have agreed response-time targets at expected and peak volume.

• Search results enforce permissions and provide stable pagination, filtering, sorting, and explainable ranking.

• Accessibility target is WCAG 2.2 AA for employee workflows unless CCL approves a documented exception.

• Supported desktop browsers are explicitly listed for Phase 1. A Property Operations mobile field workflow is excluded from the current scope and roadmap.

• Monitoring covers application errors, database health, slow queries, job queues, webhooks, synchronization failures, notification delivery, storage, and backup status.

• Environments are separated. Production data is not copied into development without approved masking and access controls.

• Database schema, functions, Row Level Security policies, configuration seeds, and deployment definitions are version-controlled and deployed through reviewed migrations.

  

# 26\. Developer deliverables and traceability

Before coding, the developer shall return a Phase 0 discovery package containing the validated architecture, source-of-truth matrix, entity-relationship diagram, data dictionary, workflow/state diagrams, permission matrix, integration contracts, migration profile, volume baseline, security decisions, open-decision log, risks, phased estimate, and proposed acceptance plan.

  

During delivery, maintain a traceability matrix with one row per requirement or workflow rule and these fields: requirement text, phase/priority, design component, Supabase objects, permission/RLS rule, interface surface, transition/API/integration dependency, failure behavior, audit event, notification, test case, implementation status, evidence, and approving CCL owner.

  

Required implementation artifacts include:

• Version-controlled source code, database migrations, functions, RLS policies, configuration seeds, test fixtures, and deployment definitions in CCL-owned repositories and accounts.

• Automated unit, database, permission, workflow-transition, idempotency, integration, and regression tests.

• User-acceptance scripts covering each issue type, role, approval, override, hold/release, reopen, migration, search, report, and integration-failure path.

• Deployment, rollback, backup/restore, monitoring, reconciliation, incident, configuration, user-administration, and support runbooks.

• Administrator and end-user training materials plus a known-limitations and deferred-scope register.

  

# 27\. Phase 1 definition of done

Phase 1 is complete only when:

• Confirmed Phase 1 workflows operate in a production-like environment with accepted data, permissions, validations, transitions, notifications, audit, and reporting.

• No property can become Available through the Hub or an integration while a blocking hold or failed release prerequisite exists.

• Every active non-passive case has an accountable owner/queue, concise summary, next task, and due date; passive wait states have a defined triggering event or review date.

• Authorized users can reconstruct the complete case history across cycles, phases, tasks, communications, documents, bids, costs, approvals, restrictions, overrides, and releases.

• Supabase remains internally consistent under concurrent actions, retries, duplicated webhooks, provider outages, and partial failures.

• Airtable reconciliation is signed, required history is migrated and searchable, and Airtable is no longer needed for daily operations.

• Required tests pass; critical security, data-loss, permission, audit, migration, and release-control defects are resolved.

• CCL accepts the release, documentation, training, runbooks, monitoring, backup/restore evidence, and rollback capability.

# 28\. Shared Hub rules: Loan Services, Property Operations, CRM, and contract eligibility

Loan Services is a first-class CCL Hub module operating on the same Supabase database, login, employee directory, Person, Property, Contract, Account, Task, Communication, Document, restriction, configuration, and audit records as CRM, Property Operations, Inventory, and Sales/Transactions. The modules provide role-specific interfaces and control different workflows, but they do not synchronize duplicate copies of shared business records.

  

## 28.1 Module decision ownership

• Loan Services controls servicing decisions and events: payment posting, arrears status, reinstatement request and approval, voluntary-surrender lifecycle, default status, servicing notices, account closure, and other approved account actions.

• Property Operations controls physical and operational decisions: vacancy/occupancy verification, recovery review, cleanup requirement and progress, vendor work, completion verification, legal/safety/cleanup holds within its authority, and operational release.

• CRM/Communications controls normalized calls, texts, emails, voicemail, contact points, communication preferences, and person-centered communication history. Communications may be linked to the relevant Account, Contract, Property, Issue, Phase, and Task without creating copies.

• Inventory and Sales/Transactions control approved pricing, marketing, sale, and contract workflows, but they may not create a new contract or publish a property unless the shared eligibility service confirms that all prerequisites are satisfied.

• The shared platform controls identity, authentication, permissions, configuration, tasks, notifications, documents, integration identities, search, calculated control summaries, and audit history.

  

## 28.2 Central Property Control Summary

Each Property shall expose a calculated control summary available to every authorized Hub module. It shall include current Contract and Account relationships, accepted voluntary-surrender state, default/legal state, occupancy state, active Property Operations Issue and phase, cleanup state, active restrictions/holds, website eligibility, new-contract eligibility, next responsible department/task, last verified change, and human-readable blocking reasons.

  

The control summary is calculated from authoritative underlying records. It is not a manually editable status. Resolving a blocking condition requires the authorized workflow action that closes or releases the underlying restriction.

  

## 28.3 Contract and listing eligibility service

Every command to prepare, generate, open, activate, or publish a new Contract shall call the centralized eligibility service immediately before the action is committed. The same eligibility service controls website and inventory release where applicable.

  

At minimum, a new Contract is blocked when:

• an active Contract or reinstated Account already controls the Property;

• cleanup is required, scheduled, underway, or completed but not verified and released;

• an accepted/effective voluntary surrender has not completed the required Property Operations recovery and release pathway;

• an active legal, foreclosure, safety, occupancy, title, covenant, or other configured blocking hold exists;

• required price review, special-listing review, vacancy/condition verification, or release approval is incomplete; or

• a conflicting transaction or contract command is already pending.

  

The failed command shall identify all blocking reasons, responsible module/owner, and next action. Hiding an action in the interface is not sufficient; the database or trusted server command must reject an ineligible transaction.

  

## 28.4 Voluntary-surrender lifecycle and reinstatement rule

Voluntary surrender shall be a versioned lifecycle rather than a single checkbox. Supported states shall include at minimum Draft, Sent, Partially Signed, Fully Signed, Accepted/Effective, Withdrawn/Invalidated when authorized, Superseded, and Completed Document Verified. The record shall retain required parties, signature status and time for each party, provider/document identity, completed file, verification, effective/accepted time, related Account/Contract/Property, and complete audit history.

  

CCL-confirmed business rules:

• Draft, sent, or partially signed voluntary surrender does not by itself make the prior Account ineligible for an approved reinstatement.

• Once voluntary surrender is Accepted/Effective with all required signatures and CCL verification, the prior Account cannot be reopened through the ordinary reinstatement workflow.

• A former customer seeking the Property after an Accepted/Effective voluntary surrender must proceed through a new Contract workflow, subject to customer, property, pricing, legal, cleanup, and release eligibility.

• A new Contract shall not be created merely because the old Account cannot be reopened; the Property must first complete all applicable recovery and release controls.

• Any authorized correction, withdrawal, invalidation, or superseding of an Accepted/Effective voluntary surrender requires restricted permission, documented basis, required approval, retained prior state, and audit history.

  

## 28.5 Account reinstatement and cleanup interruption

Payment receipt alone shall not stop Property Operations. The controlling event is Reinstatement Approved/Effective under the Loan Services workflow after required payment and business conditions are confirmed.

  

When Reinstatement Approved/Effective is committed, the same controlled transaction or reliable follow-on job shall:

• verify that no Accepted/Effective voluntary surrender blocks reinstatement;

• restore or confirm the existing Account and Contract relationship rather than creating a new Contract;

• create or maintain an Existing Contract Active restriction that blocks new-contract and website-release actions;

• identify every open Property Operations Issue, Phase, Task, cleanup job, bid, approval, vendor commitment, and pending release for the Property;

• immediately place affected recovery and cleanup work into a Reinstatement Review state;

• cancel or invalidate any pending property-release or new-contract approval that is no longer valid;

• create an urgent task and notification for the Property Operations coordinator and applicable manager;

• preserve all work, communications, photographs, bids, contracts, commitments, and costs incurred before reinstatement; and

• record the triggering account event and every resulting state change in the shared audit timeline.

  

Property Operations must then make and document the operational disposition:

• Cancel cleanup because possession/control returned to the customer;

• Pause cleanup pending occupancy, safety, legal, vendor, or management review;

• Continue limited work that remains legally or operationally required;

• Close unstarted vendor work and record any consequence;

• Resolve work already started, committed cost, or vendor obligations; or

• Escalate an exceptional conflict to authorized management/legal review.

  

The system shall not automatically erase a cleanup requirement or claim that a property is physically restored solely because an Account was reinstated.

  

## 28.6 Communications, notices, and shared tasks

Loan Services and Property Operations determine when their workflow requires a communication or notice. CRM/Communications provides the shared communication record and delivery capability.

• A notice retains its governing workflow/template version, reason, related Account/Contract/Property/Issue, recipients, contact point or mailing address used, generation time, approval when required, send/delivery status, failure, rendered document, cure or response deadline, and provider identity.

• One call, text, email, voicemail, or notice may appear on the Person timeline, Account/Contract history, and Property Operations Issue timeline through relationships to one Communication Event; it shall not be copied into independent records.

• CCL shall provide one consolidated employee task inbox. Tasks retain the owning module, workflow source, applicable records, assignee or queue, due date, priority, prerequisites, completion evidence, and audit history.

• A module may display and complete permitted shared Tasks without taking ownership of the Person, Property, Account, Contract, or Issue unless a separate authorized reassignment occurs.

  

## 28.7 Concurrency, stale decisions, and exception handling

The platform shall prevent conflicting near-simultaneous actions. Eligibility and prerequisites must be re-evaluated when the command commits, using current database state and appropriate transactions/locking.

• Reinstatement invalidates a stale pending cleanup release, listing approval, or new-contract approval.

• An Accepted/Effective voluntary surrender committed before a reinstatement command causes the reinstatement command to fail with the blocking reason.

• A cleanup or legal hold added before contract activation causes activation to fail even if the contract was prepared earlier.

• Duplicate events, retries, and repeated user clicks must be idempotent.

• A partial failure must not leave the Account reinstated while cleanup continues without review, or leave a new Contract active while the Property remains blocked.

• Unresolved conflicts enter a visible exception queue with owner, age, reason, affected records, attempted action, and recovery path.

  

## 28.8 Required acceptance scenarios

The developer shall include automated and user-acceptance tests for at least these scenarios:

• Cleanup active; Sales attempts a new Contract; action is blocked with all reasons and next owner/action.

• Cleanup completed but not verified; listing and Contract remain blocked.

• Voluntary surrender sent but not fully accepted; approved reinstatement remains possible under Loan Services rules.

• Voluntary surrender Accepted/Effective; old Account reinstatement is blocked; new Contract requires full property release.

• Arrears are paid but reinstatement is not yet approved; cleanup continues and the payment event is visible without prematurely stopping work.

• Reinstatement Approved/Effective before cleanup starts; cleanup work moves to Reinstatement Review and responsible users are notified.

• Reinstatement Approved/Effective after a vendor begins work; costs and commitments are preserved and an urgent exception is created.

• Reinstatement and new-contract or release commands occur nearly simultaneously; only the legally valid/current action commits and no inconsistent state remains.

• The same Loan Services event is delivered twice; no duplicate Account transition, task, restriction, or notification is created.

• Authorized users can reconstruct the complete Person, Account, Contract, Property, Issue, communication, notice, cleanup, reinstatement, restriction, and decision history.

  

# 29\. Additional Phase 1 operational capabilities

The following requirements are approved additions to Phase 1 unless CCL later rephases an item through the change-control process. They extend, rather than replace, the requirements above.

  

## 29.1 Weekly AI living case summary

• Every active Property Operations Issue shall maintain a system-generated living summary that refreshes automatically once each week on a configurable schedule. Authorized users may also request an on-demand refresh after a material event.

• The summary shall consider all permitted calls, call transcripts or approved recording summaries, texts, emails, voicemails, and logged conversation notes between the assigned Property Operations user or team and People linked to the Issue during the active case period. If a Person has multiple matters, the system shall preserve the record context and shall not blend a communication that is linked exclusively to another matter.

• The summary shall state the current situation, material developments since the prior summary, customer/vendor commitments and promised dates, unresolved questions, current blockers or holds, next actions, responsible owners, and upcoming due dates. It shall distinguish a verified fact from a customer statement, employee note, promise, inference, and open question.

• Every material summary statement shall provide a source reference to the underlying Communication Event, note, Task, Document, or Timeline Event, including its date/time and participants. Users shall be able to open the source from the summary.

• Each generation shall retain generated time, coverage-through time, included source-event IDs, excluded or unavailable source warnings, model/provider and prompt/version metadata, and the user or automation that requested it. Prior weekly summaries shall remain available; a refresh shall create a new version rather than overwrite history.

• A user-authored case description, legal note, or approved decision shall remain separate from the AI summary. Authorized users may mark an AI statement inaccurate or exclude an irrelevant source, but the correction and prior version shall remain auditable.

• The AI shall not calculate legal deadlines, make legal conclusions, determine whether a notice was effective, change a workflow state, release a hold, close an Issue, send a communication, or replace the authoritative record. If generation fails or sources are unavailable, the last summary remains visible with a prominent stale/incomplete warning.

• The weekly job shall run only for active Issues unless an authorized user requests a closed-case refresh. It shall avoid unnecessary regeneration when no source information changed while still recording that the scheduled review occurred.

  

## 29.2 Complete edit history and evidence chain of custody

• Every material record and field change—not only uploaded evidence—shall retain the actor or service, effective role, source system, date/time, reason when required, prior value, new value, correlation ID, and related workflow command. Ordinary users shall not hard-delete or rewrite this history.

• Original photos, videos, recordings, documents, exports, and other evidence shall be stored as immutable file versions. The system shall retain original filename, type, size, captured time when available, upload/ingestion time, uploader/source, device or location metadata when approved and available, provider ID, checksum or integrity hash where available, and every related Person, Property, Account, Contract, Issue, Phase, and Task.

• Cropping, annotation, redaction, compression, renaming, replacement, or correction shall create a derivative or new version linked to the original. The original shall remain preserved and accessible to authorized users.

• Removal from an ordinary screen shall be a permission-controlled archive or tombstone action, not destruction. Retention expiration, legal hold, authorized purge, and failed integrity checks shall be separately recorded and auditable.

• The interface shall provide an authorized history view that can reconstruct who changed what, when, why, and from which source. Evidence exports shall include a manifest of included files, versions, source metadata, and integrity hashes where available.

  

## 29.3 One-click operational case packet

• Authorized users shall be able to generate a complete Property Operations Case Packet for the current case, a selected Issue Cycle, or a selected date range without manually gathering records.

• The packet shall include the case summary and current status; Property and linked-People information; phase and status history; complete chronology; communications; notices and delivery evidence; Tasks and deadlines; holds and release decisions; approvals and overrides; bids, vendor jobs, costs, and payments; photographs and other evidence; documents; and the final outcome.

• The user shall be able to preview the inclusion list and select Standard, Full, or Custom scope subject to permissions. The packet shall support a print-ready PDF and a ZIP or equivalent export containing permitted source files plus an index/manifest.

• Every generated packet shall be an immutable snapshot with packet ID, generated time, requesting user, source coverage-through time, included and excluded items, redactions, missing-item warnings, file/version references, and integrity hashes where available. Generating a packet shall not copy or alter the underlying canonical records.

  

## 29.4 One-click attorney referral package

• The Attorney Referral Package is a specialized case packet designed to provide counsel the standard facts and source records needed to evaluate or act on a matter.

• At minimum it shall include: customer and all related-party names, roles, contact information, and authority status; the executed original Contract and applicable amendments or assignments; Contract execution/purchase date; Account number and status; purchase/payment/default history permitted for the matter; default, closeout, reinstatement, and voluntary-surrender dates and reasons; Property, development, tract, county/state, parcel/legal description, map, and current control status; plain-language and AI-assisted summaries clearly labeled by source; notices and service evidence; relevant communications; Property Operations chronology; photographs and evidence; legal/court or attorney documents; costs and fees; active holds; deadlines supplied by an approved source; and open questions or missing documents.

• The package shall use a configurable checklist by referral type. Missing required items shall be listed prominently; the system shall never label an incomplete package complete merely because an export was created.

• Users shall be able to print the package, export a consolidated PDF, and export a ZIP or equivalent bundle of permitted source documents. Restricted information shall follow role, privilege, privacy, redaction, and export rules.

• Each generated version shall retain the recipient/matter when entered, creator, creation time, source coverage, included/excluded manifest, redactions, and later supplements. Regeneration shall create a new packet version and preserve the prior version.

  

## 29.5 Required parties and Voluntary Surrender signer validation

• When a Voluntary Surrender is prepared, the Hub shall build the required-signer roster from the parties who signed the executed original Contract and shall show the exact source Contract version used.

• CCL-confirmed business rule: every party who signed the original Contract must sign the Voluntary Surrender before it may become Completed by All Required Parties or Accepted/Effective, unless an authorized legal review records an approved exception or replacement signer with supporting authority evidence.

• Contract amendments, assignments, entity changes, authorized representatives, deceased parties, estates, trusts, guardianships, powers of attorney, or disputed identity shall not silently remove an original signer. These conditions enter a review queue that records the proposed resolution, supporting documents, reviewer, approval, and audit history.

• The interface shall show every required party, role/capacity, delivery destination, sent/viewed/signed/declined/expired status, signature time, provider evidence, and any unresolved authority question.

• A provider-complete event shall not override CCL’s required-party validation. A missing signer, wrong Contract relationship, wrong document version, or unresolved authority issue shall place the Voluntary Surrender in Needs Review and block operational reliance.

  

## 29.6 Possession and abandoned personal-property workflow

• Property Recovery shall maintain a possession status separate from cleanup status. Configurable values shall include at minimum Unknown, Occupied or Suspected Occupied, Vacancy Unverified, Vacancy Verified, Personal Property Present, Removal/Disposition Review, Removal Authorized, Stored, Transferred, Disposed, and Cleared.

• The system shall inventory belongings, structures, vehicles/RVs, equipment, animals, trash versus potentially valuable personal property, keys, gate codes, locks, utilities, and known hazards as applicable. Each item or grouped inventory shall support description, location, owner/claimant if known, photographs/video, observed time, observer, condition, custody, and disposition.

• Suspected occupancy, personal property, animals, vehicles, unsafe structures, environmental concerns, law-enforcement involvement, or disputed possession shall create the appropriate blocking hold and review Task. Cleanup, removal, disposal, lock change, towing, or vendor entry shall not proceed beyond the approved scope until required authorization is documented.

• Notices, storage, transfer, towing, removal, disposal, return to claimant, vendor handling, and related expense shall retain the responsible person, authority/source, dates, documents, evidence, and chain of custody. Future jurisdiction-specific rules may add calculated notices and deadlines without replacing this history.

• A Property cannot be released as vacant/clean merely because a cleanup job is complete; possession and personal-property requirements must also be resolved or expressly approved.

  

## 29.7 Cost allocation, payment request, and recovery

• Vendor payment requests shall be created from the Vendor Job in the Hub rather than relying on email as the system of record. Email may notify the designated Accounting approver/check issuer, a configurable role currently fulfilled by Lori, but the request, documents, decision, and payment status shall remain in Supabase.

• A payment request shall include vendor/payee, Property, Issue and Vendor Job, approved scope, invoice and invoice number when applicable, requested amount, approved amount, contract and change orders, cost category, expense date, payment method, W-9 status/document, approval evidence, requester, designated Accounting owner, and requested timing.

• Required states shall include Draft, Submitted, Needs Information, Approved, Scheduled, Paid, Partially Paid, Denied, Cancelled, and Voided. The system shall prevent or flag a likely duplicate using vendor, invoice number, Property/Job, amount, and source document.

• Accounting shall receive an actionable Hub Task and may request missing information in the workflow. When paid, Accounting shall record paid date, amount, check/payment reference, payee, and supporting proof as permitted. The Vendor Job, Issue costs, Property history, and authorized CRM timelines shall update from the same canonical payment event.

• Costs shall distinguish estimated, bid, committed, approved, invoiced, paid, additional/outside-contract, disputed, recoverable, customer-chargeable, waived, and written-off amounts. The system shall record who approved each classification and why.

• A recoverable or customer-chargeable classification shall not itself post a customer charge. Any charge, fee, waiver, refund, or account adjustment must use the approved Loan Services/Accounting workflow and applicable authority.

• Payment approval or release shall be blocked when the W-9, required agreement, required approval, invoice/support, or vendor identity is missing, unless an authorized documented exception is permitted.

  

## 29.8 Vendor compliance and change control

• The vendor profile shall retain W-9 status, signed contractor agreement, insurance or license information when required by CCL or the work, expiration dates, approved states/service areas, restrictions, and Do Not Dispatch status.

• Bid approval, dispatch, work start, change order, completion acceptance, and payment shall recheck the compliance items configured for that action. A failed check shall identify what is missing and the authorized exception path.

• Scope changes and additional costs shall use a versioned change order linked to the original scope, requester, reason, amount, schedule impact, evidence, and approval. Text messages or verbal instructions may be preserved as evidence but shall not silently change the approved scope.

• Vendor arrival, work performed, completion evidence, verification, invoice, payment, dispute, and performance outcome shall remain linked to the same Vendor Job and visible on the authorized Property and Issue histories.

  

## 29.9 Related cases and multi-property events

• Issues shall support typed relationships including Parent/Child, Related, Duplicate Of, Caused By, Converted To, Supersedes, Same Incident, and Shared Legal Matter.

• One event may affect multiple Properties or People, and one Property may have simultaneous operational, covenant, default, title, boundary, safety, or legal Issues. The system shall present a rollup while preserving separate owners, permissions, stages, Tasks, holds, documents, costs, and outcomes.

• Linking cases shall not merge their timelines or automatically close, release, or change another case. Cross-case effects require an explicit controlled command and audit event.

• Users shall be warned about a likely related or duplicate case using Property, People, date range, issue type, and description, but ambiguous matches require human review.

  

## 29.10 Legal/operational stop-work control

• Authorized users and configured source events shall be able to place an immediate Stop Work/Review Required restriction when CCL receives information concerning possible occupancy, death, bankruptcy, attorney representation, disputed ownership or authority, litigation, government/law-enforcement involvement, unsafe conditions, environmental issues, or another configured high-risk circumstance.

• The restriction records the reported condition and source; it does not declare a legal conclusion. It shall identify the blocked actions, permitted limited actions, responsible reviewer, next Task, review date, and release authority.

• While active, the restriction shall prevent configured notices, automated communications, vendor dispatch, cleanup/removal, disposal, listing, release, or new-Contract actions. Emergency or preservation work requires the approved exception, scope, reason, evidence, and audit event.

  

## 29.11 Shared CRM and record-timeline projection

• Property Operations remains the owner of its operational Issue and decisions, but every relevant canonical event shall appear on each authorized related Person, Property, Account, Contract, Issue, and Legal Matter history without copying the event.

• At minimum, the shared timelines shall show: legal or Stop Work hold placed/released; notice generated, sent, delivered, failed, or returned; customer/vendor communication; AI summary generated or corrected; inspection completed; evidence added or superseded; vendor requested, approved, dispatched, or completed; payment requested or paid; cleanup verified; Voluntary Surrender sent, partially signed, completed, accepted/effective, voided, or superseded; case/attorney packet generated; Issue closed or reopened; and Property released.

• Restricted attorney, servicing, identity, payment, or safety information shall remain discoverable only according to policy. The existence of a neutral restricted-record indicator may be shown where approved, but unauthorized users shall not receive the content through timelines, summaries, search, exports, notifications, APIs, or logs.

  

## 29.12 Phase boundary and exclusions

• The state-specific legal rules and automated deadline-calculation engine are intentionally deferred to a later implementation stage. Phase 1 shall preserve user-entered or externally supplied deadlines, source, rule/template reference when available, responsible owner, verification status, and edit history; it shall not infer legal deadlines with AI.

• The Phase 1 data model shall support later addition of effective-dated, jurisdiction-specific, counsel-approved rules without rewriting historical notices, deadlines, or events.

• A customer self-service cure portal is not included in the current scope. Customer evidence and communications will continue through the approved employee-assisted channels and shall be attached to the canonical records.

  

## 29.13 Minimum acceptance scenarios

• OPS-ADD-001: An active Issue receives new calls, texts, emails, and notes. The weekly job creates a new summary version with source links, coverage time, changes, commitments, blockers, and no unrelated communication from another matter.

• OPS-ADD-002: A user replaces or annotates a photograph or changes a material field. The original evidence/value, replacement, actor, time, reason, and relationship remain reconstructable.

• OPS-ADD-003: A user generates a print-ready Case Packet and source-file bundle. The export contains the permitted chronology and manifest, identifies missing/excluded items, and does not alter the case.

• OPS-ADD-004: An attorney package is requested while the executed Contract or service evidence is missing. The package is generated only with a prominent incomplete checklist and retained version history.

• OPS-ADD-005: One original Contract signer has not signed the Voluntary Surrender. The provider may report complete, but the Hub enters Needs Review and blocks Accepted/Effective status.

• OPS-ADD-006: Personal property or suspected occupancy is recorded. Cleanup, disposal, release, and a new Contract remain blocked until the approved review/disposition occurs.

• OPS-ADD-007: A coordinator submits a vendor payment request with invoice and W-9. Accounting receives a Task, records the check/payment, and all authorized cost/history views update without duplicate expense records.

• OPS-ADD-008: The same vendor invoice is submitted twice. The second request is blocked or routed for duplicate review with an audit event.

• OPS-ADD-009: Several Properties are linked to one incident. Users can see the rollup while each Issue retains its own stage, owner, holds, evidence, costs, and outcome.

• OPS-ADD-010: A restricted legal record exists. Authorized histories display it correctly, while an unauthorized user cannot retrieve its content through the CRM, search, summary, export, notification, API, or logs.

# 30\. CCL Systems Master Vision alignment and design-time answers

This Section 30 is controlling wherever this document touches shared architecture, identity, system ownership, cross-system events, surfaces, security, migration, or sequencing. The Property Operations workflow rules above continue to govern Property Operations internals and may be stricter than a high-level automation example in the Master Vision.

  

## 30.1 Surface and audience boundary

• Property Operations is a thin, focused internal app inside the existing Hub. It is not a standalone fourth surface and shall not create its own login, employee directory, Person table, Property table, or independent integration platform.

• The three permitted product surfaces are the Hub for staff, the public Website, and the Website’s authenticated Customer Portal. Property Operations Phase 1 is Hub-only.

• The Hub uses the shared staff identity and access model. The Customer Portal uses separate customer authentication and account-linkage verification; staff credentials shall never double as customer credentials. A future Portal projection may expose specifically approved customer-facing facts, but never internal case notes, privileged material, reporter/neighbor identity, or unrestricted Hub records.

  

## 30.2 One writer per fact

• Shared identity service: owns the canonical Person identity, external-identity map, identity evidence, merge/unmerge, survivorship, and canonical relationship identifiers under the CRM/Prospects Section 47 design. Property Operations links to these records and may submit evidence or a correction request; it does not maintain a second Person.

• Loan Services: owns loan and Account facts in the approved lsp\_\* servicing model, including payment posting, delinquency/default state, arrangements, reinstatement decision, Account closure, and loan-owned Voluntary Surrender effectiveness decisions. Property Operations consumes loan events and shall never write lsp\_\* loan facts directly.

• Property Operations: owns Property Operations Issue, Issue Cycle, Phase, operational Task, condition/inspection, possession, cleanup requirement and verification, vendor work, operational hold within its authority, cost request, and operational release-decision facts.

• Inventory/Tables: owns the canonical Inventory Property fields assigned to it, including Inventory status, availability, price/True Discount history, website-publish status, and the accepted result of an authorized release command. Property Operations publishes holds and release decisions but does not directly write those Inventory facts.

• Prospects (CRM): owns prospect/contact outcomes, Sales Journey/pipeline facts, relationship ownership, and approved contact/consent updates through the shared Person service. It reads Property Operations and loan facts through canonical relationships and projections without becoming their writer.

• Contract/Documents: the approved Contract workflow owns Contract execution/state; the shared Document service owns canonical document/signature lifecycle facts and immutable files. Property Operations may initiate a document workflow but cannot declare a document completed or effective without the owning validation.

• Sales/Transactions owns sales-lead, First Dibs, and transaction facts. Accounting owns payment approval, check/payment issuance, and paid-state facts. Property Operations owns the request and operational cost classification, not the Accounting decision.

• Website owns public visitor/session, lead-capture, and raw attribution facts and remains a reader of Inventory availability. Communication providers or the shared communication-ingestion service own provider delivery facts; the Hub stores their canonical normalized events.

• A controlled cross-domain command may update several records atomically, but each resulting field is written through the service/function authorized for that fact. A shared database does not authorize every app to update every shared table.

  

## 30.3 Shared domain event log and queued integration jobs

• New cross-system automation shall use the centrally governed, company-wide domain\_events log promoted from cadence\_events and the queued, idempotent subscriber pattern generalized from Live Chat. Property Operations shall not create a separate event store, per-module outbox table, outbox bridge, or bespoke point-to-point synchronization with Loans, Prospects, Inventory/Tables, Website, Portal, Live Chat, Accounting, or Documents.

• Every event shall include event ID, version/type, source module, source record and canonical IDs, related Person/Property/Account/Contract/Issue IDs, occurred/effective/recorded times, actor or service identity, causation/correlation IDs, idempotency key, data classification, and payload schema version. The event contract, type registry, compatibility rules, and subscriber conventions are governed doc-first; cross-domain or incompatible changes require Scott’s approval.

• The owning module shall commit its authoritative fact and the related domain\_events record within the same reliable database transaction. Subscribers shall process idempotently, preserve ordering/version rules where material, and use retry, dead-letter handling, reconciliation, and visible failure ownership. An unavailable subscriber shall not create a second writer, duplicate record, silent data loss, or an avoidable launch dependency.

• Events distribute completed facts; they do not bypass synchronous safety checks. Contract activation, reinstatement, Property release, availability change, payment approval, and other safety-critical commands shall re-read current authoritative state and fail atomically when prerequisites conflict.

• Minimum consumed events include approved loan.defaulted, loan.reinstatement\_effective, loan.account\_closed, loan.voluntary\_surrender\_effective, contract.executed or contract.changed, document.signature\_changed, transaction.completed, communication.recorded, and Inventory/Property status events.

• Minimum published events include property\_operations.issue\_opened, property\_operations.hold\_applied, property\_operations.hold\_released, property\_operations.cleanup\_required, property\_operations.cleanup\_verified, property\_operations.release\_approved, property\_operations.payment\_requested, property\_operations.issue\_closed, and the canonical Task/Document/Communication events created through shared services. Final names and schemas belong in the centrally governed event registry.

  

## 30.4 Safe default-to-availability event chain

The Master Vision’s shorthand “default to availability” shall be implemented as an event chain with Property Operations and release controls, never as a direct flip from a loan default to Available.

• Loan Services commits the authoritative default and publishes loan.defaulted.

• Property Operations idempotently opens or updates the recovery Issue, establishes the required operational restriction, and evaluates Voluntary Surrender, legal process, possession, condition, personal property, cleanup, price review, and other release prerequisites.

• A payment or default event alone never releases a Property. Reinstatement, surrender, legal, cleanup, possession, and eligibility rules in Sections 21, 28, and 29 continue to control.

• After every applicable prerequisite passes, Property Operations commits its release approval and publishes property\_operations.release\_approved.

• Inventory/Tables rechecks current holds, active Contract/Account, price/special-listing rules, and conflicting commands; only Inventory/Tables writes the authoritative availability and website-status facts and publishes property.availability\_changed.

• The Website reads or subscribes to the authoritative Inventory/Tables result. A failed Website update enters a queued/reconciliation exception but does not cause Property Operations or the Website to become a second writer of availability.

  

## 30.5 Identity and shared-record prerequisites

• Property Operations shall use the canonical person\_id and external-identity map defined by CRM/Prospects Section 47. Source IDs from Airtable, Pipedrive, Loans, Website, Portal, Live Chat, JustCall, PandaDoc, vendors, and other providers remain aliases/evidence and never become permanent primary keys.

• Identity, merge/unmerge, survivorship, shared-contact handling, party roles, and relationship time periods must be approved before Property Operations creates new production Person tables or irreversible identity mappings.

• If the identity foundation is not yet available, Property Operations may queue identity evidence against a source alias and continue only within approved safe limits. It shall not mint a competing permanent Person or guess a merge.

  

## 30.6 Forward-only migration and current Inventory authority

• Inventory/Tables remains operational in Airtable for its unmigrated scope until its approved Supabase cutover. Supabase migration design and backfill may proceed in parallel, but Airtable remains the only writer for those facts before cutover.

• Cutover is forward-only: inventory/schema mapping, one-time backfill, shadow reads, reconciliation, freeze or captured final delta, business acceptance, authority switch, and Airtable read-only/retirement for that scope. There shall never be two writable homes for the same fact, even temporarily.

• A mirror or transitional read model is read-only and has an owner, reconciliation process, and end condition. “Controlled dual run” means comparison, shadow reads, or separately partitioned authority—not dual writing of the same record/field.

• Property Operations shall tolerate an unmigrated Inventory source through approved read adapters and queued events without embedding Airtable formulas, linked-record behavior, automations, or IDs as permanent application logic.

  

## 30.7 Central security, recovery, and audit foundation

• The commissioned central authorization program shall define one connection-class role model for Hub staff, salesperson/department scope, anonymous Website access, and customer Portal access. Property Operations may add stricter classifications but shall not invent an incompatible per-app role model.

• The Hub’s service-role path may remain but must be constrained, monitored, and kept out of browser code. Database RLS shall protect applicable core\_\*, cadence\_\*, lsp\_\*, domain\_events, storage, and shared records, while application authorization remains a required second layer.

• The canonical identity-model design is an input to the final RLS design. Scott shall approve the central policies. Adversarial cross-boundary tests shall run after every relevant schema, policy, storage, or authorization change.

• This central security program gates Customer Portal design and production access; it does not block Loans go-live or Website cutover.

• RLS and API tests shall prove that a Portal customer cannot access another customer’s Account, balance, document, communication, Property, or Issue and cannot access any staff-only Property Operations record. Tests shall also cover guessed IDs, search, counts, exports, notifications, file URLs, logs, and service-role misuse.

• Every shared status change retains who, when, why, source event/command, before/after values, and correlation. Existing evidence/version-history requirements remain controlling.

• Point-in-time recovery, backups, restore drills, recovery objectives, and incident response shall be configured and evidenced before production because the shared data spine is a single operational blast radius.

  

## 30.8 Sequencing and non-blocking delivery

• Identity-model design/freeze and the shared event contract are prerequisites for any new permanent cross-system identity implementation or automation. They are design gates, not reasons to block safe standalone work that can queue events against source aliases.

• Loans launch, Website launch, Live Chat delivery, identity design, and Inventory migration design may proceed independently. Property Operations shall consume their approved event/API seams as they become available rather than requiring all systems to launch together.

• Inventory must be authoritative in Supabase before automated Inventory availability can drive the Website without a transitional adapter. The generalized event log must exist before adding a new production cross-system automation.

• Full cross-system Customer 360 and Property 360 payoff pages follow the identity foundation and event log. Property Operations may deliver its focused Issue/Property workspace earlier, using canonical IDs and events so later 360 views require projections rather than rework.

  

## 30.9 Design-time checklist answers for Property Operations

• Surface: Hub, staff only for Phase 1.

• Writes: only Property Operations-owned operational facts and commands through shared services as listed above.

• Reads: authoritative Person/identity, loan, Contract, Inventory, Sales/Transaction, Communication, Document, Accounting, and Website-result facts from their owners.

• Identity link: canonical person\_id plus external-identity aliases; no local duplicate Person.

• Publishes/consumes: governed domain events in Section 30.3; no bespoke point-to-point sync.

• Audiences/RLS: authorized staff roles; future Portal access requires a separately approved projection and customer-auth design.

• Audit: every material status, decision, override, evidence version, export, permission action, and cross-domain command carries who/when/why/source/correlation.

• Anti-duplication check: no second writable copy, long-lived mirror, ungoverned sync, or blocking dependency is permitted.

  

## 30.10 Master Vision alignment acceptance scenarios

• OPS-MV-001: Loan Services publishes loan.defaulted twice. One recovery Issue/transition is created; the Property does not become Available.

• OPS-MV-002: Cleanup is complete but possession or a legal hold remains unresolved. Property Operations cannot publish an effective release approval, and Inventory/Website remain unavailable.

• OPS-MV-003: Property Operations publishes a valid release approval. Inventory/Tables rechecks current prerequisites, writes availability once, publishes property.availability\_changed, and the Website updates from that event/read model.

• OPS-MV-004: Inventory is still authoritative in Airtable. Supabase shadow data differs; users see a reconciliation warning, the shadow cannot write back, and Airtable remains the sole writer until cutover.

• OPS-MV-005: An event subscriber is unavailable. The owning transaction commits safely, a queued job retries without duplication, and the failure is visible with an owner and recovery path.

• OPS-MV-006: Property Operations receives an unknown loan borrower/source identity before canonical matching. It preserves the identity evidence and queues review without creating a competing permanent Person.

• OPS-MV-007: A Portal customer guesses another customer’s Property, Account, document, or file URL. RLS/API authorization returns no protected content and records the security event according to policy.

• OPS-MV-008: A developer proposes direct writes from Property Operations to Inventory availability or lsp\_\* loan status. Architecture review rejects the design and requires the owning command/event path.

  

# 31\. Approved supplemental implementation details

This section records approved additions derived from the supplemental Property Issues specification. It is controlling for the items below. It does not add a Property Operations mobile field workflow; desktop remains the supported Property Operations interface.

  

## 31.1 Unverified report intake and evidence follow-up

• Authorized staff and approved intake channels may record a report before sufficient evidence exists. The report shall link to the live Property and known People, identify the reporter/source when available, retain the original allegation without presenting it as verified fact, and enter an Unverified state.

• Every Unverified report shall have an accountable owner or queue, an evidence-follow-up Task, a due date, and a visible reason it remains unverified. Multiple reports concerning the same owner, Property, and incident shall attach to the existing Issue or Issue Cycle when confidently matched; uncertain matches shall enter review rather than merge automatically.

• Unverified information may inform review but shall not by itself trigger a legal conclusion, customer notice, vendor dispatch, disposal, Property release, or new-Contract restriction beyond an authorized temporary Review Required hold. Final dispositions shall include Verified, Duplicate/Linked, Unable to Verify, Withdrawn, or another configured outcome with reason and audit history.

  

## 31.2 Stale-case acknowledgment

• When an active non-passive Issue has no meaningful activity by a configurable threshold, the Hub shall create a stale-case prompt or Task showing the last meaningful event, current owner, age, blockers, and existing next action.

• The reminder cannot be silently dismissed. The responsible user must record a status explanation and a new next Task/due date, or close/transition the Issue through an authorized outcome. The acknowledgment, explanation, actor, and time remain auditable.

• Repeated staleness or failure to acknowledge shall remain visible in the exception dashboard and may escalate to a manager according to configurable rules. Legitimate passive states shall use an expected triggering event or review date instead of false activity.

  

## 31.3 Phase-based document and evidence checklist

• Each Issue type and Phase shall display a versioned checklist of expected documents and evidence, including notices, delivery/service proof, completed signature documents, signer validation, contracts, vendor agreements, bids, W-9s, invoices, photographs/video, possession records, attorney materials, and payment evidence as applicable.

• Each checklist item shall retain status such as Required-Missing, Present, Verified, Waived, Not Applicable, or Superseded; the governing workflow/template version; the canonical Document or Evidence reference; source; verification actor/time; and any deficiency.

• A waiver or Not Applicable decision requires reason and, where configured, approval. A transition, notice, payment, packet, closure, or release that depends on a missing item shall be blocked or visibly marked incomplete according to the governing rule. The checklist is a view over canonical records and shall not create duplicate files.

  

## 31.4 Filterable case and audit history

• The Issue History view shall be filterable by meaningful business events, workflow transitions, communications, notices, documents/evidence, Tasks, approvals/overrides, vendor/cost activity, holds/releases, exports/packets, AI summaries, integration processing, and lower-level field edits.

• The default view should emphasize meaningful operational events while preserving access to the complete audit record for authorized users. Every displayed entry shall resolve to the same canonical event or record rather than a copied timeline entry.

• Filters, search, summaries, exports, and counts shall enforce the same permissions as the underlying content. Restricted events may show only an approved neutral indicator.

  

## 31.5 Weekend, holiday, and off-hours deadline warnings

• The Hub shall preserve every authoritative or user-entered deadline exactly as recorded, including its source, timezone, rule/template reference when available, and verification status. It shall not silently move a deadline because it falls on a weekend, holiday, or outside business hours.

• The system shall compare deadlines with the configured company calendar and generate an advance warning when an action or follow-up falls outside working hours. The warning shall identify the conflict and the responsible owner but shall not recalculate a legal deadline.

• Holiday calendars, working hours, lead times, and recipients are versioned configuration. Phase 1 continues to prohibit AI or unapproved software rules from calculating legal deadlines.

  

## 31.6 Operational ownership, backup coverage, and delegation

• Every active Phase shall show the accountable role, current owner or queue, next Task, due date, and authorized backup/delegate. Stage or Phase changes may reassign operational responsibility through configured rules without changing ownership of shared Person, Property, Account, Contract, or legal facts.

• Temporary coverage shall record delegate, scope, start/end condition, reason, authorizer, and permitted actions. A manager or approved specialist may act during an owner’s absence without pretending that the permanent role or historical ownership changed.

• Assignment, reassignment, delegation, acceptance, completion, and revocation are audited and projected to the authorized Task and Issue histories. No active non-passive Issue may be left without an accountable owner or queue.

  

## 31.7 Vendor capability and performance facts

• Vendor profiles shall support service categories, states/counties/developments, distance or service radius, equipment/capabilities, capacity or scheduling notes, active/suspended/inactive status, W-9 and other configured compliance status, and links to the canonical Person or Company record.

• The Hub shall calculate factual history such as jobs requested/accepted/completed, average and median bid, average and median actual cost, on-time completion, documentation completeness, change-order frequency, failed verification/rework count, disputes, and payment history where authorized.

• Factual metrics must retain their date range, sample size, exclusions, and source jobs. A subjective rating or recommendation score remains optional and shall not be activated until CCL approves its rubric, permissions, appeal/correction process, and effect on vendor selection.

  

## 31.8 Business and relisting priority separate from urgency

• If CCL enables an economic priority score, it shall be labeled Business Priority or Relisting Priority and remain separate from legal urgency, safety risk, customer cure deadlines, Task due dates, and operational restrictions.

• Approved inputs may include Website interest, comparable time on market, expected margin, time already off market, remaining available inventory in the development, and other versioned business signals. Each score shall retain the input snapshot, source/freshness, formula version, computed time, and any authorized override with reason.

• Economic priority may help order otherwise permissible work. It shall never shorten, extend, suppress, or override a legal deadline; remove a hold; bypass evidence, possession, cleanup, signer, approval, or release requirements; or reduce the visibility of a safety or legal matter.

  

## 31.9 Required implementation appendices and developer artifacts

• The Phase 0/design package shall include a screen-and-field inventory; workflow and state diagrams; notification/event matrix; role-capability and RACI matrix; validation and user-facing error-message catalog; report/query catalog; and representative seed data and test fixtures.

• These artifacts are implementation companions to this requirements document, not new user requirements documents. They shall be version-controlled, traceable to requirement IDs, and updated when an approved workflow, field, event, permission, or decision changes.

• Example payloads and seed records must use fictional data, canonical IDs, approved enum/status values, and edge cases. They shall not introduce hard-coded legal deadlines or assumptions that are not approved elsewhere.

  

## 31.10 Measurable performance acceptance

• Before fixed-price approval, the developer shall document expected and peak volumes for People, Properties, Issues, Tasks, events, communications, documents, vendors, concurrent users, and migration history, then propose measurable response-time and throughput targets.

• At minimum, the daily work screen, Issue detail, Property/Person lookup, filtered history, and permitted search shall have approved percentile-based response targets at expected and peak volume. Permission checks, filtering, and audit creation are included in the measurement and may not be bypassed to meet a target.

• Performance tests, datasets, environment, results, bottlenecks, and accepted exceptions shall be repeatable and retained with release evidence. A proposed target such as two seconds may be evaluated, but no unsupported number becomes binding until CCL accepts the volume assumptions and test method.

  

## 31.11 Future imagery-assisted discovery and predictive signals

• A later phase may retrieve current and historical aerial or satellite imagery using canonical Property coordinates, record imagery source and capture date, compare authorized images, and flag possible structures, debris, vehicles, access changes, fire/vegetation concerns, or other configured anomalies for human review.

• Imagery or AI output is an observation lead, not verified evidence or a legal conclusion. It shall retain model/version, inputs, confidence, reviewer decision, corrections, and audit history and shall not automatically contact a customer, dispatch a vendor, dispose of property, change ownership, release a hold, or make a Property Available.

• Predictive default-risk analysis belongs to Loan Services as the writer of loan-risk or delinquency-derived facts. Property Operations may consume an approved risk event or display an authorized indicator, but it shall not independently recalculate or overwrite the Loan Services result.

  

## 31.12 Minimum acceptance scenarios

• OPS-SUP-001: A neighbor report is entered without photographs. It enters Unverified, receives an owner, Task, and due date, and cannot trigger a notice, vendor dispatch, or release decision until the governing verification rule passes.

• OPS-SUP-002: An active Issue reaches the stale threshold. The coordinator cannot dismiss the prompt without an explanation and next Task/due date; the acknowledgment appears in authorized history.

• OPS-SUP-003: A Phase requires delivery evidence and a completed signature document. The checklist identifies each missing item and blocks the dependent transition while allowing an authorized, reasoned waiver only where configuration permits.

• OPS-SUP-004: An authoritative deadline falls outside configured working hours. The exact deadline remains unchanged, an advance warning is sent, and no legal calculation is inferred.

• OPS-SUP-005: The assigned coordinator is temporarily unavailable. An authorized delegate completes a permitted Task; the action, coverage authority, and permanent owner remain distinguishable in history.

• OPS-SUP-006: Two vendor candidates have different equipment, coverage, and job histories. The comparison uses source-backed metrics with date range and sample size and does not fabricate a subjective score.

• OPS-SUP-007: A Property has high market demand but an unresolved legal hold. Business Priority may rank the work, but the hold, legal urgency, and release prohibition remain controlling.

• OPS-SUP-008: A developer produces the screen inventory, event/notification matrix, RACI, error catalog, and seed fixtures. Each artifact maps to requirement IDs and contains no unapproved legal rule.

• OPS-SUP-009: Performance tests run at approved expected and peak volumes with RLS and audit enabled. Results show the agreed percentile metrics and any accepted exception.

• OPS-SUP-010: Future imagery analysis flags a possible structure. The result creates a human review item with source and confidence; it does not automatically change status, contact a customer, or dispatch work.

  
  
