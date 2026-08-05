---
name: check-pr-feedback
description: Check Emma's Gmail for GitHub PR feedback (approvals, merges, change requests, kick-backs, bounced replies) on shwig1/CCL and ewigginton/Scraper, act on what is actionable from this session, and report. Use when asked to check PR feedback/emails, or on the recurring 30-minute feedback check.
---

# Check PR feedback

## Steps

1. **Search Gmail** (mcp__Gmail__search_threads):
   `newer_than:1d from:notifications@github.com` and
   `newer_than:1d from:postmaster` (bounces). Read new/unread threads.
2. **Classify each thread** by repo and latest state:
   - approved / merged / changes-requested / automated kick-back
     (cclghcloud attestation sweep) / comment / CI failure / BOUNCED reply
     (postmaster undeliverable — the sender's reply never reached GitHub).
3. **Act, by repo:**
   - **ewigginton/Scraper** (this session has full access): CI failure or
     review comment on our PRs → drive-to-green: fix, commit, push, reply
     on the PR if resolution needs explaining. Approval/merge → note it.
   - **shwig1/CCL** (NO access from this session — cross-owner limit):
     draft the exact ready-to-paste response (attestation note, fix
     summary, or reply), and include per-item instructions: paste on the
     PR page directly or via the CCL-scoped session. NEVER advise replying
     to GitHub by email — Emma's Outlook replies have bounced before
     (mailbox-full postmaster errors); the attestation never lands.
4. **Special watch — attestation kick-backs:** Scott's queue requires a
   pre-submission Fable review rated 5/5 (or a rated waiver) in the PR
   body/comments. A kick-back or changes-requested citing this means the
   PR needs the attestation posted ON the thread.
5. **Report to Emma** only when something is new or actionable: one line
   per item, action taken or paste-ready text. If nothing new: stay
   silent (re-arm only).
6. **Re-arm the loop:** if running as the recurring check, schedule the
   next check ~30 minutes out via send_later with this same instruction
   (self-chaining; cron minimum is hourly, so the 30-minute cadence relies
   on this re-arm — never skip it).
