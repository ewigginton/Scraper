/**
 * Standalone demo-comms seeder: adds FICTIONAL communication_events +
 * communication_links to the ALREADY-SEEDED .demo-db/ PGlite database
 * (built by `npm run demo` / scripts/demo-seed.ts, which this script never
 * runs, edits, or imports — it only reads what's already there and inserts
 * on top). Run standalone: `node --experimental-strip-types
 * scripts/demo-seed-comms.ts`.
 *
 * Wave 2 roadmap: "Demo seed gains fictional communication_events
 * (calls/texts/emails per person) so timelines are visible at demo time."
 *
 * What it seeds, over the last 60 days, deterministically:
 *  (a) every person linked (issue_people) to at least one issue gets 3-10
 *      communications, inbound+outbound, across call/text/email/voicemail.
 *  (b) buyer_cleanup and default_recovery issues additionally get a
 *      vendor+owner message thread — vendor comms are linked directly to
 *      the issue (communication_links.issue_id) even when no issue_people
 *      'vendor' row exists for that case, so "vendor+owner threads on
 *      cleanup/default cases" doesn't require mutating issue_people (out
 *      of this script's scope — that table is owned by lib/services/
 *      issue-service.ts).
 *  (c) for people linked to 2+ issues, a fraction of their communications
 *      get an EXTRA communication_links row tagging a DIFFERENT one of
 *      their issues, producing genuine cross-matter examples for the
 *      §29.1 cross-matter-labeling UI to exercise.
 *
 * Deterministic seeded PRNG (mulberry32 pattern copied from
 * scripts/demo-seed.ts's SeededRandom — that file is out of scope to edit
 * per this wave's concurrency rules, so the class is duplicated here rather
 * than imported).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../lib/db/schema.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO_DIR = join(ROOT, '.demo-db');

/** Seeded PRNG (mulberry32 style) — copied verbatim from scripts/demo-seed.ts's SeededRandom for reproducibility; see that file's own doc comment for the algorithm's provenance. */
class SeededRandom {
  private a: number;

  constructor(seed: number = 4242) {
    this.a = seed;
  }

  next(): number {
    this.a |= 0;
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  pick<T>(arr: T[]): T {
    const item = arr[this.int(arr.length)];
    if (item === undefined) throw new Error('SeededRandom.pick: called on an empty array');
    return item;
  }

  bool(prob: number = 0.5): boolean {
    return this.next() < prob;
  }
}

const CHANNELS: schema.CommunicationChannel[] = ['call', 'text', 'email', 'voicemail'];
const DIRECTIONS: schema.CommunicationDirection[] = ['inbound', 'outbound'];

const SUMMARY_TEMPLATES: Record<schema.CommunicationChannel, string[]> = {
  call: [
    'Discussed current status and next steps.',
    'Left a message confirming the scheduled follow-up.',
    'Talked through outstanding paperwork requirements.',
    'Confirmed contact information and mailing address.',
    'Answered questions about the process and timeline.',
  ],
  text: [
    'Sent a reminder about the upcoming deadline.',
    'Confirmed receipt of the requested documents.',
    'Quick check-in on availability this week.',
    'Shared a link to the portal for document upload.',
  ],
  email: [
    'Sent a written summary of the current case status.',
    'Emailed the requested forms and instructions.',
    'Followed up in writing after the phone conversation.',
    'Sent the notice/letter as an attached PDF.',
  ],
  voicemail: [
    'Left a voicemail requesting a callback.',
    'Left a voicemail with a status update.',
    'Left a voicemail confirming the appointment window.',
  ],
  notice: [],
  other: [],
};

const VENDOR_THREAD_TEMPLATES = {
  toVendor: [
    'Requested a bid/estimate for the cleanup scope.',
    'Confirmed dispatch date and site access instructions.',
    'Asked for updated photos and completion status.',
    'Sent the signed work order.',
  ],
  fromVendor: [
    'Vendor confirmed availability for the requested window.',
    'Vendor sent updated photos and a cost estimate.',
    'Vendor reported the job complete, awaiting invoice.',
    'Vendor asked a clarifying question about site access.',
  ],
};

async function main() {
  if (!existsSync(DEMO_DIR)) {
    console.error(
      'demo-seed-comms: .demo-db was not found. Run `npm run demo` first (it builds the base demo database this script adds communications on top of), then re-run this script.',
    );
    process.exit(1);
  }

  const client = new PGlite(DEMO_DIR);
  const db = drizzle(client, { schema });
  const rng = new SeededRandom(4242);

  const issuePeopleRows = await db.select().from(schema.issuePeople);
  const personIds = [...new Set(issuePeopleRows.map((r) => r.personRefId))];
  if (personIds.length === 0) {
    console.error('demo-seed-comms: no issue_people rows found in .demo-db — nothing to seed communications for. Run `npm run demo` first.');
    await client.close();
    process.exit(1);
  }

  const issuesByPerson = new Map<string, string[]>();
  for (const row of issuePeopleRows) {
    const list = issuesByPerson.get(row.personRefId) ?? [];
    list.push(row.issueId);
    issuesByPerson.set(row.personRefId, list);
  }

  const allIssues = await db.select({ id: schema.issues.id, issueType: schema.issues.issueType }).from(schema.issues);
  const issueTypeById = new Map(allIssues.map((i) => [i.id, i.issueType]));

  // A fictional "vendor" person for cleanup/default threads that don't
  // already have an issue_people 'vendor' role — prefers the handcrafted
  // fixture vendor (demo-seed.ts's "Hilltop Clearing LLC (demo vendor)"),
  // falling back to any org-kind person_ref if that fixture isn't present.
  const [fixtureVendor] = await db.select().from(schema.personRefs).where(eq(schema.personRefs.kind, 'org')).limit(1);

  let eventCounter = 0;
  let linkCounter = 0;

  async function insertComm(opts: {
    channel: schema.CommunicationChannel;
    direction: schema.CommunicationDirection;
    personId: string;
    occurredAt: Date;
    summary: string;
    linkIssueIds: string[];
    linkPersonId?: string;
  }): Promise<void> {
    eventCounter += 1;
    const [event] = await db
      .insert(schema.communicationEvents)
      .values({
        channel: opts.channel,
        direction: opts.direction,
        providerSystem: 'demo-seed-comms',
        providerEventId: `demo-comm-${eventCounter}`,
        occurredAt: opts.occurredAt,
        fromPersonRefId: opts.direction === 'inbound' ? opts.personId : null,
        toPersonRefId: opts.direction === 'outbound' ? opts.personId : null,
        summary: opts.summary,
      })
      .returning();
    if (!event) throw new Error('demo-seed-comms: communication_events insert returned no row');

    const linkRows: schema.NewCommunicationLink[] = [];
    // Always link to the person (so it folds in via includeLinkedPeople).
    linkRows.push({ communicationEventId: event.id, personRefId: opts.linkPersonId ?? opts.personId });
    for (const issueId of opts.linkIssueIds) {
      linkRows.push({ communicationEventId: event.id, issueId, personRefId: null });
    }
    for (const link of linkRows) {
      linkCounter += 1;
      await db.insert(schema.communicationLinks).values(link);
    }
  }

  function randomOccurredAt(): Date {
    const dayOffset = rng.int(60); // 0-59 days ago
    const hour = 7 + rng.int(12); // business hours, 7am-6pm
    const minute = rng.int(60);
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - dayOffset);
    d.setUTCHours(hour, minute, 0, 0);
    return d;
  }

  let personsSeeded = 0;
  let commsInserted = 0;

  for (const personId of personIds) {
    const linkedIssueIds = issuesByPerson.get(personId) ?? [];
    if (linkedIssueIds.length === 0) continue;
    const primaryIssueId = rng.pick(linkedIssueIds);
    const otherIssueIds = linkedIssueIds.filter((id) => id !== primaryIssueId);

    const commCount = 3 + rng.int(8); // 3-10 inclusive
    for (let i = 0; i < commCount; i++) {
      const channel = rng.pick(CHANNELS);
      const direction = rng.pick(DIRECTIONS);
      const templates = SUMMARY_TEMPLATES[channel];
      const summary = templates.length > 0 ? rng.pick(templates) : 'Communication logged.';

      // (c) cross-matter: ~20% of comms for a multi-issue person also tag
      // one of their OTHER issues directly, so it surfaces as cross-matter
      // context when viewing THIS comm's primary issue's timeline.
      const linkIssueIds: string[] = [];
      if (otherIssueIds.length > 0 && rng.bool(0.2)) {
        linkIssueIds.push(rng.pick(otherIssueIds));
      }

      await insertComm({ channel, direction, personId, occurredAt: randomOccurredAt(), summary, linkIssueIds });
      commsInserted += 1;
    }
    personsSeeded += 1;
  }

  // (b) vendor+owner threads on every buyer_cleanup / default_recovery issue.
  let vendorThreadsSeeded = 0;
  if (fixtureVendor) {
    for (const issue of allIssues) {
      if (issue.issueType !== 'buyer_cleanup' && issue.issueType !== 'default_recovery') continue;
      const threadLength = 3 + rng.int(4); // 3-6
      for (let i = 0; i < threadLength; i++) {
        const direction: schema.CommunicationDirection = rng.bool(0.5) ? 'outbound' : 'inbound';
        const summary = direction === 'outbound' ? rng.pick(VENDOR_THREAD_TEMPLATES.toVendor) : rng.pick(VENDOR_THREAD_TEMPLATES.fromVendor);
        await insertComm({
          channel: rng.bool(0.6) ? 'email' : 'text',
          direction,
          personId: fixtureVendor.id,
          occurredAt: randomOccurredAt(),
          summary,
          // Direct-to-issue link (not via issue_people, which this script
          // never writes to) — still surfaces on that issue's timeline with
          // linkage 'direct'.
          linkIssueIds: [issue.id],
        });
        commsInserted += 1;
      }
      vendorThreadsSeeded += 1;
    }
  }

  await client.close();
  console.log('demo-seed-comms: done.');
  console.log(`  People with communications: ${personsSeeded}`);
  console.log(`  Vendor/cleanup threads: ${vendorThreadsSeeded}`);
  console.log(`  communication_events inserted: ${commsInserted} (${eventCounter} total incl. any pre-existing counter state)`);
  console.log(`  communication_links inserted: ${linkCounter}`);
}

main().catch((err) => {
  console.error('demo-seed-comms failed:', err);
  process.exit(1);
});
