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
  if (existsSync(DEMO_DIR)) rmSync(DEMO_DIR, { recursive: true });

  const client = new PGlite(DEMO_DIR);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  for (const f of files) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  const db = drizzle(client, { schema });

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
  const { eq } = await import('drizzle-orm');
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

  await client.close();
  console.log(`Demo database ready at ${DEMO_DIR} (${files.length} migrations + fixture cases).`);
}

main().catch((err) => {
  console.error('Demo seed failed:', err);
  process.exit(1);
});
