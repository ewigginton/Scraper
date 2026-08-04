// Small inline-SVG icon set for the Notion-style shell. No icon framework
// dependency — must stay portable into the Hub (docs/notion-redesign.md).
//
// Every icon is a plain function component taking `size` (px, default 16)
// and `className`. Stroke-based, currentColor, so callers control tint via
// CSS `color`.

export interface IconProps {
  size?: number;
  className?: string;
}

function IconBase({
  size = 16,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 8.5h3l1.2 2h2.6l1.2-2h3" />
      <path d="M3 3.5h10l1.5 5v4a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1v-4z" />
    </IconBase>
  );
}

export function TableIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.2" />
      <path d="M2 6.5h12" />
      <path d="M6.2 6.5v7" />
    </IconBase>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 3h11l-4 5.2v4.3l-3 1.5V8.2z" />
    </IconBase>
  );
}

export function SortIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4.5 12.5v-9" />
      <path d="M2.5 5.5l2-2 2 2" />
      <path d="M11.5 3.5v9" />
      <path d="M13.5 10.5l-2 2-2-2" />
    </IconBase>
  );
}

export function ColumnsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.2" />
      <path d="M6.3 2.5v11" />
      <path d="M9.7 2.5v11" />
    </IconBase>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M13.5 13.5l-3-3" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 2.5v11" />
      <path d="M2.5 8h11" />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 3.5l5 4.5-5 4.5" />
    </IconBase>
  );
}

export function DotIcon({ size = 6, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 6 6"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="3" cy="3" r="3" fill="currentColor" />
    </svg>
  );
}

export function SidebarCollapseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.2" />
      <path d="M6.3 2.5v11" />
      <path d="M4.6 6.2L3 8l1.6 1.8" />
    </IconBase>
  );
}
