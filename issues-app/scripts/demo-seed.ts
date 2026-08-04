/**
 * Demo-mode seeder: builds .demo-db/ (a persisted PGlite database) by
 * replaying every migration and then creating realistic FICTIONAL demo data
 * through the app's own service layer — so every row passes the same
 * validation, auditing, and workflow rules as production data.
 *
 * Run via `npm run demo` (scripts/demo.mjs invokes this with
 * node --experimental-strip-types). Dev/demo only — never part of the Hub
 * port (PORTING.md) and never pointed at a real database.
 *
 * Volume mode (default): ~300 issues across all types/states with realistic
 * dates, varied priorities, holds, and possession records. Deterministic
 * seeded PRNG for reproducibility.
 */

import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../lib/db/schema.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { applyHold } from '../lib/services/hold-service.ts';
import { recordPossession } from '../lib/services/possession-service.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO_DIR = join(ROOT, '.demo-db');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/**
 * Seeded PRNG (mulberry32 style) for deterministic pseudo-random generation.
 * Seed with a fixed value so reseeds are reproducible.
 */
class SeededRandom {
  private a: number;

  constructor(seed: number = 42) {
    this.a = seed;
  }

  next(): number {
    this.a |= 0;
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Return random integer in [0, max) */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** Return random element from array */
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Return random boolean with given probability (0 to 1) */
  bool(prob: number = 0.5): boolean {
    return this.next() < prob;
  }
}

async function main() {
  const startTime = Date.now();
  if (existsSync(DEMO_DIR)) rmSync(DEMO_DIR, { recursive: true });

  const client = new PGlite(DEMO_DIR);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  for (const f of files) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  const db = drizzle(client, { schema });
  const { eq } = await import('drizzle-orm');

  // --- Reference data (fictional) ---
  const mkProp = async (v: Partial<typeof schema.propertyRefs.$inferInsert>) =>
    (await db.insert(schema.propertyRefs).values({
      sourceSystem: 'demo',
      externalId: `demo-${Math.random().toString(36).slice(2, 8)}`,
      ...v,
    } as typeof schema.propertyRefs.$inferInsert).returning())[0];
  const mkPerson = async (v: Partial<typeof schema.personRefs.$inferInsert>) =>
    (await db.insert(schema.personRefs).values({
      sourceSystem: 'demo',
      kind: 'person',
      displayName: 'Unnamed',
      ...v,
    } as typeof schema.personRefs.$inferInsert).returning())[0];

  const cedarRidge = await mkProp({
    development: 'Cedar Ridge Ranch', tract: 'Tract 14', state: 'TX', county: 'Red River',
    displayName: 'Cedar Ridge Ranch — Tract 14 (Red River Co., TX)',
    mapLink: 'https://www.google.com/maps/d/edit?mid=demo-cedar-ridge-14',
    statusCached: 'Off Market',
  });
  const pineHollow = await mkProp({
    development: 'Pine Hollow', tract: 'Tract 3', state: 'OK', county: 'Pittsburg',
    displayName: 'Pine Hollow — Tract 3 (Pittsburg Co., OK)', statusCached: 'Available',
  });
  const kyBluff = await mkProp({
    development: 'Cumberland Bluffs', tract: 'Tract 22', state: 'KY', county: 'Wayne',
    displayName: 'Cumberland Bluffs — Tract 22 (Wayne Co., KY)', statusCached: 'Off Market',
  });
  const ozarkView = await mkProp({
    development: 'Ozark View', tract: 'Tract 8', state: 'MO', county: 'Shannon',
    displayName: 'Ozark View — Tract 8 (Shannon Co., MO)', statusCached: 'Sold — Foreclosure Page',
  });

  const dHarmon = await mkPerson({ displayName: 'Dale Harmon (demo)', contactSnapshot: { phone: '555-0142', email: 'dale.demo@example.com' } });
  const rVasquez = await mkPerson({ displayName: 'Rita Vasquez (demo)', contactSnapshot: { phone: '555-0177' } });
  const tCole = await mkPerson({ displayName: 'Tom Cole (demo, neighbor)', contactSnapshot: { phone: '555-0163' } });
  const bWhitfield = await mkPerson({ displayName: 'Brenda Whitfield (demo, buyer)', contactSnapshot: { email: 'brenda.demo@example.com' } });
  await mkPerson({ displayName: 'Hilltop Clearing LLC (demo vendor)', kind: 'org', contactSnapshot: { phone: '555-0190' } });

  // --- Case 1: default recovery, blocked by occupancy + cleanup hold ---
  const rec = await createIssue(db, {
    issueType: 'default_recovery',
    propertyRefId: cedarRidge.id,
    summary: 'Loan default — signed VS on file; trailer and debris on site, occupant status unconfirmed.',
    priority: 'high',
    people: [{ personRefId: dHarmon.id, role: 'former_owner' }],
    initialTask: { title: 'Recovery map review — confirm access + condition', dueDate: isoDate(5), queue: 'new_unreviewed' },
    mapLink: 'https://www.google.com/maps/d/edit?mid=demo-cedar-ridge-14',
  });
  // Backdate the intake task directly so the demo inbox shows an overdue row.
  // (createIssue rightly refuses past due dates at intake; this simulates a
  // case that has since aged.)
  await db.update(schema.tasks)
    .set({ dueDate: isoDate(-2) })
    .where(eq(schema.tasks.issueId, rec.issue.id));
  await recordPossession(db, { issueId: rec.issue.id, possessionStatus: 'occupied_or_suspected', actorRoles: ['coordinator'] });
  await applyHold(db, {
    propertyRefId: cedarRidge.id, issueId: rec.issue.id, holdType: 'cleanup',
    reason: 'Debris field + abandoned trailer; CCL cleanup required before relisting.',
    actorExternalId: 'demo-coordinator', actorRole: 'coordinator',
  });

  // --- Case 2: covenant violation, first notice window ---
  await createIssue(db, {
    issueType: 'covenant_violation',
    propertyRefId: pineHollow.id,
    summary: 'Neighbor reports accumulating scrap vehicles and an unpermitted structure on Tract 3.',
    priority: 'normal',
    people: [
      { personRefId: rVasquez.id, role: 'owner' },
      { personRefId: tCole.id, role: 'reporter' },
    ],
    initialTask: { title: 'Prepare first covenant notice (14-day cure)', dueDate: isoDate(3), queue: 'notices_due' },
  });

  // --- Case 3: market readiness, fresh intake ---
  await createIssue(db, {
    issueType: 'market_readiness',
    propertyRefId: kyBluff.id,
    summary: 'Returned inventory — needs condition review, updated map, and price review before relisting.',
    priority: 'low',
    noPeopleException: 'CCL-controlled property; no external parties involved yet.',
    initialTask: { title: 'Schedule condition review', dueDate: isoDate(10), queue: 'new_unreviewed' },
  });

  // --- Case 4: buyer cleanup after Foreclosure Page sale ---
  await createIssue(db, {
    issueType: 'buyer_cleanup',
    propertyRefId: ozarkView.id,
    summary: 'Sold on Foreclosure Page with 30-day buyer cleanup clause; deadline reminders scheduled.',
    priority: 'normal',
    people: [{ personRefId: bWhitfield.id, role: 'buyer' }],
    initialTask: { title: 'Midpoint check-in on buyer cleanup progress', dueDate: isoDate(12), queue: 'action_date_followups' },
  });

  console.log('Generating ~300 volume demo issues...');

  // --- Volume generation: ~300 issues ---
  const rng = new SeededRandom(42);

  // Properties: ~8 developments, ~40 tracts total
  const developments = [
    { name: 'Whispering Pines', tracts: 5, state: 'TX', county: 'Nacogdoches' },
    { name: 'Riverbend Estates', tracts: 6, state: 'TX', county: 'Trinity' },
    { name: 'Timber Ridge', tracts: 5, state: 'OK', county: 'Kiowa' },
    { name: 'Prairie Sunset', tracts: 4, state: 'OK', county: 'Beaver' },
    { name: 'Blue Ridge Territory', tracts: 5, state: 'KY', county: 'Pike' },
    { name: 'Appalachian View', tracts: 6, state: 'KY', county: 'Perry' },
    { name: 'Ozark Heritage', tracts: 5, state: 'MO', county: 'Oregon' },
    { name: 'Crossroads Ranch', tracts: 4, state: 'AR', county: 'Newton' },
  ];

  const volumeProps: typeof cedarRidge[] = [];
  for (const dev of developments) {
    for (let i = 1; i <= dev.tracts; i++) {
      const prop = await mkProp({
        development: dev.name,
        tract: `Tract ${i}`,
        state: dev.state,
        county: dev.county,
        displayName: `${dev.name} — Tract ${i} (${dev.county} Co., ${dev.state})`,
        statusCached: rng.pick(['Available', 'Off Market', 'Pending']),
      });
      volumeProps.push(prop);
    }
  }

  // People: ~40 persons with varied roles
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];
  const firstNames = ['James', 'Mary', 'Robert', 'Patricia', 'Michael', 'Jennifer', 'William', 'Linda', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Sarah', 'Karen', 'Lisa', 'Nancy'];

  const volumePeople: typeof dHarmon[] = [];
  for (let i = 0; i < 40; i++) {
    const firstName = firstNames[rng.int(firstNames.length)];
    const lastName = lastNames[rng.int(lastNames.length)];
    const person = await mkPerson({
      displayName: `${firstName} ${lastName} (demo)`,
      contactSnapshot: {
        email: rng.bool(0.6) ? `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com` : undefined,
        phone: rng.bool(0.7) ? `555-${String(1000 + rng.int(8999)).padStart(4, '0')}` : undefined,
      },
    });
    volumePeople.push(person);
  }

  // Issue types, priorities, queues
  const issueTypes: schema.IssueType[] = ['default_recovery', 'covenant_violation', 'market_readiness', 'property_legal', 'buyer_cleanup'];
  const priorities: schema.Priority[] = ['low', 'normal', 'high', 'urgent'];
  const queues = ['new_unreviewed', 'notices_due', 'action_date_followups', 'legal_review', 'title_review'];
  const roles: schema.IssuePersonRole[] = ['owner', 'buyer', 'former_owner', 'neighbor', 'reporter', 'vendor'];

  const holdTypes: schema.HoldType[] = ['cleanup', 'occupancy', 'legal'];
  const possessionStatuses: schema.PossessionStatus[] = ['occupied_or_suspected', 'vacancy_unverified', 'vacancy_verified', 'personal_property_present', 'cleared'];

  // Summary sentence templates
  const summaryParts = {
    recovery: [
      'Loan default received from Loan Services',
      'Property in default status with unclear title situation',
      'Recovery case with access restrictions reported',
      'Property recovery proceeding after foreclosure',
    ],
    covenant: [
      'Covenant violation: neighbor reports unauthorized structures',
      'Violation of restrictive covenants on property',
      'Non-compliance with community deed restrictions observed',
      'Covenant enforcement notice required',
    ],
    market: [
      'Property returned from market; needs condition assessment',
      'Requires updated listing materials and condition review',
      'Market-readiness review pending inspection',
      'Property condition and pricing review needed',
    ],
    legal: [
      'Title issue flagged for legal review',
      'Legal matter requiring attorney consultation',
      'Title defect or encumbrance discovered',
      'Property legal hold pending resolution',
    ],
    buyer: [
      'Buyer cleanup obligations tracking and follow-up',
      'Post-sale cleanup requirements need monitoring',
      'Buyer cleanup clause compliance review',
      'Cleanup deadline reminders and verification',
    ],
  };

  const issuesPerBatch = 10;
  let issueCount = 0;

  for (let batch = 0; batch < 30; batch++) {
    const issuePromises: Promise<void>[] = [];

    for (let i = 0; i < issuesPerBatch; i++) {
      issuePromises.push(
        (async () => {
          const issueType = rng.pick(issueTypes);
          const priority = rng.pick(priorities);
          const queue = rng.pick(queues);
          const prop = rng.pick(volumeProps);
          const daysFromNow = rng.int(66) - 20; // -20 to +45 days

          // Build summary from templates
          let summaryTemplate = '';
          if (issueType === 'default_recovery') summaryTemplate = rng.pick(summaryParts.recovery);
          else if (issueType === 'covenant_violation') summaryTemplate = rng.pick(summaryParts.covenant);
          else if (issueType === 'market_readiness') summaryTemplate = rng.pick(summaryParts.market);
          else if (issueType === 'property_legal') summaryTemplate = rng.pick(summaryParts.legal);
          else summaryTemplate = rng.pick(summaryParts.buyer);

          const people = rng.bool(0.75) ? [{ personRefId: rng.pick(volumePeople).id, role: rng.pick(roles) }] : [];
          const noPeopleException = people.length === 0 ? 'No contact information available at intake.' : undefined;

          const result = await createIssue(db, {
            issueType,
            propertyRefId: prop.id,
            summary: summaryTemplate,
            priority,
            queue,
            people,
            noPeopleException,
            initialTask: {
              title: 'Initial review and triage',
              dueDate: isoDate(Math.max(1, daysFromNow)), // createIssue enforces future dates
              queue,
            },
            actorExternalId: 'demo-seeder',
            actorRole: 'admin',
          });

          // Backdate a subset of tasks (simulating aged cases)
          if (daysFromNow < 0 && rng.bool(0.4)) {
            await db.update(schema.tasks)
              .set({ dueDate: isoDate(daysFromNow) })
              .where(eq(schema.tasks.issueId, result.issue.id));
          }

          // Apply a hold to ~15% of issues
          if (rng.bool(0.15)) {
            const holdType = rng.pick(holdTypes);
            const holdReasons: Record<schema.HoldType, string> = {
              cleanup: 'Property cleanup required before any operations can proceed.',
              occupancy: 'Possession status unverified; property may be occupied.',
              legal: 'Legal matter unresolved; title concerns block transition.',
              safety: 'Safety inspection required before access.',
              foreclosure: 'Foreclosure process ongoing.',
              title: 'Title insurance issue.',
              covenant: 'Covenant violation hold.',
              stop_work: 'Work stoppage in effect.',
              existing_contract_active: 'Existing contract active.',
              other: 'Administrative hold.',
            };

            await applyHold(db, {
              propertyRefId: prop.id,
              issueId: result.issue.id,
              holdType,
              reason: holdReasons[holdType],
              actorExternalId: 'demo-coordinator',
              actorRole: 'coordinator',
            });
          }

          // Record possession for a subset
          if (rng.bool(0.08)) {
            const status = rng.pick(possessionStatuses);
            await recordPossession(db, {
              issueId: result.issue.id,
              possessionStatus: status,
              actorRoles: ['coordinator'],
              actorExternalId: 'demo-observer',
            });
          }
        })(),
      );
    }

    await Promise.all(issuePromises);
    issueCount += issuesPerBatch;
    if (issueCount % 50 === 0) {
      console.log(`  Generated ${issueCount} issues...`);
    }
  }

  const elapsedMs = Date.now() - startTime;

  await client.close();
  console.log(`✓ Demo database ready at ${DEMO_DIR}`);
  console.log(`  Migrations: ${files.length}`);
  console.log(`  Fixture cases: 4 (handcrafted showcase)`);
  console.log(`  Volume issues: ${issueCount}`);
  console.log(`  Properties: ${volumeProps.length} (8 developments)`);
  console.log(`  People: ${volumePeople.length}`);
  console.log(`  Completed in ${(elapsedMs / 1000).toFixed(2)}s`);
}

main().catch((err) => {
  console.error('Demo seed failed:', err);
  process.exit(1);
});
