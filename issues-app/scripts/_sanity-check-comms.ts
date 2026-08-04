import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../lib/db/schema.ts';
import * as commsRepo from '../lib/repositories/comms-repo.ts';
import * as timelineRepo from '../lib/repositories/timeline-repo.ts';
import * as auditMetricsRepo from '../lib/repositories/audit-metrics-repo.ts';

async function main() {
  const client = new PGlite('.demo-db');
  const db = drizzle(client, { schema });

  const [issuePersonRow] = await db.select().from(schema.issuePeople).limit(1);
  if (!issuePersonRow) throw new Error('no issue_people rows');
  console.log('sample issue_people row:', issuePersonRow.issueId, issuePersonRow.personRefId, issuePersonRow.role);

  const personComms = await commsRepo.listForPerson(db, { personRefId: issuePersonRow.personRefId, limit: 5 });
  console.log('listForPerson rows:', personComms.rows.length, 'nextCursor?', !!personComms.nextCursor);

  const issueComms = await commsRepo.listForIssue(db, { issueId: issuePersonRow.issueId, includeLinkedPeople: true, limit: 20 });
  console.log('listForIssue rows:', issueComms.rows.length, 'linkedPersonCount:', issueComms.linkedPersonCount);
  console.log('linkages:', issueComms.rows.map((r) => r.linkage));
  console.log('crossMatter any:', issueComms.rows.some((r) => r.crossMatter));

  const timeline = await timelineRepo.issueTimeline(db, { issueId: issuePersonRow.issueId, limit: 20 });
  console.log('issueTimeline entries:', timeline.entries.length);
  console.log('kinds present:', [...new Set(timeline.entries.map((e) => e.kind))]);

  const personTl = await timelineRepo.personTimeline(db, { personRefId: issuePersonRow.personRefId, limit: 20 });
  console.log('personTimeline entries:', personTl.entries.length);
  console.log('kinds present:', [...new Set(personTl.entries.map((e) => e.kind))]);

  const metrics = await auditMetricsRepo.activitiesByActor(db, {});
  console.log('activitiesByActor rows:', metrics.length, metrics.slice(0, 5));

  const recent = await auditMetricsRepo.recentActivity(db, { limit: 5 });
  console.log('recentActivity rows:', recent.rows.length, 'nextCursor?', !!recent.nextCursor);

  // find an issue with any crossMatter row across a broader sample
  const allIssuePeople = await db.select().from(schema.issuePeople).limit(50);
  let foundCrossMatter = false;
  for (const row of allIssuePeople) {
    const r = await commsRepo.listForIssue(db, { issueId: row.issueId, includeLinkedPeople: true, limit: 50 });
    const hit = r.rows.find((x) => x.crossMatter);
    if (hit) {
      console.log('crossMatter found on issue', row.issueId, '-> other issues', hit.crossMatterIssueIds, 'linkage', hit.linkage);
      foundCrossMatter = true;
      break;
    }
  }
  console.log('foundCrossMatter overall:', foundCrossMatter);

  // pagination sanity across all comms
  let cursor: string | null = null;
  let total = 0;
  let pages = 0;
  do {
    const page = await commsRepo.listForPerson(db, { personRefId: issuePersonRow.personRefId, limit: 2, cursor });
    total += page.rows.length;
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 20) throw new Error('pagination did not terminate');
  } while (cursor);
  console.log('paged listForPerson total rows across', pages, 'pages:', total);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
