import {
  InboxIcon,
  TableIcon,
  PlusIcon,
  type IconProps,
} from './icons.tsx';
import { SidebarCollapseToggle } from './SidebarCollapseToggle.tsx';

// Server component: static nav shell per docs/notion-redesign.md "Look and
// feel". /issues may 404 until the screens lane lands (spec §15/§25) — we
// still link to it per the spec's URL contract.

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

export function Sidebar() {
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
