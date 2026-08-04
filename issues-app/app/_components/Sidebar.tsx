import {
  InboxIcon,
  TableIcon,
  PlusIcon,
  type IconProps,
} from './icons.tsx';
import { SidebarCollapseToggle } from './SidebarCollapseToggle.tsx';
import { tryGetDb } from '../_lib/db.ts';
import { queryStringFromParamsObject } from '../_lib/issues-view.ts';
import { getCurrentUser } from '../../lib/auth/current-user.ts';
import { withActor } from '../../lib/db/actor-context.ts';
import * as savedViewService from '../../lib/services/saved-view-service.ts';
import { deleteIssuesViewAction } from '../actions.ts';
import type { SavedView } from '../../lib/db/schema.ts';

// Server component: static nav shell per docs/notion-redesign.md "Look and
// feel", now also the owner's saved /issues views (spec §15: "list of the
// owner's saved views in the sidebar under All Issues"). Async — Next.js's
// App Router renders async Server Components directly, no wrapper needed.

interface IssueTypeLink {
  label: string;
  issueType: string;
  icon: (props: IconProps) => React.ReactElement;
}

const ISSUE_TYPE_LINKS: IssueTypeLink[] = [
  { label: 'Default Recovery', issueType: 'default_recovery', icon: TableIcon },
  { label: 'Covenant', issueType: 'covenant_violation', icon: TableIcon },
  { label: 'Market Readiness', issueType: 'market_readiness', icon: TableIcon },
  { label: 'Buyer Cleanup', issueType: 'buyer_cleanup', icon: TableIcon },
  { label: 'Legal', issueType: 'property_legal', icon: TableIcon },
];

/**
 * Saved views need a real DB read (owner-scoped, RLS-governed), unlike the
 * rest of this static shell. A missing DATABASE_URL or an auth-stub refusal
 * (lib/auth/current-user.ts, production with no explicit demo opt-in) must
 * not take down every page's sidebar — this degrades to "no saved views"
 * rather than throwing, matching this task's "demo-mode friendly" /
 * "invalid params fall back to defaults silently" requirement extended to
 * "shell chrome never 500s the whole app".
 */
async function loadSavedViews(): Promise<SavedView[]> {
  const db = tryGetDb();
  if (!db) return [];
  try {
    const user = await getCurrentUser();
    return await withActor(db, { actorId: user.id, roles: user.roles }, (tx) => savedViewService.listSavedViews(tx, user.id));
  } catch {
    return [];
  }
}

export async function Sidebar() {
  const savedViews = await loadSavedViews();

  return (
    <nav className="n-sidebar" aria-label="Primary">
      <div className="n-sidebar-header">
        <span className="n-sidebar-title">CCL Hub — Issues</span>
        <SidebarCollapseToggle />
      </div>

      <div className="n-nav-group">
        <a href="/" className="n-nav-item">
          <span className="n-nav-icon">
            <InboxIcon size={16} />
          </span>
          <span className="n-nav-label">My Work</span>
        </a>
        <a href="/issues" className="n-nav-item">
          <span className="n-nav-icon">
            <TableIcon size={16} />
          </span>
          <span className="n-nav-label">All Issues</span>
        </a>
      </div>

      <div className="n-nav-group">
        <span className="n-nav-group-label">Saved Views</span>
        {savedViews.length === 0 ? (
          <span className="n-nav-item n-nav-empty muted">No saved views yet</span>
        ) : (
          savedViews.map((view) => (
            <div key={view.id} className="n-saved-view-row">
              <a href={`/issues?${queryStringFromParamsObject(view.params)}`} className="n-nav-item" title={view.name}>
                <span className="n-nav-label">{view.name}</span>
              </a>
              <form action={deleteIssuesViewAction} className="n-saved-view-form">
                <input type="hidden" name="id" value={view.id} />
                <input type="hidden" name="returnTo" value="/issues" />
                <button type="submit" className="n-saved-view-delete" aria-label={`Delete saved view "${view.name}"`} title="Delete saved view">
                  ×
                </button>
              </form>
            </div>
          ))
        )}
      </div>

      <div className="n-nav-group">
        <span className="n-nav-group-label">Issue Types</span>
        {ISSUE_TYPE_LINKS.map(({ label, issueType, icon: Icon }) => (
          <a key={issueType} href={`/issues?type=${issueType}`} className="n-nav-item">
            <span className="n-nav-icon">
              <Icon size={16} />
            </span>
            <span className="n-nav-label">{label}</span>
          </a>
        ))}
      </div>

      <div className="n-nav-group">
        <a href="/issues/new" className="n-nav-item">
          <span className="n-nav-icon">
            <PlusIcon size={16} />
          </span>
          <span className="n-nav-label">New Issue</span>
        </a>
      </div>
    </nav>
  );
}
