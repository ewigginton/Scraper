# Integration contract (draft): Google Chat → case/person timelines

Status: DESIGN DRAFT for Scott's review (spec §22 requires a documented
integration contract; Master Vision D18 governs the event mechanism).
Nothing here runs until the Hub-integration phase with real credentials.

## Business purpose
Team discussion about a case (e.g. "accept Hilltop's bid on the Cedar Ridge
cleanup?") currently lives only in Google Chat and never reaches the case
record. This integration lands selected Chat conversations in the shared
`communication_events` table so they appear on case and person timelines
beside calls, texts, and emails — the internal decision trail preserved on
the record that legal disputes will eventually test (spec §1, §29.2).

## How it works (mechanics)

1. **Google side.** A Google Cloud project under CCL's Workspace with the
   Chat API + Workspace Events API enabled, and a Chat app installed by the
   Workspace admin. The app is added to the spaces CCL chooses to cover.
2. **Subscriptions.** For each covered space, a Workspace Events API
   subscription on `google.workspace.chat.message.v1.created` (+ updated/
   deleted), delivered to a Google Cloud **Pub/Sub topic**. Note: these
   subscriptions EXPIRE and must be renewed — the integration owns a
   renewal job, and a lapsed subscription must surface in the ops queue
   (spec §22: no silent data loss), with backfill-on-renew via
   `spaces.messages.list` for the gap window.
3. **Ingestion worker.** A queued, idempotent consumer (the Live-Chat
   integration-jobs pattern the Master Vision mandates) pulls Pub/Sub
   events and writes `communication_events` rows: channel='chat',
   provider='google_chat', provider ID = the message resource name
   (`spaces/*/messages/*` — this is the **idempotency key**; replays and
   Pub/Sub redeliveries cannot duplicate rows). Sender/recipients resolve
   to person_refs via the external-identity map (integration_identities);
   unknown senders get a person_ref with source provenance, never a
   guessed merge (Master Vision §30.5).
4. **Linking to cases** — the one hard product decision (see below). The
   chat→case link writes `communication_links` rows, which is all the
   existing timelines need; zero schema changes required.
5. **Failure behavior.** Dead-letter queue + ops-queue visibility per spec
   §22; scheduled reconciliation compares message counts per covered space
   vs ingested rows; out-of-order events handled by message resource
   version/time.

## The case-linking decision (TBD — Emma + Scott)

| Option | How | Tradeoff |
| --- | --- | --- |
| A. Per-case spaces | A Chat space (or thread) is mapped to a case in integration_identities; everything in it auto-links. | Zero friction once mapped; requires the team to actually discuss cases in their spaces. Recommended where a case is big enough to have its own thread/space. |
| B. Explicit attach (recommended default) | A message action / slash command in Chat — "attach this thread to case …" with a case picker. Only deliberately attached threads land on the record. | Deliberate audit trail, no noise, easiest to govern; small per-use friction. |
| C. Inference (rejected for Phase 1) | Match chats to cases by content/mentions. | Guessing on a legal-exposure record; against the spec's verified-fact posture. |

Recommendation: **B as the default, A available for dedicated spaces.** Both
can ship together; C is out.

## Governance and privacy (for Scott's sign-off)
- Only admin-chosen spaces are ever subscribed (allowlist in config, not
  code). DMs are out of scope in Phase 1.
- Ingested content is internal-classification by default; the existing
  timeline permission rules apply. A message attached to a case is visible
  to whoever can see that case's timeline — the attach action should warn
  accordingly.
- Retention/deletion: a message deleted in Chat tombstones (never hard-
  deletes) the ingested row, per the §29.2 evidence rules.
- OAuth scopes: minimum read scopes for spaces/messages via the Events
  subscription; the admin consents once at install. Exact scope list is
  finalized against Google's current documentation at build time.

## What CCL must provide at build time
Google Cloud project access · Workspace admin to install/consent the Chat
app · the initial space allowlist · Scott's sign-off on this contract and
the case-linking choice.

## Explicitly deferred
Sending messages FROM the Hub into Chat (tier-2 interactive app), DM
coverage, historical backfill of pre-integration chats (possible via
messages.list, sized at build time).
