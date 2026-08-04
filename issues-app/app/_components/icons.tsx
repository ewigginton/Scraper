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

// Properties-grid icons (case header, docs/notion-redesign.md "Case page
// header") — one per property row (Property, Type, Phase, Coordinator,
// Priority, Restrictions, Next task, Lifecycle).

export function PinIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 14.5s4.5-4.2 4.5-7.8a4.5 4.5 0 0 0-9 0c0 3.6 4.5 7.8 4.5 7.8z" />
      <circle cx="8" cy="6.7" r="1.6" />
    </IconBase>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8.5 2.5h4a1 1 0 0 1 1 1v4L6.2 14.8a1 1 0 0 1-1.4 0L2.2 12.2a1 1 0 0 1 0-1.4z" />
      <circle cx="10.6" cy="5.4" r="1" />
    </IconBase>
  );
}

export function FlowIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="3.5" cy="4" r="1.5" />
      <circle cx="12.5" cy="12" r="1.5" />
      <path d="M3.5 5.5v2A2.5 2.5 0 0 0 6 10h1" />
      <path d="M9.5 10h1a2.5 2.5 0 0 0 2-4" />
    </IconBase>
  );
}

export function PersonIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="5.2" r="2.4" />
      <path d="M2.8 13.5a5.2 5.2 0 0 1 10.4 0" />
    </IconBase>
  );
}

export function FlagIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 2.5v11" />
      <path d="M4 3h7.5l-2 2.7 2 2.8H4z" />
    </IconBase>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 2.2 13 4v4c0 3.6-2.4 5.9-5 6.8-2.6-.9-5-3.2-5-6.8V4z" />
    </IconBase>
  );
}

export function CheckSquareIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5 8.2 7.2 10.4 11.2 6" />
    </IconBase>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2.2 1.4" />
    </IconBase>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2 8.5h2.6l1.4-4 2 7 1.4-3h4.6" />
    </IconBase>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.3v3.4" />
      <circle cx="8" cy="11.6" r="0.15" fill="currentColor" />
    </IconBase>
  );
}
