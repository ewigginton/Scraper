-- 20260731090300_issues_seed_config.sql
-- Property Operations ("Issues") — seed configuration data (DESIGN.md §5 "Platform", spec §12, §27)
--
-- Phase 1 defaults: all values are admin-editable per spec §12. Unresolved business
-- choices are marked with "tbd": true in the value jsonb (spec §27 developer-readiness rule).
--
-- This migration:
--   1. Inserts one config_versions row (version 1, effective now)
--   2. Inserts config_entries rows for:
--      - Issue types with phase lists (spec §4, §6)
--      - Transition definitions (spec §21, §30.10)
--      - Thresholds (spec §6.3, §8.3, §10, §6.4, §31.2)
--      - Hold types list
--      - Possession statuses list (spec §29.6)
--      - Task queues (spec §8.1)
--      - Cost classifications
--      - Roles list (spec §12, DESIGN.md §7)

-- =====================================================================
-- config_versions
-- =====================================================================

-- Phase 1 defaults version: effective now, supersedes nothing
insert into config_versions (config_key, version_label, effective_from, description)
values (
  'phase_1_defaults',
  '1',
  now(),
  'Phase 1 defaults — all values admin-editable per spec §12'
);

-- Store the version ID for use in config_entries
do $$
declare
  v_config_version_id uuid;
begin
  select id into v_config_version_id
  from config_versions
  where config_key = 'phase_1_defaults' and version_label = '1';

  -- =====================================================================
  -- config_entries — Issue Types with Phase Lists (spec §4, §6)
  -- =====================================================================

  -- Default Recovery: full pathway from intake through release/closing
  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'issue_types',
    jsonb_build_object(
      'default_recovery', jsonb_build_object(
        'display_name', 'Default / Property Recovery',
        'description', 'Loan Services-triggered case. May include non-signed VS/legal, accepted VS, vacancy/condition review, CCL cleanup, foreclosure-page disposition, buyer cleanup, and relisting.',
        'phases', jsonb_build_array(
          'intake', 'legal_vs', 'attorney', 'recovery_review', 'taking_bids', 'cleanup', 'buyer_cleanup', 'relisting', 'released', 'closed'
        )
      ),
      'covenant_violation', jsonb_build_object(
        'display_name', 'Covenant Violation',
        'description', 'Active owner case with linked reports, notices, cure periods, verification, escalation, fees/legal when configured.',
        'phases', jsonb_build_array(
          'intake', 'first_notice', 'second_notice', 'cure_verification', 'escalation', 'resolved'
        )
      ),
      'market_readiness', jsonb_build_object(
        'display_name', 'Market Readiness',
        'description', 'Configurable case for CCL-controlled property needing condition, map, pricing, cleanup, or release work outside a default.',
        'phases', jsonb_build_array(
          'intake', 'assessment', 'taking_bids', 'cleanup', 'releasing', 'closed'
        ),
        'tbd', true,
        'tbd_note', 'Final naming/classification and phase workflow pending Emma decision'
      ),
      'property_legal', jsonb_build_object(
        'display_name', 'Property Legal Matter',
        'description', 'Standalone legal issue such as a land/boundary dispute; may place an Off Market legal hold and later hand off to Market Readiness.',
        'phases', jsonb_build_array(
          'intake', 'legal_review', 'resolution', 'released', 'closed'
        )
      ),
      'buyer_cleanup', jsonb_build_object(
        'display_name', 'Buyer Cleanup',
        'description', 'A sold property with a contractual cleanup obligation. Normally created/activated by transaction notification, without CCL bid collection.',
        'phases', jsonb_build_array(
          'intake', 'scheduled', 'in_progress', 'completed', 'verified', 'closed'
        )
      )
    )
  );

  -- =====================================================================
  -- Transition Definitions (spec §21, §30.10)
  -- =====================================================================
  -- Source phase → allowed destinations with prerequisites (named as strings)

  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'transitions',
    jsonb_build_object(
      'default_recovery', jsonb_build_array(
        jsonb_build_object(
          'from_phase', 'intake',
          'to_phase', 'legal_vs',
          'prerequisites', jsonb_build_array('summary_present', 'people_linked'),
          'description', 'Move to legal/VS analysis phase'
        ),
        jsonb_build_object(
          'from_phase', 'intake',
          'to_phase', 'recovery_review',
          'prerequisites', jsonb_build_array('summary_present', 'people_linked', 'vs_not_required'),
          'description', 'Skip to recovery review if no legal/VS needed'
        ),
        jsonb_build_object(
          'from_phase', 'legal_vs',
          'to_phase', 'attorney',
          'prerequisites', jsonb_build_array('legal_referral_approved'),
          'description', 'Escalate to attorney'
        ),
        jsonb_build_object(
          'from_phase', 'attorney',
          'to_phase', 'recovery_review',
          'prerequisites', jsonb_build_array('legal_status_resolved', 'signature_date_recorded'),
          'description', 'Return to recovery after legal resolution or VS signature'
        ),
        jsonb_build_object(
          'from_phase', 'recovery_review',
          'to_phase', 'taking_bids',
          'prerequisites', jsonb_build_array('map_link_present', 'review_decision_recorded'),
          'description', 'Move to bidding phase if cleanup is required'
        ),
        jsonb_build_object(
          'from_phase', 'taking_bids',
          'to_phase', 'cleanup',
          'prerequisites', jsonb_build_array('vendor_approved', 'contract_signed'),
          'description', 'Vendor selected and contracted'
        ),
        jsonb_build_object(
          'from_phase', 'cleanup',
          'to_phase', 'buyer_cleanup',
          'prerequisites', jsonb_build_array('cleanup_verified', 'foreclosure_page_sale_confirmed'),
          'description', 'Move to buyer cleanup phase after CCL cleanup and foreclosure-page sale'
        ),
        jsonb_build_object(
          'from_phase', 'cleanup',
          'to_phase', 'relisting',
          'prerequisites', jsonb_build_array('cleanup_verified', 'no_blocking_holds'),
          'description', 'Ready to relist after cleanup completion'
        ),
        jsonb_build_object(
          'from_phase', 'buyer_cleanup',
          'to_phase', 'relisting',
          'prerequisites', jsonb_build_array('buyer_cleanup_deadline_met_or_resolved'),
          'description', 'Buyer cleanup complete, ready to relist or release'
        ),
        jsonb_build_object(
          'from_phase', 'relisting',
          'to_phase', 'released',
          'prerequisites', jsonb_build_array('no_blocking_holds', 'vacancy_verified', 'price_review_complete'),
          'description', 'Property release approved'
        ),
        jsonb_build_object(
          'from_phase', 'released',
          'to_phase', 'closed',
          'prerequisites', jsonb_build_array('listing_published_or_sale_confirmed'),
          'description', 'Issue closed after property released/sale'
        )
      ),
      'covenant_violation', jsonb_build_array(
        jsonb_build_object(
          'from_phase', 'intake',
          'to_phase', 'first_notice',
          'prerequisites', jsonb_build_array('owner_identified', 'violation_documented'),
          'description', 'Issue first notice to property owner'
        ),
        jsonb_build_object(
          'from_phase', 'first_notice',
          'to_phase', 'cure_verification',
          'prerequisites', jsonb_build_array('first_notice_delivered', 'cure_deadline_passed_or_evidence_received'),
          'description', 'Check for cure after first-notice period'
        ),
        jsonb_build_object(
          'from_phase', 'cure_verification',
          'to_phase', 'resolved',
          'prerequisites', jsonb_build_array('violation_cured_verified'),
          'description', 'Violation fully cured and verified'
        ),
        jsonb_build_object(
          'from_phase', 'cure_verification',
          'to_phase', 'second_notice',
          'prerequisites', jsonb_build_array('cure_incomplete_or_not_evidenced'),
          'description', 'Issue second notice for continued violation'
        ),
        jsonb_build_object(
          'from_phase', 'second_notice',
          'to_phase', 'escalation',
          'prerequisites', jsonb_build_array('second_notice_delivered', 'second_cure_deadline_passed_or_not_cured'),
          'description', 'Escalate to fees/legal if not cured'
        ),
        jsonb_build_object(
          'from_phase', 'escalation',
          'to_phase', 'resolved',
          'prerequisites', jsonb_build_array('escalation_action_complete', 'violation_resolved_or_abandoned'),
          'description', 'Case resolved after escalation'
        )
      )
    )
  );

  -- =====================================================================
  -- Thresholds and Business Rules (spec §6.3, §8.3, §10, §6.4, §31.2)
  -- =====================================================================

  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'thresholds',
    jsonb_build_object(
      'second_bid_threshold_usd', 1500,
      'second_bid_threshold_note', 'Bid amounts at or above this value normally require a second complete bid (spec §6.3)',
      'severity_two_bid_min', 4,
      'severity_two_bid_min_note', 'Cleanup severity >= this value requires second bid per config exception rules',
      'stale_case_days', 14,
      'stale_case_days_note', 'Issue flagged as stale if no meaningful event for this many days (spec §31.2)',
      'overdue_manager_alert_days', 3,
      'overdue_manager_alert_days_note', 'Manager alert issued after task overdue for this many days (spec §8.3)',
      'price_review_window_months', 6,
      'price_review_window_months_note', 'Development price must be reviewed within this window; blocks release if stale (spec §10)',
      'buyer_cleanup_default_deadline_days', 30,
      'buyer_cleanup_default_deadline_days_note', 'Default contract deadline for buyer cleanup after foreclosure-page sale (spec §6.2)',
      'covenant_first_notice_days', 14,
      'covenant_first_notice_days_note', 'Default cure period for first covenant notice (spec §6.4, configurable longer with documented reason)',
      'covenant_second_notice_days', 14,
      'covenant_second_notice_days_note', 'Default cure period for second covenant notice (spec §6.4, normally another 14 days)'
    )
  );

  -- =====================================================================
  -- Hold Types (spec §20, §28.3, §29.10)
  -- =====================================================================

  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'hold_types',
    jsonb_build_object(
      'legal', jsonb_build_object(
        'display_name', 'Legal Hold',
        'description', 'Legal matter blocking release or new contract'
      ),
      'safety', jsonb_build_object(
        'display_name', 'Safety Hold',
        'description', 'Safety hazard or concern blocking release or entry'
      ),
      'occupancy', jsonb_build_object(
        'display_name', 'Occupancy Hold',
        'description', 'Suspected occupancy or personal property blocking release or disposal'
      ),
      'cleanup', jsonb_build_object(
        'display_name', 'Cleanup Hold',
        'description', 'Cleanup required or in progress'
      ),
      'foreclosure', jsonb_build_object(
        'display_name', 'Foreclosure Hold',
        'description', 'Property on foreclosure-page marketing'
      ),
      'title', jsonb_build_object(
        'display_name', 'Title Hold',
        'description', 'Title issue or dispute blocking release'
      ),
      'covenant', jsonb_build_object(
        'display_name', 'Covenant Hold',
        'description', 'Covenant violation under review or enforcement'
      ),
      'stop_work', jsonb_build_object(
        'display_name', 'Stop Work / Review Required',
        'description', 'Immediate stop-work hold pending review; reported condition or high-risk circumstance (spec §29.10)'
      ),
      'existing_contract_active', jsonb_build_object(
        'display_name', 'Existing Contract Active',
        'description', 'Account/contract remains active after reinstatement; blocks new contract and website release (spec §28.5)'
      ),
      'other', jsonb_build_object(
        'display_name', 'Other Hold',
        'description', 'Custom/configured hold type'
      )
    )
  );

  -- =====================================================================
  -- Possession Statuses (spec §29.6)
  -- =====================================================================

  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'possession_statuses',
    jsonb_build_array(
      jsonb_build_object('status', 'unknown', 'display_name', 'Unknown', 'description', 'Possession status not yet determined'),
      jsonb_build_object('status', 'occupied_or_suspected', 'display_name', 'Occupied or Suspected Occupied', 'description', 'Property may be occupied; requires review before entry/disposal'),
      jsonb_build_object('status', 'vacancy_unverified', 'display_name', 'Vacancy Unverified', 'description', 'Believed vacant but not yet verified'),
      jsonb_build_object('status', 'vacancy_verified', 'display_name', 'Vacancy Verified', 'description', 'Confirmed vacant through reliable evidence'),
      jsonb_build_object('status', 'personal_property_present', 'display_name', 'Personal Property Present', 'description', 'Personal belongings, vehicles, animals, or structures on property'),
      jsonb_build_object('status', 'removal_disposition_review', 'display_name', 'Removal / Disposition Review', 'description', 'Personal property requires legal/authority review before removal/disposal'),
      jsonb_build_object('status', 'removal_authorized', 'display_name', 'Removal Authorized', 'description', 'Authority obtained to remove/dispose of personal property'),
      jsonb_build_object('status', 'stored', 'display_name', 'Stored', 'description', 'Items stored pending return or disposal'),
      jsonb_build_object('status', 'transferred', 'display_name', 'Transferred', 'description', 'Items transferred to claimant or authorized party'),
      jsonb_build_object('status', 'disposed', 'display_name', 'Disposed', 'description', 'Items disposed of per authorized authority'),
      jsonb_build_object('status', 'cleared', 'display_name', 'Cleared', 'description', 'Property is vacant and clear; no personal property or occupancy concerns')
    )
  );

  -- =====================================================================
  -- Task Queues (spec §8.1)
  -- =====================================================================

  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'task_queues',
    jsonb_build_array(
      jsonb_build_object('queue', 'new_unreviewed', 'display_name', 'New / Unreviewed Issues', 'description', 'Newly created issues awaiting initial review'),
      jsonb_build_object('queue', 'action_dates', 'display_name', 'Action Dates Due', 'description', 'Customer/vendor promised dates arriving; follow-up tasks due'),
      jsonb_build_object('queue', 'notices_due', 'display_name', 'Notices / Letters Due', 'description', 'Covenant notices and legal notices due to send or have been sent'),
      jsonb_build_object('queue', 'upcoming', 'display_name', 'Upcoming Deadlines', 'description', 'Tasks/deadlines due within the next week'),
      jsonb_build_object('queue', 'overdue', 'display_name', 'Overdue Tasks', 'description', 'Tasks past their due date; escalation flags'),
      jsonb_build_object('queue', 'waiting_blocked', 'display_name', 'Waiting / Blocked', 'description', 'Issues awaiting external action or blocked by holds'),
      jsonb_build_object('queue', 'approvals', 'display_name', 'Approvals', 'description', 'Pending approval requests (threshold, release, exception)')
    )
  );

  -- =====================================================================
  -- Cost Classifications (from cost_entries table)
  -- =====================================================================

  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'cost_classifications',
    jsonb_build_object(
      'estimated', jsonb_build_object('display_name', 'Estimated', 'description', 'Initial cost estimate before bids'),
      'bid', jsonb_build_object('display_name', 'Bid', 'description', 'Vendor bid (may be incomplete)'),
      'committed', jsonb_build_object('display_name', 'Committed', 'description', 'Vendor selected; bid amount committed'),
      'approved', jsonb_build_object('display_name', 'Approved', 'description', 'Approved for contract/payment by authority'),
      'invoiced', jsonb_build_object('display_name', 'Invoiced', 'description', 'Invoice received from vendor'),
      'paid', jsonb_build_object('display_name', 'Paid', 'description', 'Payment completed'),
      'additional_outside_contract', jsonb_build_object('display_name', 'Additional / Outside Contract', 'description', 'Rare extra costs outside original scope (spec §6.3)'),
      'disputed', jsonb_build_object('display_name', 'Disputed', 'description', 'Cost amount or validity disputed'),
      'recoverable', jsonb_build_object('display_name', 'Recoverable', 'description', 'Marked for recovery from customer/party (does not auto-post a charge per spec §29.7)'),
      'customer_chargeable', jsonb_build_object('display_name', 'Customer Chargeable', 'description', 'Flagged as customer-chargeable (does not auto-post a charge per spec §29.7)'),
      'waived', jsonb_build_object('display_name', 'Waived', 'description', 'Cost waived by authorized approval'),
      'written_off', jsonb_build_object('display_name', 'Written Off', 'description', 'Cost written off (not recovered)')
    )
  );

  -- =====================================================================
  -- Roles (spec §12, DESIGN.md §7)
  -- =====================================================================

  insert into config_entries (config_version_id, entry_key, entry_value)
  values (
    v_config_version_id,
    'roles',
    jsonb_build_array(
      jsonb_build_object('role', 'employee', 'display_name', 'Employee', 'description', 'Broad internal view access; standard operations staff'),
      jsonb_build_object('role', 'coordinator', 'display_name', 'Coordinator', 'description', 'Issue coordinator; can edit cases and tasks'),
      jsonb_build_object('role', 'manager', 'display_name', 'Manager', 'description', 'Manager; approval authority and oversight'),
      jsonb_build_object('role', 'loan_services', 'display_name', 'Loan Services', 'description', 'Loan servicing staff; account and payment ownership'),
      jsonb_build_object('role', 'sales', 'display_name', 'Sales', 'description', 'Sales and First Dibs ownership'),
      jsonb_build_object('role', 'accounting', 'display_name', 'Accounting', 'description', 'Payment approval and check issuance'),
      jsonb_build_object('role', 'admin', 'display_name', 'Administrator', 'description', 'System configuration, user management, advanced overrides'),
      jsonb_build_object('role', 'service', 'display_name', 'Service Account', 'description', 'System-generated or integration service account (read-only or scoped actions)')
    )
  );

end $$;
