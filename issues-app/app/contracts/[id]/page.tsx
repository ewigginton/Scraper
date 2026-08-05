/**
 * app/contracts/[id]/page.tsx — stub in-ecosystem contract record (Wave 2b
 * roadmap: "Case left-panel contract/transaction overview + CRM links").
 * contract_refs is a read-model cache (spec §30.2) — the Hub's
 * Sales/Transactions module owns the real Contract record, so this page
 * shows only the cached snapshot plus a pointer to where the full record
 * actually lives, same stand-in role /people/[id] plays for CRM today.
 */

import { getCurrentUser } from '../../../lib/auth/current-user.ts';
import { tryGetDb } from '../../_lib/db.ts';
import { withActor } from '../../../lib/db/actor-context.ts';
import { formatDate, formatDateTime } from '../../_lib/dates.ts';
import { humanize } from '../../_lib/pills.ts';
import { propertyLabel } from '../../_lib/reference-data.ts';
import { Pill } from '../../_components/Pill.tsx';
import { DatabaseUnavailable } from '../../_components/EmptyState.tsx';
import * as contractRefsRepo from '../../../lib/repositories/contract-refs-repo.ts';
import { propertyRefs, personRefs, type PropertyRef, type PersonRef } from '../../../lib/db/schema.ts';
import { eq } from 'drizzle-orm';

export const metadata = { title: 'Contract — CCL Hub Issues' };

interface PageProps {
  params: Promise<{ id: string }>;
}

function keyDateEntries(keyDates: unknown): Array<[string, string]> {
  if (typeof keyDates !== 'object' || keyDates === null || Array.isArray(keyDates)) return [];
  return Object.entries(keyDates as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
}

export default async function ContractPage({ params }: PageProps) {
  const { id } = await params;
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>Contract</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();
  const data = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const contract = await contractRefsRepo.getById(tx, id);
    if (!contract) return null;
    const [property] = await tx.select().from(propertyRefs).where(eq(propertyRefs.id, contract.propertyRefId)).limit(1);
    const buyer: PersonRef | undefined = contract.buyerPersonRefId
      ? (await tx.select().from(personRefs).where(eq(personRefs.id, contract.buyerPersonRefId)).limit(1))[0]
      : undefined;
    return { contract, property: property as PropertyRef | undefined, buyer };
  });

  if (!data) {
    return (
      <>
        <h1>Contract not found</h1>
        <p>No contract exists with id {id}.</p>
        <a className="n-btn" href="/">
          Back to My Work
        </a>
      </>
    );
  }

  const { contract, property, buyer } = data;
  const keyDates = keyDateEntries(contract.keyDates);

  return (
    <>
      <a className="n-btn n-btn-quiet" href="/issues" style={{ marginBottom: 'var(--space-md)' }}>
        &larr; Back to All Issues
      </a>

      <header className="n-card">
        <div className="flex justify-between items-center">
          <h1 className="n-page-title">{contract.contractNumber ?? 'Contract'}</h1>
          {contract.statusCached && <Pill color="blue">{humanize(contract.statusCached)}</Pill>}
        </div>
        <p className="banner-warning" role="note" style={{ marginBottom: 'var(--space-md)' }}>
          Full contract record lives in the Hub&apos;s Sales/Transactions module. This is a read-only snapshot (spec §30.2) —
          Property Operations is not the system of record for contract facts.
        </p>

        <dl className="n-properties">
          <div className="n-property-row">
            <span className="n-property-label">Contract number</span>
            <span className="n-property-value">{contract.contractNumber ?? '—'}</span>
          </div>
          <div className="n-property-row">
            <span className="n-property-label">Status</span>
            <span className="n-property-value">{contract.statusCached ? <Pill color="blue">{humanize(contract.statusCached)}</Pill> : '—'}</span>
          </div>
          <div className="n-property-row">
            <span className="n-property-label">Property</span>
            <span className="n-property-value">{propertyLabel(property)}</span>
          </div>
          <div className="n-property-row">
            <span className="n-property-label">Buyer</span>
            <span className="n-property-value">
              {buyer ? <a href={`/people/${buyer.id}`}>{buyer.displayName}</a> : '—'}
            </span>
          </div>
          <div className="n-property-row">
            <span className="n-property-label">Executed date</span>
            <span className="n-property-value">{formatDate(contract.executedDate)}</span>
          </div>
          <div className="n-property-row">
            <span className="n-property-label">Key dates</span>
            <span className="n-property-value">
              {keyDates.length === 0 ? '—' : keyDates.map(([k, v]) => `${humanize(k)}: ${v}`).join(' · ')}
            </span>
          </div>
          <div className="n-property-row">
            <span className="n-property-label">Last synced</span>
            <span className="n-property-value">{contract.lastSyncedAt ? formatDateTime(contract.lastSyncedAt) : 'Never'}</span>
          </div>
        </dl>
      </header>
    </>
  );
}
