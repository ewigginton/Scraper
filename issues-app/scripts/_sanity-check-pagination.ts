import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../lib/db/schema.ts';
import * as timelineRepo from '../lib/repositories/timeline-repo.ts';
import * as commsRepo from '../lib/repositories/comms-repo.ts';

async function main() {
  const client = new PGlite('.demo-db');
  const db = drizzle(client, { schema });

  // Find the issue with the most linked people / comms to stress pagination.
  const linkCounts = await db.select().from(schema.issuePeople);
  const byIssue = new Map<string, number>();
  for (const r of linkCounts) byIssue.set(r.issueId, (byIssue.get(r.issueId) ?? 0) + 1);
  const [busiestIssueId] = [...byIssue.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!busiestIssueId) throw new Error('no issues found');

  const full = await timelineRepo.issueTimeline(db, { issueId: busiestIssueId, limit: 500 });
  console.log('full (limit 500) entries:', full.entries.length, 'nextCursor?', !!full.nextCursor);

  let cursor: string | null = null;
  const paged: typeof full.entries = [];
  let pages = 0;
  do {
    const page = await timelineRepo.issueTimeline(db, { issueId: busiestIssueId, limit: 3, cursor });
    paged.push(...page.entries);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 200) throw new Error('did not terminate');
  } while (cursor);
  console.log('paged (limit 3) total entries:', paged.length, 'pages:', pages);

  const fullIds = full.entries.map((e) => `${e.sourceTable}:${e.sourceId}:${e.kind}:${e.at.toISOString()}`).sort();
  const pagedIds = paged.map((e) => `${e.sourceTable}:${e.sourceId}:${e.kind}:${e.at.toISOString()}`).sort();
  console.log('sets equal:', JSON.stringify(fullIds) === JSON.stringify(pagedIds));
  if (JSON.stringify(fullIds) !== JSON.stringify(pagedIds)) {
    console.log('full - paged diff:', fullIds.filter((x) => !pagedIds.includes(x)));
    console.log('paged - full diff:', pagedIds.filter((x) => !fullIds.includes(x)));
  }

  // Filters: kinds
  const onlyComms = await timelineRepo.issueTimeline(db, { issueId: busiestIssueId, filters: { kinds: ['communication'] }, limit: 500 });
  console.log('kinds=[communication] all communication?', onlyComms.entries.every((e) => e.kind === 'communication'), onlyComms.entries.length);

  const onlyAudit = await timelineRepo.issueTimeline(db, { issueId: busiestIssueId, filters: { kinds: ['audit'] }, limit: 500 });
  console.log('kinds=[audit] all audit?', onlyAudit.entries.every((e) => e.kind === 'audit'), onlyAudit.entries.length);

  // Malformed cursor / filters
  const badCursor = await timelineRepo.issueTimeline(db, { issueId: busiestIssueId, cursor: 'not-a-real-cursor!!', limit: 5 });
  console.log('malformed cursor -> falls back to page 1, entries:', badCursor.entries.length);

  const badFilters = await timelineRepo.issueTimeline(db, { issueId: busiestIssueId, filters: { kinds: ['nonsense'] as unknown as string[] }, limit: 5 });
  console.log('malformed kinds -> matches nothing, entries:', badFilters.entries.length);

  const badIssueId = await timelineRepo.issueTimeline(db, { issueId: 'not-a-uuid', limit: 5 });
  console.log('malformed issueId -> empty, entries:', badIssueId.entries.length);

  // comms-repo malformed cursor
  const [somePerson] = await db.select().from(schema.personRefs).limit(1);
  const badCommsCursor = await commsRepo.listForPerson(db, { personRefId: somePerson!.id, cursor: 'garbage', limit: 3 });
  console.log('comms malformed cursor -> falls back, rows:', badCommsCursor.rows.length);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
