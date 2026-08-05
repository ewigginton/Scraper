'use client';

// Tiny client island: toggles the `.n-sidebar-collapsed` class on the shell
// wrapper. Kept separate from Sidebar.tsx (a server component) so the rest
// of the shell stays server-rendered.

import { SidebarCollapseIcon } from './icons.tsx';

export function SidebarCollapseToggle() {
  function toggle() {
    document.querySelector('.n-shell')?.classList.toggle('n-sidebar-collapsed');
  }

  return (
    <button
      type="button"
      className="n-sidebar-collapse-btn"
      onClick={toggle}
      aria-label="Collapse sidebar"
      title="Collapse sidebar"
    >
      <SidebarCollapseIcon size={16} />
    </button>
  );
}
