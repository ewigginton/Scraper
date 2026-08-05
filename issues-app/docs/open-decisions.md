# Open Decisions and Configuration Defaults — Property Operations Issues

Source: spec §18 (open decisions and recommendations for Emma), §27 (developer-readiness rule), seed config (TBD-flagged entries).

This document captures Emma's open business decisions and the Phase 1 defaults for values that are configurable (spec §12, §27). All values are editable via admin settings; development work is not required to change them. Values flagged `"tbd": true` in seed config are listed below.

---

## Emma's Open Decisions (Spec §18)

All decisions are captured in `config_entries` as admin-editable settings. To change, Emma updates the value in admin settings; no code changes required.

| Decision | Current Phase 1 Default | Recommendation | Why It Matters | Location in Config |
| --- | --- | --- | --- | --- |
| **Exact Market Readiness naming and classification** | Issue type `market_readiness` with phases: intake, assessment, taking_bids, cleanup, releasing, closed. **Status: TBD** | Use flexible "Market Readiness" case initially; decide whether CCL Cleanup is its own issue type or a work section after reviewing user terminology | Impacts case structure, phase alignment, and reporting categories. Different naming may require UI reorganization later. | `config_entries` entry_key `issue_types` → `market_readiness` with `tbd: true`, `tbd_note: "Final naming/classification...pending Emma decision"` |
| **Legal outcomes and event templates** | Deferred to Phase 2. Phase 1 stores user-entered or externally-supplied deadlines verbatim; no automated deadline calculation (spec §29.12). | Build configurable legal event/status/notice templates by state. Begin with required status, owner, next action, and due date rather than hard-coding an immature process. | Legal deadlines and escalation rules are state-specific and customer-sensitive. Early hard-coding locks in assumptions. Configurable templates allow CCL to evolve process without development. | Deferred; deadlines stored in `deadlines` table with source + verification_status |
| **Cleanup severity rubric** | Editable 1–5 severity (spec §31.7 input snapshot, source, freshness, formula version). No auto-calculation. | Start with editable 1–5 severity rating plus raw inputs (debris/trash size, item counts, access, terrain, hazards, occupancy). Collect baseline data; calibrate formula after enough verified jobs. | Early formula locks in assumptions about debris scaling and cost drivers. Starting with raw inputs + baseline data allows evidence-based calibration. | Cleanup assessment records: severity (1–5), category, inputs. Formula version and date tracked for audit. |
| **KPI targets and reporting standards** | Baseline mode: report actual averages, medians, ranges, trends (spec §8.2, §14). No KPI targets until data collection baseline established. | Run baseline reporting first (cost, turnaround, off-market time, documentation). Later, set targets for cost, turnaround, off-market time, documentation, and workload based on CCL's data. | Premature KPI targets misalign if data doesn't reflect real work. Starting with baseline and later goal-setting ensures targets are achievable and meaningful. | Reporting queries/dashboards configurable in admin settings after go-live. |
| **Approval matrix and authority limits** | Phase 1 defaults: All releases require manager approval or admin. All payments require accounting approval. Second-bid rule: ≥ $1,500 or severity ≥ 4 requires second complete bid (spec §6.3). | Define initial dollar/severity thresholds and special release/reinstatement approvals. Maintain individual approval limits in personal settings. | Different roles have different risk tolerance and authority scope. Authority limits prevent approval bottlenecks and ensure proper oversight without micromanagement. | Config entry `thresholds` → `second_bid_threshold_usd: 1500`, `severity_two_bid_min: 4`, and approval rules per role. Admin can adjust without code change. |
| **Sensitive-data policy** | Phase 1: broad internal view access (spec §23, business preference). Future RLS stricter per Master Vision (spec §30.7). | Confirm whether attorney/client/payment details later need restricted views for certain roles. Implement support now; choose policy later. | Broad access during early operations supports quick learning. Later, sensitive content (legal strategy, customer financial details, payment amounts) may need restricted access. RLS scaffold is in place; policies are admin-configurable. | `access_classification` field on evidence_files, audit_events, notices (attorney/payment/restricted). RLS policies exist; admin adjusts role access without code. |
| **Website release rules and special listing categories** | Phase 1 defaults: Release requires no blocking hold, condition/vacancy verification, legal/default clearance, map present, price review within 6 months (spec §10). Special listing categories (Foreclosure Page, cabins, etc.) trigger Sales review. | Confirm all blocking conditions and special listing categories. Retain configurable Sales review gates so Emma can adjust rules without development. | Website release is the final gate before property becomes public. Every release rule should reflect CCL's legal/operational risk tolerance. Rules may evolve; admin should control them. | Config entry `thresholds` → `price_review_window_months: 6`. Release prerequisites encoded in transition engine (data-driven, no hard-coded rules). |
| **Vendor scorecard and performance rating** | Phase 1: Factual performance history only (jobs, bids, costs, timing, rework, disputes). No subjective rating or recommendation score. | Start with factual performance history (job count, average cost, on-time completion, change-order frequency, disputes, payment history). Decide later whether a formal rating/recommendation system will be used. | Factual metrics (counts, dates, amounts) are auditable and reproducible. Subjective ratings risk bias and require appeal processes. Early collection of facts supports later goal-setting if CCL chooses ratings. | Vendor profile stores: jobs_requested, jobs_accepted, jobs_completed, avg_bid, avg_actual_cost, on_time_pct, disputes_count, payment_status. No `rating` field in Phase 1. |

---

## TBD-Flagged Configuration Entries (Seed Config)

These entries have `"tbd": true` in the seed config. They are valid Phase 1 defaults and editable via admin settings.

### market_readiness Issue Type (TBD)

**Location:** `config_entries` entry_key `issue_types` → `market_readiness`

**Current Value:**
```json
{
  "market_readiness": {
    "display_name": "Market Readiness",
    "description": "Configurable case for CCL-controlled property needing condition, map, pricing, cleanup, or release work outside a default recovery pathway.",
    "phases": [
      "intake", "assessment", "taking_bids", "cleanup", "releasing", "closed"
    ],
    "tbd": true,
    "tbd_note": "Final naming/classification and phase workflow pending Emma decision"
  }
}
```

**Action:** Emma decides final name (Market Readiness OK, or rename?), phase workflow, and whether CCL Cleanup is its own type or part of Market Readiness. Update display_name, description, phases in admin settings. Remove `tbd` flag once decision is made.

---

## Configurable Thresholds and Deadlines (Phase 1 Defaults)

All values in `config_entries` entry_key `thresholds`. Admin edits them in settings; no development required.

### Business Rules Thresholds

| Config Key | Phase 1 Default | Range | Recommendation | Description |
| --- | --- | --- | --- | --- |
| `second_bid_threshold_usd` | 1500 | $500–$5000 | Keep default; adjust after 3 months of cleanup data. | Bids at or above this amount require a second complete bid (spec §6.3). |
| `severity_two_bid_min` | 4 | 2–5 | Keep default; calibrate after cleanup jobs accumulate. | Cleanup severity >= this value requires second bid per config exception rules (spec §6.3, §13). |
| `stale_case_days` | 14 | 7–30 | Keep default; adjust if coordinator capacity changes. | Issue flagged as stale if no meaningful event for this many days (spec §31.2). |
| `overdue_manager_alert_days` | 3 | 1–7 | Adjust based on CCL management response time. | Manager alert issued after task overdue for this many days (spec §8.3). |
| `price_review_window_months` | 6 | 3–12 | Keep default; may shorten if market volatility increases. | Development price must be reviewed within this window; blocks release if stale (spec §10). |
| `buyer_cleanup_default_deadline_days` | 30 | 14–60 | Adjust per contract terms and compliance risk. | Default contract deadline for buyer cleanup after foreclosure-page sale (spec §6.2). |
| `covenant_first_notice_days` | 14 | 10–30 | Adjust per state law requirements. Document reason. | Default cure period for first covenant notice (spec §6.4, configurable longer with documented reason). |
| `covenant_second_notice_days` | 14 | 10–30 | Adjust per state law requirements. Document reason. | Default cure period for second covenant notice (spec §6.4, typically another 14 days). |

### How to Change Thresholds

1. Go to Settings → Configuration.
2. Select "Phase 1 Defaults" (config_version 1).
3. Edit `thresholds` entry → update value.
4. System logs change with timestamp, actor, reason (spec §12).
5. New cases use updated value; existing cases keep their config_version.

---

## Configurable Approval Limits (Individual Settings)

Per spec §12, Emma or a manager can set individual approval limits in personal settings.

| Role | Configurable Limit | Default | Notes |
| --- | --- | --- | --- |
| **coordinator** | Vendor approval limit (no individual threshold; all above configured second-bid threshold need manager approval). | N/A | Coordinator may approve bids up to configured second-bid threshold; higher bids route to manager. |
| **manager** | Release approval limit (yes/no; all releases need approval). | All releases approved. | Manager approves all releases. Individual exception limit can be set later if needed. |
| **accounting** | Payment approval limit (yes/no; all payments need approval). | All payments approved. | Accounting approves all payments. Individual amount limit can be set later if needed. |

**To change individual limits:**
1. Go to Settings → Users → select user.
2. Edit approval_limit_usd or approval_required_flag.
3. System audits the change (who, when, why).

---

## Notification Recipients and Escalation Rules (Configurable)

Per spec §8.3 and §12, notification recipients and escalation timing are admin-editable.

**Phase 1 defaults:**
- **Overdue task reminder:** 1 day after due date (Task owner receives in-app notification).
- **Manager alert:** 3 days after due date (Manager receives notification + email option).
- **Urgent/emergency rules:** Safety hazards, environmental agency concerns, occupancy/animal/vehicle concerns, legal/court deadlines trigger immediate notification to coordinator + manager.

**To change:**
1. Go to Settings → Notifications.
2. Edit notification rule: trigger, recipients (role), delay, channels (in-app/email/SMS).
3. System logs change (spec §12).

---

## Role Rights Configuration (Admin-Controlled)

Per spec §12, Emma or admin can add/rename/reorder/retire dropdown values and modify role rights.

**Current roles (seeded):** employee, coordinator, manager, loan_services, sales, accounting, admin, service.

**To add a role:**
1. Go to Settings → Roles.
2. Create new role (e.g., "property_manager"), assign capabilities (view, create, edit, approve, etc.).
3. System logs role creation (spec §12).
4. Assign users to new role in personal settings.

**To change role capabilities:**
1. Go to Settings → Roles → select role.
2. Toggle capabilities (e.g., grant coordinator "approve_payment" if needed).
3. System logs capability change (spec §12).
4. Takes effect immediately (no restart required).

---

## Dropdown Values and Choice Lists (Configurable)

Per spec §12, admin can add/rename/reorder/retire dropdown values.

**Current phase-1 defaults (seeded in config_entries):**
- **Hold types:** legal, safety, occupancy, cleanup, foreclosure, title, covenant, stop_work, existing_contract_active, other.
- **Possession statuses:** unknown, occupied_or_suspected, vacancy_unverified, vacancy_verified, personal_property_present, removal_disposition_review, removal_authorized, stored, transferred, disposed, cleared.
- **Task queues:** new_unreviewed, action_dates, notices_due, upcoming, overdue, waiting_blocked, approvals.
- **Cost classifications:** estimated, bid, committed, approved, invoiced, paid, additional_outside_contract, disputed, recoverable, customer_chargeable, waived, written_off.

**To add a hold type:**
1. Go to Settings → Hold Types.
2. Click "Add Hold Type".
3. Enter display_name (e.g., "Environmental Review"), description.
4. System creates entry and logs it (spec §12); old values remain in historical records (spec §12).

**To retire a hold type:**
1. Go to Settings → Hold Types → select type.
2. Click "Retire" (soft delete).
3. Existing cases keep the retired value; new cases cannot use it.
4. Historical records preserve the value (spec §12).

---

## Delayed / Not-Yet-Decided Configuration

The following are intentionally deferred or undefined in Phase 1. They do not have "tbd" flags in seed config because they are not Phase 1 implementation.

| Topic | Status | Rationale | When to Revisit |
| --- | --- | --- | --- |
| **State-specific legal deadline calculation engine** | Deferred to Phase 2. Phase 1 stores deadlines verbatim (spec §29.12). | Legal deadlines are state and matter-specific. No AI deadline inference in Phase 1 (spec §31.12). | After Phase 1 launch, collect 3–6 months of real deadline history; then design templates by state. |
| **AI weekly case summary** | Deferred to Phase 2 (implementation seamed in; events/schema ready, spec §29.1). | Phase 1 focuses on core operational workflow. Weekly summary requires stable communication history and editorial controls. | After Phase 1 launch, evaluate AI copilot accuracy and user feedback before enabling. |
| **Attorney/client packet generation** | Deferred to Phase 2 (schema seamed in, spec §29.3–29.4). | Requires refined legal discovery scope and redaction rules. | After Phase 1 launch and attorney feedback. |
| **Imagery-assisted discovery and anomaly detection** | Deferred to Phase 2 (spec §31.11). | Imagery source (satellite, aerial), model accuracy, and liability issues require separate governance. | Depends on Inventory imagery integration and CCL legal review. |
| **Vendor rating/recommendation system** | Deferred; Phase 1 collects factual history only (spec §31.7). | Subjective ratings require appeal process, bias mitigation, and performance-management implications. | After 6 months of vendor data; determine if CCL wants formal ratings or uses raw metrics for decisions. |
| **Customer self-service cure portal** | Deferred (not in Phase 1, spec §29.12). | Customer Portal auth and data classification require Master Vision alignment. | Phase 2+ after central authorization program stabilizes. |
| **Reinstatement approval workflow and thresholds** | Configurable but not yet defined. Loan Services controls; Property Operations consumes reinstatement_effective event. | Loan Services owns reinstatement approval logic. Property Operations responds to events. | Emma reviews with Loan Services team; document approval thresholds in Loan Services configuration. |

---

## Summary: How to Update Phase 1 Defaults

**No development required. Admin self-service:**

1. **Thresholds:** Settings → Configuration → select "Phase 1 Defaults" → edit thresholds entry.
2. **Role capabilities:** Settings → Roles → select role → toggle capabilities.
3. **Notification rules:** Settings → Notifications → edit rule (trigger, recipients, delay, channels).
4. **Individual approval limits:** Settings → Users → select user → edit approval_limit_usd.
5. **Hold types / Possession statuses / Task queues / Cost classifications:** Settings → [Dropdowns] → add/rename/retire values.

**Every change logged:** actor, timestamp, prior value, new value, reason (spec §12).

**Open decisions (require Emma review, not code change):**
- Market Readiness naming (update display_name, phases, tbd flag).
- Legal templates by state (future phase; start collecting deadline history).
- KPI targets (future phase; start with baseline data).
- Vendor rating system (future phase; start with factual metrics).

---

## Developer Note: Implementing Configurability

All values in seed config are stored in `config_entries` jsonb. To implement a new configurable setting:

1. Add entry to `config_entries` in seed migration with config_key, entry_key, entry_value (jsonb).
2. Reference entry_key in service layer (e.g., `getThreshold('second_bid_threshold_usd')`).
3. Add admin form in Settings UI to edit entry_value.
4. Log change in audit_events (admin action, old value, new value).
5. Queries/screens read from active config_version; historical records retain version_id for reproducibility (spec §12).

Never hard-code business values. All admin-configurable settings support future evolution without development work.
