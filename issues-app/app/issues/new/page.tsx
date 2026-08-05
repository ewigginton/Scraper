import { tryGetDb } from '../../_lib/db.ts';
import { listIssueTypes, listPeople, listProperties, propertyLabel } from '../../_lib/reference-data.ts';
import { addDaysIso, todayIso } from '../../_lib/dates.ts';
import { DatabaseUnavailable } from '../../_components/EmptyState.tsx';
import { createIssueAction } from '../../actions.ts';
import { getCurrentUser } from '../../../lib/auth/current-user.ts';
import { withActor } from '../../../lib/db/actor-context.ts';
import type { IssuePersonRole } from '../../../lib/db/schema.ts';

export const metadata = { title: 'New Issue — CCL Hub Issues' };

const PERSON_ROLES: IssuePersonRole[] = ['owner', 'buyer', 'former_owner', 'neighbor', 'reporter', 'vendor', 'attorney', 'other'];
const PERSON_ROW_COUNT = 4;

interface PageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function NewIssuePage({ searchParams }: PageProps) {
  const { error } = await searchParams;
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>New Issue</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  // ROUND-2 ADVERSARIAL-REVIEW FIX: this page used to read on the bare `db`
  // handle with no actor context at all (unlike app/page.tsx and
  // app/issues/[id]/page.tsx, which both already read through withActor) —
  // under a real RLS-governed connection every `*_select_broad_internal`
  // policy requires issues_current_actor() is not null, so all three lists
  // silently came back empty (intake looked like an empty database, not an
  // error) and — because listIssueTypes goes through configRepo.get, which
  // negative-caches a miss — a single anonymous GET here could poison the
  // shared config cache for every other request for CACHE_TTL_MS. See
  // config-repo.ts's `get`/`currentVersion` fix for the cache half of this.
  const user = await getCurrentUser();
  const [properties, people, issueTypes] = await withActor(db, { actorId: user.id, roles: user.roles }, (tx) =>
    Promise.all([listProperties(tx), listPeople(tx), listIssueTypes(tx)]),
  );
  const propertyOptions = properties.items;
  const personOptions = people.items;
  const minDueDate = addDaysIso(todayIso(), 1);

  return (
    <>
      <h1 className="n-page-title">New Issue</h1>
      <p className="n-page-subtitle">Required fields marked with *. See spec §5.2 for the full intake rule set.</p>

      {error && (
        <div className="n-card n-blocker-card" role="alert" style={{ marginBottom: 'var(--space-lg)' }}>
          <div className="n-blocker-reason">{error}</div>
        </div>
      )}

      <form action={createIssueAction} className="n-form">
        <div className="n-form-section">
          <div className="n-form-section-title">Property &amp; type</div>

          <div className="n-field">
            <label htmlFor="propertyRefId">Property *</label>
            <select id="propertyRefId" name="propertyRefId" className="n-select" required>
              <option value="">Select a property…</option>
              {propertyOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {propertyLabel(p)} {p.state ? `(${p.state})` : ''}
                </option>
              ))}
            </select>
            {propertyOptions.length === 0 && <p className="n-field-hint">No property_refs exist yet — add one before creating an issue.</p>}
            {properties.hasMore && (
              <p className="n-field-hint" role="note">
                Showing {propertyOptions.length} of {properties.total} properties — not all properties are listed; ask an admin to narrow this list if
                the one you need is missing.
              </p>
            )}
          </div>

          <div className="n-field">
            <label htmlFor="issueType">Issue type *</label>
            <select id="issueType" name="issueType" className="n-select" required>
              <option value="">Select an issue type…</option>
              {issueTypes.map(({ key, config }) => (
                <option key={key} value={key}>
                  {config.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="n-field">
            <label htmlFor="summary">Summary * (plain-language description; minimum 20 characters)</label>
            <textarea id="summary" name="summary" className="n-input" required minLength={20} rows={4} />
          </div>
        </div>

        <fieldset className="n-form-section">
          <legend className="n-form-section-title" style={{ padding: 0 }}>
            People *
          </legend>
          <p className="n-field-hint" style={{ marginBottom: 'var(--space-md)' }}>
            Link at least one owner, reporter, neighbor, vendor, or other contact.
          </p>
          {Array.from({ length: PERSON_ROW_COUNT }).map((_, i) => (
            <div key={i} className="flex gap-md person-row">
              <div style={{ flex: 2 }}>
                <label htmlFor={`personRefId_${i}`}>Person {i + 1}</label>
                <select id={`personRefId_${i}`} name={`personRefId_${i}`} className="n-select">
                  <option value="">— none —</option>
                  {personOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
                {i === 0 && people.hasMore && (
                  <p className="n-field-hint" role="note">
                    Showing {personOptions.length} of {people.total} people.
                  </p>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor={`personRole_${i}`}>Role</label>
                <select id={`personRole_${i}`} name={`personRole_${i}`} className="n-select" defaultValue="other">
                  {PERSON_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </fieldset>

        <div className="n-form-section">
          <div className="n-form-section-title">Priority &amp; map</div>

          <div className="n-field">
            <label htmlFor="priority">Priority *</label>
            <select id="priority" name="priority" className="n-select" defaultValue="normal" required>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div className="n-field">
            <label htmlFor="mapLink">Google My Maps link (required for Default / Property Recovery)</label>
            <input id="mapLink" name="mapLink" type="url" className="n-input" placeholder="https://www.google.com/maps/d/..." />
          </div>
        </div>

        <div className="n-form-section checkbox-group">
          <label htmlFor="offMarket" className="checkbox-label">
            <input id="offMarket" name="offMarket" type="checkbox" style={{ width: 'auto' }} />
            Place property Off Market / hold immediately
          </label>
          <div className="n-field">
            <label htmlFor="holdReason">Hold reason (required if checked above)</label>
            <input id="holdReason" name="holdReason" type="text" className="n-input" placeholder="e.g. legal referral pending" />
          </div>
        </div>

        <div className="n-form-section">
          <div className="n-form-section-title">Initial task</div>

          <div className="n-field">
            <label htmlFor="taskTitle">Initial task *</label>
            <input id="taskTitle" name="taskTitle" type="text" className="n-input" required defaultValue="Initial review" />
          </div>

          <div className="n-field">
            <label htmlFor="taskDueDate">Task due date * (must be in the future)</label>
            <input id="taskDueDate" name="taskDueDate" type="date" className="n-input" required min={minDueDate} defaultValue={minDueDate} />
          </div>
        </div>

        <button type="submit" className="n-btn n-btn-primary">
          Create issue
        </button>
      </form>
    </>
  );
}
